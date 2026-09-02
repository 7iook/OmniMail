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
): Promise<void> {
  const due = await repository.due(now, RECONCILE_BATCH)
  for (const row of due) {
    try {
      const client = await graphClientForAccount(env, runtime, row.accountId)
      if (!client) {
        // Account is gone. The FK cascade should already have removed this row
        // too; if it ever races, drop it rather than retrying forever.
        await repository.remove(row.id)
        continue
      }
      if (row.status === 'stale') {
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
    // Creation failed, or its result is unknown (a network blip after Microsoft
    // may already have created it remotely) — card C-2's accepted edge case: no
    // local row is written here, so the NEXT pass's orphan check (`client.list()`
    // in {@link reconcileOrphans}) is what cleans up a remote-only leftover, not
    // a retry counter on a row that was never inserted.
    console.error('Unable to create a Microsoft Graph subscription', {
      accountId,
      folderPath,
      type: error instanceof Error ? error.name : typeof error,
    })
  }
}

/** Graph-preferred accounts with fewer than the two expected subscription rows. */
async function createMissingSubscriptions(
  env: Env,
  repository: MicrosoftGraphSubscriptionRepository,
  runtime: MicrosoftGraphSubscriptionRuntime,
  baseUrl: string,
  now: number,
): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT a.id FROM microsoft_imap_accounts a
      WHERE a.preferred_transport = 'graph'
        AND a.status NOT IN ('credential_error', 'permission_error')
        AND (SELECT COUNT(*) FROM microsoft_graph_subscriptions s WHERE s.account_id = a.id) < 2
      ORDER BY a.id
      LIMIT ?`,
  ).bind(RECONCILE_BATCH).all<{ id: string }>()
  for (const { id: accountId } of results) {
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
      console.error('Unable to create missing Microsoft Graph subscriptions for one account', {
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
): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT a.id FROM microsoft_imap_accounts a
       JOIN microsoft_graph_subscriptions s ON s.account_id = a.id
      WHERE a.preferred_transport != 'graph'
      ORDER BY a.id
      LIMIT ?`,
  ).bind(RECONCILE_BATCH).all<{ id: string }>()
  for (const { id: accountId } of results) {
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
  }
}

/**
 * Testable core, given an explicit runtime (card C-7's injection point).
 * `env.MICROSOFT_GRAPH_WEBHOOK_BASE_URL` unset is treated as "push disabled":
 * the caller ({@link reconcileDueMicrosoftGraphSubscriptions}) already logs
 * this once, so this function stays silent and simply does nothing.
 */
export async function reconcileMicrosoftGraphSubscriptions(
  env: Env,
  now: number,
  runtime: MicrosoftGraphSubscriptionRuntime,
): Promise<void> {
  const baseUrl = env.MICROSOFT_GRAPH_WEBHOOK_BASE_URL
  if (!baseUrl) return
  const repository = runtime.repositoryFor(env)
  await renewOrRebuildDue(env, repository, runtime, baseUrl, now)
  await createMissingSubscriptions(env, repository, runtime, baseUrl, now)
  await removeForNonGraphAccounts(env, repository, runtime)
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
