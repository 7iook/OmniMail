import type { Env } from '../../app/types'
import { microsoftMailEnabled } from './microsoft-credentials'
import {
  generateMicrosoftGraphClientState,
  hashMicrosoftGraphClientState,
  microsoftGraphSubscriptionRuntime,
  MICROSOFT_GRAPH_LIFECYCLE_PATH,
  MICROSOFT_GRAPH_NOTIFICATION_PATH,
  type MicrosoftGraphSubscriptionRuntime,
} from './microsoft-graph-notifications'
import {
  chargedCall,
  createReconcileBudget,
  isBudgetExhausted,
  type ReconcileBudget,
  rethrowIfBudgetExhausted,
} from './microsoft-graph-reconcile-budget'
import { markFolderStaleAfterAmbiguousCreate, touchAccountReconciled } from './microsoft-graph-reconcile-fairness'
import { microsoftAccountForSync } from './microsoft-store'
import { microsoftAccessToken } from './microsoft-token-manager'
import {
  MICROSOFT_GRAPH_SUBSCRIBED_FOLDERS,
  type MicrosoftGraphRemoteSubscription,
  type MicrosoftGraphSubscription,
  type MicrosoftGraphSubscriptionClient,
  type MicrosoftGraphSubscriptionRepository,
} from './microsoft-types'

/**
 * Cron reconciliation for Graph change-notification subscriptions (card §12.3
 * link A, C-2, C-5). Owns the second cron-driven code path in this Worker that
 * makes real outbound HTTP calls (the first being sync itself): every actual
 * call (token acquisition, `list`, `create`, `renew`, `remove`) is charged
 * against a shared {@link ReconcileBudget} (see `microsoft-graph-reconcile-
 * budget.ts`) so a slow tenant or a large batch cannot starve the rest of
 * `cleanup()` or blow past the Worker's own subrequest entitlement.
 */

const RECONCILE_BATCH = 10
/** Stay under Graph's 10,080-minute (7-day) cap for an Outlook resource with margin. */
const SUBSCRIPTION_LIFETIME_SECONDS = 7 * 24 * 60 * 60 - 60 * 60
const RENEW_WITHIN_SECONDS = 24 * 60 * 60
const REJECTED_RETRY_SECONDS = 24 * 60 * 60
/** C-5's capped exponential backoff for transient subscription-API failures. */
const TRANSIENT_BACKOFF_SECONDS = [5 * 60, 15 * 60, 60 * 60, 6 * 60 * 60]

function transientBackoff(failureCount: number): number {
  const index = Math.min(Math.max(failureCount, 0), TRANSIENT_BACKOFF_SECONDS.length - 1)
  return TRANSIENT_BACKOFF_SECONDS[index]
}

/**
 * Whether a subscription-API failure is a permanent refusal (403 / other 4xx
 * that isn't 429) rather than a transient one (5xx / timeout / 429).
 *
 * This is deliberately independent of {@link microsoftTransportFailure}'s
 * cascade classification (card recon §6): a tenant that forbids webhooks says
 * nothing about whether the mailbox's own reads still work over Graph, so a
 * subscription rejection must never flip `preferred_transport`.
 */
function isPermanentSubscriptionRejection(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 429
}

function subscriptionErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && code ? code : 'graph_subscription_failed'
}

function wellKnownFolderFor(folderPath: string): string {
  return MICROSOFT_GRAPH_SUBSCRIBED_FOLDERS.find((entry) => entry.folderPath === folderPath)
    ?.wellKnownName ?? folderPath
}

function notificationUrl(baseUrl: string): string {
  return `${baseUrl}${MICROSOFT_GRAPH_NOTIFICATION_PATH}`
}

function lifecycleUrl(baseUrl: string): string {
  return `${baseUrl}${MICROSOFT_GRAPH_LIFECYCLE_PATH}`
}

/** One account's Graph subscription client, bound to that account's own access token. */
async function graphClientForAccount(
  env: Env,
  runtime: MicrosoftGraphSubscriptionRuntime,
  accountId: string,
  budget: ReconcileBudget,
): Promise<MicrosoftGraphSubscriptionClient | null> {
  const account = await microsoftAccountForSync(env, accountId)
  if (!account) return null
  const accessToken = await chargedCall(budget, () => microsoftAccessToken(env, account, { transport: 'graph' }))
  // Re-review 2 Important #2a: the same shared budget also charges every
  // real HTTP attempt this client makes (each retry, each `list()` page),
  // on top of the coarser per-operation charge each call site below already
  // takes via `chargedCall`.
  return runtime.clientFor(accessToken, budget)
}

async function recordSubscriptionFailure(
  repository: MicrosoftGraphSubscriptionRepository,
  row: MicrosoftGraphSubscription,
  error: unknown,
  now: number,
): Promise<void> {
  const lastErrorCode = subscriptionErrorCode(error)
  if (isPermanentSubscriptionRejection(error)) {
    await repository.update(row.id, {
      status: 'rejected',
      failureCount: row.failureCount + 1,
      nextAttemptAt: now + REJECTED_RETRY_SECONDS,
      lastErrorCode,
    }, now)
    return
  }
  await repository.update(row.id, {
    failureCount: row.failureCount + 1,
    nextAttemptAt: now + transientBackoff(row.failureCount),
    lastErrorCode,
  }, now)
}

/**
 * Renews a due row in place. Only ever called with a row that has a real
 * remote `subscriptionId` (0038: `renewOrRebuildDue` routes a null id to
 * {@link rebuildSubscription} instead) — a `rejected` row that still carries
 * one only ever lost it on an earlier failed *renewal*, never a failed
 * create, so retrying the same PATCH is how a tenant policy change is
 * noticed without a separate recovery path.
 */
async function renewOne(
  repository: MicrosoftGraphSubscriptionRepository,
  client: MicrosoftGraphSubscriptionClient,
  row: MicrosoftGraphSubscription,
  subscriptionId: string,
  now: number,
  budget: ReconcileBudget,
): Promise<void> {
  try {
    const remote = await chargedCall(budget, () => client.renew(subscriptionId, now + SUBSCRIPTION_LIFETIME_SECONDS))
    await repository.update(row.id, {
      expiresAt: remote.expiresAt,
      status: 'active',
      failureCount: 0,
      nextAttemptAt: remote.expiresAt - RENEW_WITHIN_SECONDS,
      lastErrorCode: '',
    }, now)
  } catch (error) {
    rethrowIfBudgetExhausted(error)
    await recordSubscriptionFailure(repository, row, error, now)
  }
}

/**
 * `stale` rows (lifecycle `subscriptionRemoved`/`reauthorizationRequired`) and
 * rows with no remote identity at all (0038: `subscription_id IS NULL` — a
 * create-time rejection, or one that never got as far as create) both need a
 * fresh `create()`. A null id is never sent to Graph as though it were real:
 * there is nothing to `remove()` for a row that never had one.
 */
async function rebuildSubscription(
  repository: MicrosoftGraphSubscriptionRepository,
  client: MicrosoftGraphSubscriptionClient,
  baseUrl: string,
  row: MicrosoftGraphSubscription,
  now: number,
  budget: ReconcileBudget,
): Promise<void> {
  const existingSubscriptionId = row.subscriptionId
  if (existingSubscriptionId !== null) {
    try {
      await chargedCall(budget, () => client.remove(existingSubscriptionId))
    } catch (error) {
      rethrowIfBudgetExhausted(error)
      // Best effort: the interface already treats 404 as success, and a stale
      // row's remote resource may genuinely already be gone (that is what made
      // it stale in the first place).
    }
  }
  try {
    const clientState = generateMicrosoftGraphClientState()
    const remote = await chargedCall(budget, () => client.create({
      wellKnownFolder: wellKnownFolderFor(row.folderPath),
      notificationUrl: notificationUrl(baseUrl),
      lifecycleNotificationUrl: lifecycleUrl(baseUrl),
      clientState,
      expiresAt: now + SUBSCRIPTION_LIFETIME_SECONDS,
    }))
    await repository.update(row.id, {
      subscriptionId: remote.subscriptionId,
      clientStateHash: await hashMicrosoftGraphClientState(clientState),
      expiresAt: remote.expiresAt,
      status: 'active',
      failureCount: 0,
      nextAttemptAt: remote.expiresAt - RENEW_WITHIN_SECONDS,
      lastErrorCode: '',
    }, now)
  } catch (error) {
    rethrowIfBudgetExhausted(error)
    await recordSubscriptionFailure(repository, row, error, now)
  }
}

/** C-5 due scan: `next_attempt_at <= now`, oldest first, `LIMIT 10`. */
async function renewOrRebuildDue(
  env: Env,
  repository: MicrosoftGraphSubscriptionRepository,
  runtime: MicrosoftGraphSubscriptionRuntime,
  baseUrl: string,
  now: number,
  budget: ReconcileBudget,
): Promise<void> {
  const due = await repository.due(now, RECONCILE_BATCH)
  for (const row of due) {
    if (!budget.hasCapacity()) break
    try {
      const client = await graphClientForAccount(env, runtime, row.accountId, budget)
      if (!client) {
        // Account is gone. The FK cascade should already have removed this row
        // too; if it ever races, drop it rather than retrying forever.
        await repository.remove(row.id)
        continue
      }
      const subscriptionId = row.subscriptionId
      if (row.status === 'stale' || subscriptionId === null) {
        await rebuildSubscription(repository, client, baseUrl, row, now, budget)
      } else {
        await renewOne(repository, client, row, subscriptionId, now, budget)
      }
    } catch (error) {
      if (isBudgetExhausted(error)) break
      // Each account isolated (matches every other provider's cron block,
      // recon §2): a token failure for one account must not stop the pass.
      console.error('Microsoft Graph subscription renewal failed for one account', {
        accountId: row.accountId,
        folderPath: row.folderPath,
        type: error instanceof Error ? error.name : typeof error,
      })
    }
  }
}

/**
 * C-2 two-way reconciliation for one account, run just before filling in that
 * account's missing folder subscriptions (bounding it to the same `LIMIT 10`
 * account set rather than a separate full-account scan, per recon §17's cron
 * budget concern).
 */
async function reconcileOrphans(
  repository: MicrosoftGraphSubscriptionRepository,
  client: MicrosoftGraphSubscriptionClient,
  baseUrl: string,
  accountId: string,
  budget: ReconcileBudget,
): Promise<void> {
  const remote = await chargedCall(budget, () => client.list())
  const ours = notificationUrl(baseUrl)
  const local = await repository.forAccount(accountId)
  const remoteIds = new Set(remote.map((item) => item.subscriptionId))
  for (const row of local) {
    // 0038: a null id never had a remote resource in the first place — it
    // would never appear in `remote` no matter how many passes go by, so this
    // branch would otherwise delete it (and thus its create-time 24h
    // backoff) on every single pass.
    if (row.subscriptionId === null) continue
    if (!remoteIds.has(row.subscriptionId)) {
      // Local row, no remote resource: delete it so the caller's subsequent
      // "create what's missing" step recreates it in this same pass (C-2).
      await repository.remove(row.id)
    }
  }
  const localSubscriptionIds = new Set(
    local.map((row) => row.subscriptionId).filter((id): id is string => id !== null),
  )
  for (const item of remote) {
    if (item.notificationUrl === ours && !localSubscriptionIds.has(item.subscriptionId)) {
      // Remote resource pointed at our endpoint, no local row: an orphan from
      // an interrupted create (card A3/C-2) — remove it remotely.
      try {
        await chargedCall(budget, () => client.remove(item.subscriptionId))
      } catch (error) {
        rethrowIfBudgetExhausted(error)
        console.warn('Unable to remove an orphaned Microsoft Graph subscription', {
          accountId,
          subscriptionId: item.subscriptionId,
          type: error instanceof Error ? error.name : typeof error,
        })
      }
    }
  }
}

async function createOne(
  repository: MicrosoftGraphSubscriptionRepository,
  client: MicrosoftGraphSubscriptionClient,
  baseUrl: string,
  accountId: string,
  folderPath: string,
  now: number,
  budget: ReconcileBudget,
): Promise<void> {
  const clientState = generateMicrosoftGraphClientState()
  try {
    const remote = await chargedCall(budget, () => client.create({
      wellKnownFolder: wellKnownFolderFor(folderPath),
      notificationUrl: notificationUrl(baseUrl),
      lifecycleNotificationUrl: lifecycleUrl(baseUrl),
      clientState,
      expiresAt: now + SUBSCRIPTION_LIFETIME_SECONDS,
    }))
    await repository.insert({
      id: `microsoft_graph_sub_${crypto.randomUUID().replaceAll('-', '')}`,
      accountId,
      folderPath,
      subscriptionId: remote.subscriptionId,
      clientStateHash: await hashMicrosoftGraphClientState(clientState),
      expiresAt: remote.expiresAt,
      status: 'active',
      failureCount: 0,
      nextAttemptAt: remote.expiresAt - RENEW_WITHIN_SECONDS,
      refreshState: 'idle',
      refreshPending: false,
      refreshStateAt: now,
      lastNotifiedAt: null,
      lastErrorCode: '',
    }, now)
  } catch (error) {
    rethrowIfBudgetExhausted(error)
    if (isPermanentSubscriptionRejection(error)) {
      // review3 Important #7 (C-5): a confirmed 403/4xx-non-429 at create
      // time is Microsoft telling us "no", not "maybe" like the ambiguous
      // case below — retrying every five minutes would just hammer the same
      // wall for 24h. Persist a `rejected` row now with `subscription_id =
      // NULL` (0038: never a sentinel string) so the C-5 due scan
      // (`renewOrRebuildDue`, which routes a null id to `rebuildSubscription`
      // instead of `renewOne`) is what retries it, once, no sooner than
      // `REJECTED_RETRY_SECONDS` from now. This also makes the account's
      // "present folders" set (in the caller) count this folder as accounted
      // for, so this same pass does not immediately retry it again.
      await repository.insert({
        id: `microsoft_graph_sub_${crypto.randomUUID().replaceAll('-', '')}`,
        accountId,
        folderPath,
        subscriptionId: null,
        clientStateHash: await hashMicrosoftGraphClientState(clientState),
        expiresAt: now,
        status: 'rejected',
        failureCount: 1,
        nextAttemptAt: now + REJECTED_RETRY_SECONDS,
        refreshState: 'idle',
        refreshPending: false,
        refreshStateAt: now,
        lastNotifiedAt: null,
        lastErrorCode: subscriptionErrorCode(error),
      }, now)
      return
    }
    // Creation failed ambiguously (network blip, 5xx, timeout — its result is
    // genuinely unknown, Microsoft may already have created it remotely).
    // card C-2's orphan check (`client.list()` in {@link reconcileOrphans})
    // is still what cleans up a remote-only leftover on the NEXT pass, since
    // this row carries no real id either way. But re-review 2 Important #2b:
    // leaving NO local row at all made the account permanently zero-row to
    // the fairness ordering above (`NULL` always sorts first), so a
    // persistently broken account would starve every account behind it
    // forever. A `stale`, null-id marker with C-5's own transient backoff
    // fixes both at once: the account is no longer zero-row, and the next
    // `due()` scan retries via `rebuildSubscription` on a real schedule
    // instead of this same create() being re-attempted on every single tick.
    console.error('Unable to create a Microsoft Graph subscription', {
      accountId,
      folderPath,
      type: error instanceof Error ? error.name : typeof error,
    })
    await markFolderStaleAfterAmbiguousCreate(
      repository, accountId, folderPath, await hashMicrosoftGraphClientState(clientState),
      subscriptionErrorCode(error), now + transientBackoff(0), now,
    )
  }
}

/**
 * C-2 two-way reconciliation, then C-5 create-what's-missing, for a bounded
 * set of Graph-preferred accounts.
 *
 * review3 Important #3 (re-review): account selection used to be a flat
 * `ORDER BY a.id LIMIT 10`, so accounts past the tenth by id never reached
 * this function at all once the first ten existed and stayed healthy —
 * `reconcileOrphans`'s own `list()` call never ran for them, no matter how
 * many cron ticks passed. Selection now orders by each account's own
 * least-recently-reconciled marker (`MIN` of its subscription rows'
 * `updated_at`, which {@link touchAccountReconciled} bumps after every
 * attempt below); SQLite sorts `NULL` first, so an account with zero rows
 * (never reconciled) always outranks one that has been. This is a rotation,
 * not a one-time queue: every Graph-preferred account surfaces within
 * `ceil(accountCount / RECONCILE_BATCH)` ticks even when there are dozens.
 */
async function reconcileAndCreateSubscriptions(
  env: Env,
  repository: MicrosoftGraphSubscriptionRepository,
  runtime: MicrosoftGraphSubscriptionRuntime,
  baseUrl: string,
  now: number,
  budget: ReconcileBudget,
): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT a.id FROM microsoft_imap_accounts a
      LEFT JOIN microsoft_graph_subscriptions s ON s.account_id = a.id
      WHERE a.preferred_transport = 'graph'
        AND a.status NOT IN ('credential_error', 'permission_error')
      GROUP BY a.id
      ORDER BY MIN(s.updated_at) ASC, a.id ASC
      LIMIT ?`,
  ).bind(RECONCILE_BATCH).all<{ id: string }>()
  for (const { id: accountId } of results) {
    if (!budget.hasCapacity()) break
    try {
      const client = await graphClientForAccount(env, runtime, accountId, budget)
      if (client) {
        await reconcileOrphans(repository, client, baseUrl, accountId, budget)
        const present = new Set((await repository.forAccount(accountId)).map((row) => row.folderPath))
        for (const spec of MICROSOFT_GRAPH_SUBSCRIBED_FOLDERS) {
          if (present.has(spec.folderPath)) continue
          await createOne(repository, client, baseUrl, accountId, spec.folderPath, now, budget)
        }
      }
      // Attempted (whether or not there was work to do): rotate this account
      // to the back of the fairness queue so the next tick looks at others.
      await touchAccountReconciled(env, accountId, now)
    } catch (error) {
      if (isBudgetExhausted(error)) {
        // A budget stop is a local scheduling fact, not a verdict about the
        // subscription, so it must never be written into subscription state
        // (no stale/rejected row, no Graph failure code). Rows this account
        // already has are rotated like a normal attempt; an account with no
        // rows is simply left where it is — the next tick starts with a fresh
        // budget and reaches it first, so it cannot starve.
        if ((await repository.forAccount(accountId)).length) {
          await touchAccountReconciled(env, accountId, now)
        }
        break
      }
      console.error('Unable to reconcile/create Microsoft Graph subscriptions for one account', {
        accountId,
        type: error instanceof Error ? error.name : typeof error,
      })
      // Still rotate: a broken account must not monopolise the front of the
      // queue and starve everyone else (this pass already isolated the
      // failure above; fairness is a separate concern from retryability).
      await touchAccountReconciled(env, accountId, now)
    }
  }
}

/**
 * Accounts whose sticky transport has flipped away from Graph but which still
 * carry subscription rows (recon §17 "subscription/account drift" risk: the
 * flip can happen silently during ordinary sync, with no single hook). This
 * scan is the self-healing pass: remote-remove (best effort) then delete the
 * local rows regardless of remote outcome, since Microsoft's own ≤7-day expiry
 * is the accepted backstop when no Graph token is obtainable any more (C-2).
 */
async function removeForNonGraphAccounts(
  env: Env,
  repository: MicrosoftGraphSubscriptionRepository,
  runtime: MicrosoftGraphSubscriptionRuntime,
  budget: ReconcileBudget,
): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT a.id FROM microsoft_imap_accounts a
       JOIN microsoft_graph_subscriptions s ON s.account_id = a.id
      WHERE a.preferred_transport != 'graph'
      ORDER BY a.id
      LIMIT ?`,
  ).bind(RECONCILE_BATCH).all<{ id: string }>()
  for (const { id: accountId } of results) {
    if (!budget.hasCapacity()) break
    try {
      const rows = await repository.forAccount(accountId)
      let client: MicrosoftGraphSubscriptionClient | null = null
      try {
        client = await graphClientForAccount(env, runtime, accountId, budget)
      } catch (error) {
        rethrowIfBudgetExhausted(error)
        console.warn('Unable to obtain a Graph token to remove stale subscriptions remotely', {
          accountId,
          type: error instanceof Error ? error.name : typeof error,
        })
      }
      for (const row of rows) {
        // 0038: nothing to DELETE for a row that never had a remote identity.
        const subscriptionId = row.subscriptionId
        if (client && subscriptionId !== null) {
          const activeClient = client
          try {
            await chargedCall(budget, () => activeClient.remove(subscriptionId))
          } catch (error) {
            rethrowIfBudgetExhausted(error)
            console.warn('Unable to remove a Microsoft Graph subscription remotely', {
              accountId,
              subscriptionId: row.subscriptionId,
              type: error instanceof Error ? error.name : typeof error,
            })
          }
        }
        await repository.remove(row.id)
      }
    } catch (error) {
      if (isBudgetExhausted(error)) break
      // review3 "Suspected/operational risk": a repository/D1 failure for
      // one account (e.g. `forAccount`/`remove` itself) must not abort this
      // phase for the rest — the Graph token/DELETE failures just above were
      // already isolated, but nothing previously caught a failure from the
      // repository calls themselves.
      console.error('Unable to remove Microsoft Graph subscriptions for one non-Graph account', {
        accountId,
        type: error instanceof Error ? error.name : typeof error,
      })
    }
  }
}

/**
 * Testable core, given an explicit runtime (card C-7's injection point).
 * `env.MICROSOFT_GRAPH_WEBHOOK_BASE_URL` unset is treated as "push disabled":
 * the caller ({@link reconcileDueMicrosoftGraphSubscriptions}) already logs
 * this once, so this function stays silent and simply does nothing.
 *
 * `nowMs` is the wall-clock source for the shared {@link ReconcileBudget}
 * (review3 "Suspected/operational risk") — separate from `now`, which stays
 * in epoch seconds for D1 timestamps. A test can inject a fake clock to
 * prove the deadline actually stops the pass without a real 20-second sleep.
 */
export async function reconcileMicrosoftGraphSubscriptions(
  env: Env,
  now: number,
  runtime: MicrosoftGraphSubscriptionRuntime,
  nowMs: () => number = () => Date.now(),
): Promise<void> {
  const baseUrl = env.MICROSOFT_GRAPH_WEBHOOK_BASE_URL
  if (!baseUrl) return
  const repository = runtime.repositoryFor(env)
  const budget = createReconcileBudget(nowMs)
  await renewOrRebuildDue(env, repository, runtime, baseUrl, now, budget)
  await reconcileAndCreateSubscriptions(env, repository, runtime, baseUrl, now, budget)
  await removeForNonGraphAccounts(env, repository, runtime, budget)
}

let loggedDisabledOnce = false

/**
 * The `cleanup.ts` cron entry point. Skips entirely (logging once, not once per
 * 5-minute tick) when push is unconfigured or Microsoft mail is disabled, and
 * again — separately — when P2-W2's runtime has not been wired in yet.
 */
export async function reconcileDueMicrosoftGraphSubscriptions(
  env: Env,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  if (!microsoftMailEnabled(env) || !env.MICROSOFT_GRAPH_WEBHOOK_BASE_URL) {
    if (!loggedDisabledOnce) {
      console.log('Microsoft Graph subscription reconciliation is disabled: '
        + 'no MICROSOFT_GRAPH_WEBHOOK_BASE_URL or Microsoft mail is off')
      loggedDisabledOnce = true
    }
    return
  }
  const runtime = microsoftGraphSubscriptionRuntime()
  if (!runtime) {
    if (!loggedDisabledOnce) {
      console.error('Microsoft Graph subscription runtime not configured; skipping reconciliation')
      loggedDisabledOnce = true
    }
    return
  }
  await reconcileMicrosoftGraphSubscriptions(env, now, runtime)
}
