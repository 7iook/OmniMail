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
 * makes real outbound HTTP calls (the first being sync itself): each step below
 * is bounded by {@link RECONCILE_BATCH}, well under `enqueueDueMicrosoftSyncs`'s
 * `SCHEDULE_BATCH=50`, since a subscription check costs a Graph round trip per
 * row rather than a D1 write (recon §2 risk).
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
 * Marks a `rejected` scheduling row created at *create* time (review3
 * Important #7, card C-5) — one for which no remote subscription was ever
 * obtained, as opposed to a row that once had a real one and lost it on
 * renewal. Never a shape Microsoft issues (its subscription ids are GUIDs
 * with no colon), so this sentinel can never collide with — or be mistaken
 * for — a real remote id by list-based reconciliation or an incoming
 * notification's lookup. The random suffix keeps it satisfying the column's
 * `UNIQUE` constraint without a schema change (see this package's report for
 * why a migration was not used instead).
 */
const PENDING_SUBSCRIPTION_PREFIX = 'pending:'

function isPendingSentinel(subscriptionId: string): boolean {
  return subscriptionId.startsWith(PENDING_SUBSCRIPTION_PREFIX)
}

/**
 * Suspected/operational risk (review3): this cron path makes real outbound
 * HTTP calls (token + list/create/renew/remove), unlike every other
 * `cleanup()` step. One budget, shared across all three passes below, caps
 * both wall-clock time and call volume so a slow tenant or a large batch
 * cannot starve the rest of `cleanup()`. `nowMs` is injectable so a test can
 * simulate elapsed time without a real 20-second sleep.
 */
export const RECONCILE_DEADLINE_MS = 20_000
export const RECONCILE_MAX_OUTBOUND_CALLS = 60

interface ReconcileBudget {
  /** True while another row/account's worth of outbound work may still start. */
  hasCapacity(): boolean
  /** Call once per row/account whose processing was started. */
  spend(): void
}

function createReconcileBudget(
  nowMs: () => number,
  deadlineMs = RECONCILE_DEADLINE_MS,
  maxCalls = RECONCILE_MAX_OUTBOUND_CALLS,
): ReconcileBudget {
  const deadline = nowMs() + deadlineMs
  let remaining = maxCalls
  return {
    hasCapacity: () => remaining > 0 && nowMs() < deadline,
    spend: () => { remaining -= 1 },
  }
}

/**
 * Whether a subscription-API failure is a permanent refusal (403 / other 4xx
 * that isn't 429) rather than a transient one (5xx / timeout / 429).
 *
 * This is deliberately independent of {@link microsoftTransportFailure}'s
 * cascade classification (card recon §6): a tenant that forbids webhooks says
 * nothing about whether the mailbox's own reads still work over Graph, so a
 * subscription rejection must never flip `preferred_transport`. P2-W2's client
 * has not landed yet, so this reads a plain `.status` field — the same shape
 * `MicrosoftGraphError` already uses — rather than a class `instanceof` check;
 * if W2's error shape differs, the coordinator should adjust this function.
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
): Promise<MicrosoftGraphSubscriptionClient | null> {
  const account = await microsoftAccountForSync(env, accountId)
  if (!account) return null
  const accessToken = await microsoftAccessToken(env, account, { transport: 'graph' })
  return runtime.clientFor(accessToken)
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
 * Renews a due row in place. Used for both `active` and `rejected` rows: a
 * `rejected` row still carries a real remote `subscriptionId` (creation only
 * ever reaches `repository.insert` after a successful `create()`, so rejection
 * can only have come from an earlier failed renewal) — retrying the same PATCH
 * is how a tenant policy change is noticed without a separate recovery path.
 */
async function renewOne(
  repository: MicrosoftGraphSubscriptionRepository,
  client: MicrosoftGraphSubscriptionClient,
  row: MicrosoftGraphSubscription,
  now: number,
): Promise<void> {
  try {
    const remote = await client.renew(row.subscriptionId, now + SUBSCRIPTION_LIFETIME_SECONDS)
    await repository.update(row.id, {
      expiresAt: remote.expiresAt,
      status: 'active',
      failureCount: 0,
      nextAttemptAt: remote.expiresAt - RENEW_WITHIN_SECONDS,
      lastErrorCode: '',
    }, now)
  } catch (error) {
    await recordSubscriptionFailure(repository, row, error, now)
  }
}

/** `stale` rows (lifecycle `subscriptionRemoved`/`reauthorizationRequired`): remove then recreate. */
async function rebuildSubscription(
  repository: MicrosoftGraphSubscriptionRepository,
  client: MicrosoftGraphSubscriptionClient,
  baseUrl: string,
  row: MicrosoftGraphSubscription,
  now: number,
): Promise<void> {
  try {
    await client.remove(row.subscriptionId)
  } catch {
    // Best effort: the interface already treats 404 as success, and a stale
    // row's remote resource may genuinely already be gone (that is what made
    // it stale in the first place).
  }
  try {
    const clientState = generateMicrosoftGraphClientState()
    const remote = await client.create({
      wellKnownFolder: wellKnownFolderFor(row.folderPath),
      notificationUrl: notificationUrl(baseUrl),
      lifecycleNotificationUrl: lifecycleUrl(baseUrl),
      clientState,
      expiresAt: now + SUBSCRIPTION_LIFETIME_SECONDS,
    })
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
    budget.spend()
    try {
      const client = await graphClientForAccount(env, runtime, row.accountId)
      if (!client) {
        // Account is gone. The FK cascade should already have removed this row
        // too; if it ever races, drop it rather than retrying forever.
        await repository.remove(row.id)
        continue
      }
      // A `stale` row (lifecycle event) and a create-time `pending:` sentinel
      // (review3 Important #7) both need a fresh `create()`, not a `renew()`
      // against an id that either no longer exists or never did.
      if (row.status === 'stale' || isPendingSentinel(row.subscriptionId)) {
        await rebuildSubscription(repository, client, baseUrl, row, now)
      } else {
        await renewOne(repository, client, row, now)
      }
    } catch (error) {
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
): Promise<void> {
  let remote: MicrosoftGraphRemoteSubscription[]
  try {
    remote = await client.list()
  } catch (error) {
    console.warn('Unable to list Microsoft Graph subscriptions for reconciliation', {
      accountId,
      type: error instanceof Error ? error.name : typeof error,
    })
    return
  }
  const ours = notificationUrl(baseUrl)
  const local = await repository.forAccount(accountId)
  const remoteIds = new Set(remote.map((item) => item.subscriptionId))
  for (const row of local) {
    // A `pending:` sentinel (review3 Important #7, C-5) never had a remote
    // resource in the first place — it would never appear in `remote` no
    // matter how many passes go by, so this branch would otherwise delete
    // it (and thus its create-time 24h backoff) on every single pass.
    if (isPendingSentinel(row.subscriptionId)) continue
    if (!remoteIds.has(row.subscriptionId)) {
      // Local row, no remote resource: delete it so the caller's subsequent
      // "create what's missing" step recreates it in this same pass (C-2).
      await repository.remove(row.id)
    }
  }
  const localSubscriptionIds = new Set(local.map((row) => row.subscriptionId))
  for (const item of remote) {
    if (item.notificationUrl === ours && !localSubscriptionIds.has(item.subscriptionId)) {
      // Remote resource pointed at our endpoint, no local row: an orphan from
      // an interrupted create (card A3/C-2) — remove it remotely.
      try {
        await client.remove(item.subscriptionId)
      } catch (error) {
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
): Promise<void> {
  const clientState = generateMicrosoftGraphClientState()
  try {
    const remote = await client.create({
      wellKnownFolder: wellKnownFolderFor(folderPath),
      notificationUrl: notificationUrl(baseUrl),
      lifecycleNotificationUrl: lifecycleUrl(baseUrl),
      clientState,
      expiresAt: now + SUBSCRIPTION_LIFETIME_SECONDS,
    })
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
    if (isPermanentSubscriptionRejection(error)) {
      // review3 Important #7 (C-5): a confirmed 403/4xx-non-429 at create
      // time is Microsoft telling us "no", not "maybe" like the ambiguous
      // case below — retrying every five minutes would just hammer the same
      // wall for 24h. Persist a `rejected` scheduling row now so the C-5 due
      // scan (`renewOrRebuildDue`, which routes a `pending:` sentinel to
      // `rebuildSubscription` instead of `renewOne`) is what retries it,
      // once, no sooner than `REJECTED_RETRY_SECONDS` from now. This also
      // makes the account's "present folders" set (in the caller) count this
      // folder as accounted for, so this same pass does not immediately
      // retry it again.
      await repository.insert({
        id: `microsoft_graph_sub_${crypto.randomUUID().replaceAll('-', '')}`,
        accountId,
        folderPath,
        subscriptionId: `${PENDING_SUBSCRIPTION_PREFIX}${crypto.randomUUID()}`,
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
    // genuinely unknown, Microsoft may already have created it remotely) —
    // card C-2's accepted edge case: no local row is written here, so the
    // NEXT pass's orphan check (`client.list()` in {@link reconcileOrphans})
    // is what cleans up a remote-only leftover, not a retry counter on a row
    // that was never inserted.
    console.error('Unable to create a Microsoft Graph subscription', {
      accountId,
      folderPath,
      type: error instanceof Error ? error.name : typeof error,
    })
  }
}

/**
 * C-2 two-way reconciliation, then C-5 create-what's-missing, for a bounded
 * set of Graph-preferred accounts.
 *
 * review3 Important #3: this used to select only accounts with fewer than
 * the two expected rows, so `reconcileOrphans` (this function's own remote
 * `list()` call) never ran at all for an account that already had two local
 * rows — even if those two rows were themselves stale/orphaned. The account
 * selection below is independent of local row count; `reconcileOrphans` now
 * runs once per selected account regardless, and only the subsequent
 * "create what's missing" step is conditioned on what that reconciliation
 * left behind.
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
      WHERE a.preferred_transport = 'graph'
        AND a.status NOT IN ('credential_error', 'permission_error')
      ORDER BY a.id
      LIMIT ?`,
  ).bind(RECONCILE_BATCH).all<{ id: string }>()
  for (const { id: accountId } of results) {
    if (!budget.hasCapacity()) break
    budget.spend()
    try {
      const client = await graphClientForAccount(env, runtime, accountId)
      if (!client) continue
      await reconcileOrphans(repository, client, baseUrl, accountId)
      const present = new Set((await repository.forAccount(accountId)).map((row) => row.folderPath))
      for (const spec of MICROSOFT_GRAPH_SUBSCRIBED_FOLDERS) {
        if (present.has(spec.folderPath)) continue
        await createOne(repository, client, baseUrl, accountId, spec.folderPath, now)
      }
    } catch (error) {
      console.error('Unable to reconcile/create Microsoft Graph subscriptions for one account', {
        accountId,
        type: error instanceof Error ? error.name : typeof error,
      })
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
    budget.spend()
    try {
      const rows = await repository.forAccount(accountId)
      let client: MicrosoftGraphSubscriptionClient | null = null
      try {
        client = await graphClientForAccount(env, runtime, accountId)
      } catch (error) {
        console.warn('Unable to obtain a Graph token to remove stale subscriptions remotely', {
          accountId,
          type: error instanceof Error ? error.name : typeof error,
        })
      }
      for (const row of rows) {
        if (client) {
          try {
            await client.remove(row.subscriptionId)
          } catch (error) {
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
