import type { Env, MailQueueJob, MicrosoftSyncJob } from '../../app/types'
import { microsoftMailEnabled } from './microsoft-credentials'
import { microsoftGraphSubscriptionRuntime } from './microsoft-graph-notifications'
import { recordMicrosoftAccountFailure } from './microsoft-api-shared'
import { resolveMicrosoftTransport } from './microsoft-session'
import {
  microsoftAccountForSync,
  MicrosoftStoreError,
  saveMicrosoftFolders,
} from './microsoft-store'
import { refreshMicrosoftFolderWithTransport } from './microsoft-sync-folder'
import type { MicrosoftMailTransport } from './microsoft-transport'
import {
  microsoftAccountStatusForFailure,
  microsoftTransportFailure,
  type MicrosoftTransportFailure,
} from './microsoft-transport-errors'
import {
  MICROSOFT_GRAPH_SUBSCRIBED_FOLDERS,
  type MicrosoftAccount,
  type MicrosoftFolder,
  type MicrosoftGraphSubscription,
  type MicrosoftTransport,
} from './microsoft-types'

/** Fixed literal path for Junk Email (card C-4/C-7); see `microsoft-graph-transport.ts`. */
const JUNK_FOLDER_PATH_UPPER = MICROSOFT_GRAPH_SUBSCRIBED_FOLDERS[1].folderPath.toUpperCase()

const INITIAL_MESSAGE_LIMIT = 100
const SYNC_INTERVAL_SECONDS = 5 * 60
const PARKED_INTERVAL_SECONDS = 24 * 60 * 60
const LEASE_SECONDS = 6 * 60
const SCHEDULE_BATCH = 50
const QUEUE_MAX_ATTEMPTS = 3
const QUEUE_BASE_DELAY_SECONDS = 30

export type MicrosoftSyncResult = {
  status: 'synced' | 'skipped'
  retryable: boolean
  /** Seconds Microsoft asked us to wait; the queue retry must not come sooner. */
  retryAfterSeconds: number | null
}

async function claimLease(
  env: Env,
  accountId: string,
  leaseId: string,
  now: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE microsoft_imap_accounts
        SET sync_lease_id = ?, sync_lease_until = ?, status = 'syncing', updated_at = ?
      WHERE id = ? AND status NOT IN ('credential_error', 'permission_error')
        AND (sync_lease_until IS NULL OR sync_lease_until <= ?)`,
  ).bind(leaseId, now + LEASE_SECONDS, now, accountId, now).run()
  return Boolean(result.meta.changes)
}

export async function refreshMicrosoftFolders(
  env: Env,
  account: MicrosoftAccount,
  now = Math.floor(Date.now() / 1000),
): Promise<MicrosoftFolder[]> {
  const { transport } = await resolveMicrosoftTransport(env, account)
  try {
    const folders = await transport.listFolders()
    await saveMicrosoftFolders(env, account.id, folders, now)
    return folders
  } finally {
    await transport.close()
  }
}

/**
 * When to look at a failed account again.
 *
 * Credential and permission failures park the account for a day — scheduling
 * is also gated on status, so this is a backstop. Throttling waits at least the
 * Retry-After Microsoft sent (I-3) but never comes back sooner than the normal
 * cadence would have.
 */
function nextSyncDelay(failure: MicrosoftTransportFailure): number {
  if (failure.category === 'auth' || failure.category === 'permission') {
    return PARKED_INTERVAL_SECONDS
  }
  return Math.max(SYNC_INTERVAL_SECONDS, failure.retryAfterSeconds ?? 0)
}

async function recordFailure(
  env: Env,
  accountId: string,
  leaseId: string,
  failure: MicrosoftTransportFailure,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE microsoft_imap_accounts
        SET status = ?, last_error_code = ?, last_error_at = ?, next_sync_at = ?,
            sync_lease_id = NULL, sync_lease_until = NULL, updated_at = ?
      WHERE id = ? AND sync_lease_id = ?`,
  ).bind(
    microsoftAccountStatusForFailure(failure),
    failure.code,
    now,
    now + nextSyncDelay(failure),
    now,
    accountId,
    leaseId,
  ).run()
}

/**
 * The channel a failure is attributed to when it surfaced before any transport
 * was resolved. The classifier does not depend on it; it only labels the record.
 */
function attemptedTransport(account: MicrosoftAccount | null): MicrosoftTransport {
  return account?.preferredTransport === 'imap' ? 'imap' : 'graph'
}

export async function syncMicrosoftAccount(
  env: Env,
  accountId: string,
  now = Math.floor(Date.now() / 1000),
): Promise<MicrosoftSyncResult> {
  const leaseId = crypto.randomUUID()
  if (!await claimLease(env, accountId, leaseId, now)) {
    return { status: 'skipped', retryable: false, retryAfterSeconds: null }
  }
  let account: MicrosoftAccount | null = null
  let transport: MicrosoftMailTransport | undefined
  try {
    account = await microsoftAccountForSync(env, accountId)
    if (!account) throw new MicrosoftStoreError(404, 'account_not_found', 'Microsoft 账号不存在。')
    transport = (await resolveMicrosoftTransport(env, account)).transport
    const folders = await transport.listFolders()
    // Folder rows first: the messages table has a composite FK onto them, and a
    // Graph mailbox has no rows at all until this runs.
    await saveMicrosoftFolders(env, accountId, folders, now)
    const inbox = folders.find(({ path }) => path.toUpperCase() === 'INBOX')
    if (!inbox) throw new MicrosoftStoreError(502, 'inbox_unavailable', 'Microsoft INBOX 不可用。')
    await refreshMicrosoftFolderWithTransport(
      env,
      accountId,
      inbox.path,
      INITIAL_MESSAGE_LIMIT,
      transport,
      now,
    )
    // Junk Email is Graph-only (card C-4): IMAP's Junk folder is whatever the
    // mailbox calls it locally, never this literal path, so this is a no-op for
    // IMAP transports without needing a `transport.transport` branch here.
    const junk = folders.find(({ path }) => path.toUpperCase() === JUNK_FOLDER_PATH_UPPER)
    if (junk) {
      await refreshMicrosoftFolderWithTransport(
        env,
        accountId,
        junk.path,
        INITIAL_MESSAGE_LIMIT,
        transport,
        now,
      )
    }
    await env.DB.prepare(
      `UPDATE microsoft_imap_accounts
          SET status = 'active', last_synced_at = ?, next_sync_at = ?,
              last_error_code = '', last_error_at = NULL,
              sync_lease_id = NULL, sync_lease_until = NULL, updated_at = ?
        WHERE id = ? AND sync_lease_id = ?`,
    ).bind(now, now + SYNC_INTERVAL_SECONDS, now, accountId, leaseId).run()
    return { status: 'synced', retryable: false, retryAfterSeconds: null }
  } catch (error) {
    const failure = microsoftTransportFailure(
      error,
      transport?.transport ?? attemptedTransport(account),
    )
    await recordFailure(env, accountId, leaseId, failure, now)
    return {
      status: 'skipped',
      // Only a wait can be retried usefully. Auth, permission, data and contract
      // failures come back identical on the next attempt.
      retryable: failure.category === 'transient' || failure.category === 'throttled',
      retryAfterSeconds: failure.retryAfterSeconds,
    }
  } finally {
    await transport?.close()
  }
}

export async function consumeMicrosoftSyncJob(
  message: Message<MailQueueJob>,
  env: Env,
): Promise<void> {
  if (message.body.kind !== 'microsoft-sync') return
  const result = await syncMicrosoftAccount(env, message.body.accountId)
  if (result.retryable && message.attempts < QUEUE_MAX_ATTEMPTS) {
    const backoff = QUEUE_BASE_DELAY_SECONDS * 2 ** Math.max(0, message.attempts - 1)
    // Retrying inside Microsoft's Retry-After window would extend the lockout.
    message.retry({ delaySeconds: Math.max(backoff, result.retryAfterSeconds ?? 0) })
  } else {
    message.ack()
  }
}

/**
 * Consumes a Graph-notification-triggered folder refresh (card C-3/C-4).
 *
 * Deliberately not a variant of {@link syncMicrosoftAccount}: that function owns
 * the scheduled cadence (`next_sync_at`, the `sync_lease_*` columns) and always
 * refreshes both folders; this job refreshes exactly the one folder a
 * notification named, and its own concurrency guard is the subscription row's
 * `refresh_state` (C-3), not the account-level sync lease.
 *
 * Failure classification and retry intentionally reuse
 * {@link microsoftTransportFailure} and `recordMicrosoftAccountFailure` — the
 * same ones {@link consumeMicrosoftSyncJob} uses — rather than a second
 * classifier (I-10). `next_sync_at` is left untouched: this job is an
 * accelerator on top of the 5-minute cron, not a replacement for it.
 */
export async function consumeMicrosoftFolderRefreshJob(
  message: Message<MailQueueJob>,
  env: Env,
): Promise<void> {
  if (message.body.kind !== 'microsoft-folder-refresh') return
  const { accountId, folderPath } = message.body
  const now = Math.floor(Date.now() / 1000)
  const runtime = microsoftGraphSubscriptionRuntime()
  const repository = runtime?.repositoryFor(env) ?? null
  let subscription: MicrosoftGraphSubscription | null = null
  if (repository) {
    subscription = (await repository.forAccount(accountId)).find((row) => row.folderPath === folderPath) ?? null
    if (subscription) await repository.markRunning(subscription.id, now)
  }
  let account: MicrosoftAccount | null = null
  let transport: MicrosoftMailTransport | undefined
  try {
    account = await microsoftAccountForSync(env, accountId)
    if (!account) {
      message.ack()
      return
    }
    transport = (await resolveMicrosoftTransport(env, account)).transport
    // C-4: Graph-pinned. A fixed Graph path handed to an IMAP transport would
    // address nothing real — IMAP's own Junk folder is named whatever the
    // mailbox calls it locally, never this literal path.
    if (transport.transport !== 'graph') {
      console.warn('Microsoft Graph folder refresh skipped: account resolved to a non-Graph transport', {
        accountId,
        folderPath,
        code: 'folder_refresh_skipped_non_graph',
      })
      message.ack()
      return
    }
    await refreshMicrosoftFolderWithTransport(env, accountId, folderPath, INITIAL_MESSAGE_LIMIT, transport, now)
    message.ack()
  } catch (error) {
    const failure = microsoftTransportFailure(error, transport?.transport ?? attemptedTransport(account))
    await recordMicrosoftAccountFailure(env, accountId, failure, now)
    if ((failure.category === 'transient' || failure.category === 'throttled')
      && message.attempts < QUEUE_MAX_ATTEMPTS) {
      const backoff = QUEUE_BASE_DELAY_SECONDS * 2 ** Math.max(0, message.attempts - 1)
      message.retry({ delaySeconds: Math.max(backoff, failure.retryAfterSeconds ?? 0) })
    } else {
      message.ack()
    }
  } finally {
    await transport?.close()
    // Always release the C-3 state, success or failure, so a stuck `running`
    // row does not block every future notification for this (account, folder).
    if (repository && subscription) {
      const { requeue } = await repository.finishRunning(subscription.id, now)
      if (requeue) {
        try {
          await env.MAIL_QUEUE.send({ kind: 'microsoft-folder-refresh', accountId, folderPath, reason: 'notification' })
        } catch (sendError) {
          console.error('Unable to enqueue the follow-up Microsoft folder refresh', {
            accountId,
            folderPath,
            type: sendError instanceof Error ? sendError.name : typeof sendError,
          })
        }
      }
    }
  }
}

export async function enqueueDueMicrosoftSyncs(
  env: Env,
  now = Math.floor(Date.now() / 1000),
): Promise<number> {
  if (!microsoftMailEnabled(env)) return 0
  const { results } = await env.DB.prepare(
    `SELECT id FROM microsoft_imap_accounts
      WHERE status IN ('active', 'error') AND next_sync_at <= ?
        AND (sync_lease_until IS NULL OR sync_lease_until <= ?)
      ORDER BY next_sync_at, id LIMIT ?`,
  ).bind(now, now, SCHEDULE_BATCH).all<{ id: string }>()
  let queued = 0
  for (const account of results) {
    const claimed = await env.DB.prepare(
      `UPDATE microsoft_imap_accounts SET next_sync_at = ?, updated_at = ?
        WHERE id = ? AND next_sync_at <= ?`,
    ).bind(now + SYNC_INTERVAL_SECONDS, now, account.id, now).run()
    if (!claimed.meta.changes) continue
    try {
      const job: MicrosoftSyncJob = {
        kind: 'microsoft-sync',
        accountId: account.id,
        reason: 'scheduled',
      }
      await env.MAIL_QUEUE.send(job)
      queued += 1
    } catch (error) {
      await env.DB.prepare(
        'UPDATE microsoft_imap_accounts SET next_sync_at = ? WHERE id = ?',
      ).bind(now, account.id).run()
      throw error
    }
  }
  return queued
}
