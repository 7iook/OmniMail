import { ImapConnectionError } from '../../platform/imap/imap-errors'
import { qqMailImapEnabled } from './qq-mail-credentials'
import type { QqMailImapClient } from './qq-mail-imap'
import { qqMailAccountForSync, QqMailStoreError } from './qq-mail-store'
import type { QqMailMessageMetadata } from './qq-mail-types'
import type { Env, MailQueueJob, QqMailSyncJob } from '../../app/types'

const INITIAL_MESSAGE_LIMIT = 100
const INDEX_MESSAGE_LIMIT = 500
const SYNC_INTERVAL_SECONDS = 5 * 60
const LEASE_SECONDS = 6 * 60
const SCHEDULE_BATCH = 50

export type QqMailSyncResult = { status: 'synced' | 'skipped'; retryable: boolean }

async function qqMailClient(email: string, authorizationCode: string): Promise<QqMailImapClient> {
  const { QqMailImapClient } = await import('./qq-mail-imap')
  return new QqMailImapClient(email, authorizationCode)
}

export function qqMailSyncErrorCode(error: unknown): string {
  if (error instanceof QqMailStoreError) {
    if (error.status === 503) return 'credential_key_unavailable'
    return 'credential_decryption_failed'
  }
  if (error instanceof ImapConnectionError) {
    if (error.status === 400 || error.status === 401) return 'authentication_failed'
    if (error.status === 504) return 'timeout'
    if (/超过.*上限/.test(error.message)) return 'response_too_large'
    return 'connection_failed'
  }
  return 'sync_failed'
}

export function missingQqMailUids(
  localUids: number[],
  fetched: QqMailMessageMetadata[],
): number[] {
  const present = new Set(fetched.map(({ imapUid }) => imapUid))
  return localUids.filter((uid) => !present.has(uid))
}

async function claimLease(env: Env, accountId: string, leaseId: string, now: number): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE qq_mail_accounts
        SET sync_lease_id = ?, sync_lease_until = ?, status = 'syncing', updated_at = ?
      WHERE id = ? AND status != 'credential_error'
        AND (sync_lease_until IS NULL OR sync_lease_until <= ?)`,
  ).bind(leaseId, now + LEASE_SECONDS, now, accountId, now).run()
  return Boolean(result.meta.changes)
}

async function localUids(env: Env, accountId: string, uidValidity: number): Promise<number[]> {
  const { results } = await env.DB.prepare(
    `SELECT imap_uid FROM qq_mail_messages
      WHERE account_id = ? AND uid_validity = ?
      ORDER BY internal_date DESC, id DESC LIMIT ?`,
  ).bind(accountId, uidValidity, INDEX_MESSAGE_LIMIT).all<{ imap_uid: number }>()
  return results.map(({ imap_uid }) => imap_uid)
}

function messageStatement(
  env: Env,
  accountId: string,
  uidValidity: number,
  message: QqMailMessageMetadata,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO qq_mail_messages (
      id, account_id, imap_uid, uid_validity, message_id_header, sender_name,
      sender_address, recipients_json, cc_json, subject, preview, internal_date,
      size_bytes, flags_json, is_read, is_starred, has_attachments, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, uid_validity, imap_uid) DO UPDATE SET
      message_id_header = excluded.message_id_header,
      sender_name = excluded.sender_name,
      sender_address = excluded.sender_address,
      recipients_json = excluded.recipients_json,
      cc_json = excluded.cc_json,
      subject = excluded.subject,
      preview = excluded.preview,
      internal_date = excluded.internal_date,
      size_bytes = excluded.size_bytes,
      flags_json = excluded.flags_json,
      is_read = excluded.is_read,
      is_starred = excluded.is_starred,
      has_attachments = excluded.has_attachments,
      updated_at = excluded.updated_at`,
  ).bind(
    `qq_msg_${crypto.randomUUID().replaceAll('-', '')}`,
    accountId,
    message.imapUid,
    uidValidity,
    message.messageIdHeader,
    message.senderName,
    message.senderAddress,
    JSON.stringify(message.recipients),
    JSON.stringify(message.cc),
    message.subject,
    message.preview,
    message.internalDate || now,
    message.sizeBytes,
    JSON.stringify(message.flags),
    Number(message.isRead),
    Number(message.isStarred),
    Number(message.hasAttachments),
    now,
    now,
  )
}

async function recordFailure(
  env: Env,
  accountId: string,
  leaseId: string,
  error: unknown,
  now: number,
): Promise<string> {
  const code = qqMailSyncErrorCode(error)
  const credentialError = [
    'authentication_failed',
    'credential_decryption_failed',
    'credential_key_unavailable',
  ].includes(code)
  await env.DB.prepare(
    `UPDATE qq_mail_accounts
        SET status = ?, last_error_code = ?, last_error_at = ?,
            next_sync_at = ?, sync_lease_id = NULL, sync_lease_until = NULL,
            updated_at = ?
      WHERE id = ? AND sync_lease_id = ?`,
  ).bind(
    credentialError ? 'credential_error' : 'error',
    code,
    now,
    now + (credentialError ? 24 * 60 * 60 : SYNC_INTERVAL_SECONDS),
    now,
    accountId,
    leaseId,
  ).run()
  return code
}

export async function syncQqMailAccount(
  env: Env,
  accountId: string,
  now = Math.floor(Date.now() / 1000),
): Promise<QqMailSyncResult> {
  const leaseId = crypto.randomUUID()
  if (!await claimLease(env, accountId, leaseId, now)) {
    return { status: 'skipped', retryable: false }
  }
  let client: QqMailImapClient | undefined
  try {
    const account = await qqMailAccountForSync(env, accountId)
    if (!account) throw new Error('credential_key_unavailable')
    client = await qqMailClient(account.email, account.authorizationCode)
    await client.open()
    const mailbox = await client.examineInbox()
    const reset = account.uidValidity !== mailbox.uidValidity
    const existingUids = reset ? [] : await localUids(env, accountId, mailbox.uidValidity)
    const discovery = reset
      ? { uids: await client.searchLatestUids(mailbox.uidNext, INITIAL_MESSAGE_LIMIT), scannedThrough: 0 }
      : await client.searchAfter(account.lastSeenUid, mailbox.uidNext)
    const fetchUids = [...new Set([...existingUids, ...discovery.uids])]
      .sort((left, right) => left - right)
      .slice(-INDEX_MESSAGE_LIMIT)
    const metadata = await client.fetchMetadata(fetchUids)
    const missing = reset ? [] : missingQqMailUids(existingUids, metadata)
    const highestUid = reset
      ? Math.max(0, ...discovery.uids, ...metadata.map(({ imapUid }) => imapUid))
      : Math.max(account.lastSeenUid, discovery.scannedThrough)
    const statements: D1PreparedStatement[] = []
    if (reset) {
      statements.push(env.DB.prepare(
        'DELETE FROM qq_mail_messages WHERE account_id = ?',
      ).bind(accountId))
    }
    statements.push(...metadata.map((message) => (
      messageStatement(env, accountId, mailbox.uidValidity, message, now)
    )))
    statements.push(...missing.map((uid) => env.DB.prepare(
      'DELETE FROM qq_mail_messages WHERE account_id = ? AND uid_validity = ? AND imap_uid = ?',
    ).bind(accountId, mailbox.uidValidity, uid)))
    statements.push(env.DB.prepare(
      `DELETE FROM qq_mail_messages
        WHERE account_id = ? AND id NOT IN (
          SELECT id FROM qq_mail_messages WHERE account_id = ?
          ORDER BY internal_date DESC, id DESC LIMIT ?
        )`,
    ).bind(accountId, accountId, INDEX_MESSAGE_LIMIT))
    statements.push(env.DB.prepare(
      `UPDATE qq_mail_accounts
          SET status = 'active', uid_validity = ?, uid_next = ?, last_seen_uid = ?,
              last_synced_at = ?, next_sync_at = ?, last_error_code = '',
              last_error_at = NULL, sync_lease_id = NULL, sync_lease_until = NULL,
              updated_at = ?
        WHERE id = ? AND sync_lease_id = ?`,
    ).bind(
      mailbox.uidValidity,
      mailbox.uidNext,
      highestUid,
      now,
      now + SYNC_INTERVAL_SECONDS,
      now,
      accountId,
      leaseId,
    ))
    await env.DB.batch(statements)
    return { status: 'synced', retryable: false }
  } catch (error) {
    const code = await recordFailure(env, accountId, leaseId, error, now)
    return {
      status: 'skipped',
      retryable: ![
        'authentication_failed',
        'credential_decryption_failed',
        'credential_key_unavailable',
        'response_too_large',
      ].includes(code),
    }
  } finally {
    await client?.close()
  }
}

export async function consumeQqMailSyncJob(
  message: Message<MailQueueJob>,
  env: Env,
): Promise<void> {
  if (message.body.kind !== 'qq-mail-sync') return
  const result = await syncQqMailAccount(env, message.body.accountId)
  if (result.retryable && message.attempts < 3) {
    message.retry({ delaySeconds: 30 * 2 ** Math.max(0, message.attempts - 1) })
  } else {
    message.ack()
  }
}

export async function enqueueDueQqMailSyncs(
  env: Env,
  now = Math.floor(Date.now() / 1000),
): Promise<number> {
  if (!qqMailImapEnabled(env)) return 0
  const { results } = await env.DB.prepare(
    `SELECT id FROM qq_mail_accounts
      WHERE status IN ('active', 'error') AND next_sync_at <= ?
        AND (sync_lease_until IS NULL OR sync_lease_until <= ?)
      ORDER BY next_sync_at, id LIMIT ?`,
  ).bind(now, now, SCHEDULE_BATCH).all<{ id: string }>()
  let queued = 0
  for (const account of results) {
    const claimed = await env.DB.prepare(
      `UPDATE qq_mail_accounts SET next_sync_at = ?, updated_at = ?
        WHERE id = ? AND next_sync_at <= ?`,
    ).bind(now + SYNC_INTERVAL_SECONDS, now, account.id, now).run()
    if (!claimed.meta.changes) continue
    try {
      const job: QqMailSyncJob = {
        kind: 'qq-mail-sync', accountId: account.id, reason: 'scheduled',
      }
      await env.MAIL_QUEUE.send(job)
      queued += 1
    } catch (error) {
      await env.DB.prepare(
        'UPDATE qq_mail_accounts SET next_sync_at = ? WHERE id = ?',
      ).bind(now, account.id).run()
      throw error
    }
  }
  return queued
}
