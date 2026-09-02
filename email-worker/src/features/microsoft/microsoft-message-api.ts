import type { Env, SessionUser } from '../../app/types'
import { attachmentDisposition, safeJsonArray } from '../../shared/http/api-helpers'
import { microsoftMessageLimit } from './microsoft-fields'
import {
  microsoftPrivateJson,
  microsoftResponseError,
  recordMicrosoftAccountFailure,
} from './microsoft-api-shared'
import { resolveMicrosoftTransport } from './microsoft-session'
import { MicrosoftAccountStore, MicrosoftStoreError } from './microsoft-store'
import { refreshMicrosoftFolderWithTransport } from './microsoft-sync-folder'
import type { MicrosoftMailTransport, MicrosoftMessageContent } from './microsoft-transport'
import { microsoftTransportFailure } from './microsoft-transport-errors'
import type { MicrosoftAccount, MicrosoftAccountStatus, MicrosoftTransport } from './microsoft-types'

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const FOLDER_REFRESH_INTERVAL_SECONDS = 30

type MicrosoftMessageRow = {
  id: string
  account_id: string
  folder_path: string
  source_transport: MicrosoftTransport
  remote_id: string
  uid_validity: number | null
  internet_message_id: string
  sender_name: string
  sender_address: string
  recipients_json: string
  cc_json: string
  subject: string
  preview: string
  received_at: number
  sent_at: number | null
  size_bytes: number
  is_read: number
  is_starred: number
  has_attachments: number
  account_name: string
  account_email: string
  account_status: MicrosoftAccountStatus
}

function encodeCursor(date: number, id: string): string {
  return btoa(JSON.stringify({ date, id }))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function decodeCursor(value: string | null): { date: number; id: string } | null {
  if (!value) return null
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=')
    const parsed = JSON.parse(atob(normalized)) as { date?: unknown; id?: unknown }
    if (!Number.isSafeInteger(parsed.date)
      || typeof parsed.id !== 'string'
      || parsed.id.length > 100) {
      throw new Error()
    }
    return { date: parsed.date as number, id: parsed.id }
  } catch {
    throw new MicrosoftStoreError(400, 'invalid_cursor', 'Microsoft 邮件分页游标无效。')
  }
}

function publicMessage(row: MicrosoftMessageRow) {
  return {
    id: row.id,
    account: {
      id: row.account_id,
      name: row.account_name,
      email: row.account_email,
      status: row.account_status,
    },
    folderPath: row.folder_path,
    uidValidity: row.uid_validity,
    remoteId: row.remote_id,
    senderName: row.sender_name,
    senderAddress: row.sender_address,
    recipients: safeJsonArray(row.recipients_json),
    cc: safeJsonArray(row.cc_json),
    subject: row.subject,
    preview: row.preview,
    date: row.received_at,
    sentAt: row.sent_at,
    sizeBytes: row.size_bytes,
    isRead: Boolean(row.is_read),
    isStarred: Boolean(row.is_starred),
    hasAttachments: Boolean(row.has_attachments),
  }
}

async function selectedFolder(
  store: MicrosoftAccountStore,
  accountId: string,
  requested: string,
): Promise<string> {
  if (requested) {
    const folder = await store.folder(accountId, requested)
    if (!folder) throw new MicrosoftStoreError(404, 'folder_not_found', 'Microsoft 文件夹不存在。')
    return folder.path
  }
  const inbox = (await store.folders(accountId))
    .find(({ path }) => path.toUpperCase() === 'INBOX')
  if (!inbox) throw new MicrosoftStoreError(404, 'folder_not_found', 'Microsoft INBOX 不存在。')
  return inbox.path
}

/**
 * Leaves a remote failure on the account row, the way verify and sync do, so a
 * credential that dies between two scheduled syncs stops reading `active` the
 * moment a list or read request hits it (review F2).
 *
 * `auth`, `permission`, `throttled` and `transient` are verdicts about the
 * credential or the channel's health and land as the status the classifier
 * derives (the same one `recordRemoteFailure` in the account API writes).
 * `contract` and `data` are verdicts about the request — a stale locator, a
 * mail that is gone, a payload we could not parse — and say nothing about the
 * account, so they leave the row alone. Always rethrows: recording is a side
 * effect of failing, not a replacement for the error response.
 */
async function recordRemoteFailure(
  env: Env,
  account: MicrosoftAccount,
  error: unknown,
  transport: MicrosoftTransport,
): Promise<never> {
  const failure = microsoftTransportFailure(error, transport)
  if (failure.category !== 'contract' && failure.category !== 'data') {
    await recordMicrosoftAccountFailure(env, account.id, failure)
  }
  throw error
}

/**
 * The channel a failure is attributed to when it surfaced before any transport
 * was resolved. The classifier does not depend on it; it only labels the record.
 */
function attemptedTransport(account: MicrosoftAccount): MicrosoftTransport {
  return account.preferredTransport === 'imap' ? 'imap' : 'graph'
}

/**
 * Runs the remote phase of a request against a resolved transport.
 *
 * Only failures raised here reach {@link recordRemoteFailure}: a cascade that
 * cannot open a channel, or a transport call that fails. Our own pre-checks
 * (rate-limit claim, ownership, folder lookup) and the local D1 queries around
 * it stay outside, so they can never be mistaken for a verdict on the account.
 */
async function withRemote<T>(
  env: Env,
  account: MicrosoftAccount,
  work: (transport: MicrosoftMailTransport) => Promise<T>,
): Promise<T> {
  let transport: MicrosoftMailTransport | undefined
  try {
    transport = (await resolveMicrosoftTransport(env, account)).transport
    return await work(transport)
  } catch (error) {
    return await recordRemoteFailure(
      env, account, error, transport?.transport ?? attemptedTransport(account),
    )
  } finally {
    await transport?.close()
  }
}

async function refreshFolder(
  env: Env,
  store: MicrosoftAccountStore,
  accountId: string,
  folderPath: string,
  limit: number,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const claim = await env.DB.prepare(
    `UPDATE microsoft_imap_accounts SET last_manual_sync_at = ?, updated_at = ?
      WHERE id = ?
        AND (last_manual_sync_at IS NULL OR last_manual_sync_at <= ?)`,
  ).bind(now, now, accountId, now - FOLDER_REFRESH_INTERVAL_SECONDS).run()
  if (!claim.meta.changes) {
    throw new MicrosoftStoreError(429, 'folder_refresh_rate_limited', '文件夹刷新过于频繁，请稍后重试。')
  }
  const account = await store.get(accountId)
  await withRemote(env, account, (transport) => (
    refreshMicrosoftFolderWithTransport(env, accountId, folderPath, limit, transport, now)
  ))
}

export async function listMicrosoftMessages(
  env: Env,
  user: SessionUser,
  request: Request,
): Promise<Response> {
  try {
    const search = new URL(request.url).searchParams
    const store = new MicrosoftAccountStore(env, user.id)
    const accountId = search.get('accountId')?.trim() || ''
    const requestedFolder = search.get('folder') || ''
    if (requestedFolder && !accountId) {
      throw new MicrosoftStoreError(
        400,
        'account_required',
        '选择非默认文件夹时必须指定 Microsoft 账号。',
      )
    }
    let folderPath = 'INBOX'
    if (accountId) {
      if (!await store.publicAccount(accountId)) {
        throw new MicrosoftStoreError(404, 'account_not_found', 'Microsoft 账号不存在。')
      }
      folderPath = await selectedFolder(store, accountId, requestedFolder)
    }
    const limit = microsoftMessageLimit(search.get('limit'))
    if (search.get('refresh') === '1') {
      if (!accountId) {
        throw new MicrosoftStoreError(400, 'account_required', '远程刷新必须指定 Microsoft 账号。')
      }
      await refreshFolder(env, store, accountId, folderPath, limit)
    }
    const query = (search.get('q') || '').trim().slice(0, 120)
    const cursor = decodeCursor(search.get('cursor'))
    const conditions = ['a.user_id = ?']
    const bindings: unknown[] = [user.id]
    if (accountId) {
      conditions.push('a.id = ?', 'm.folder_path = ?')
      bindings.push(accountId, folderPath)
    } else {
      conditions.push("upper(m.folder_path) = 'INBOX'")
    }
    if (query) {
      const term = query.toLowerCase()
      conditions.push(`(instr(lower(m.sender_name), ?) > 0
        OR instr(lower(m.sender_address), ?) > 0
        OR instr(lower(m.recipients_json), ?) > 0
        OR instr(lower(m.cc_json), ?) > 0
        OR instr(lower(m.subject), ?) > 0)`)
      bindings.push(term, term, term, term, term)
    }
    if (cursor) {
      conditions.push('(m.received_at < ? OR (m.received_at = ? AND m.id < ?))')
      bindings.push(cursor.date, cursor.date, cursor.id)
    }
    const { results } = await env.DB.prepare(
      `SELECT m.*, a.name AS account_name, a.normalized_email AS account_email,
              a.status AS account_status
         FROM microsoft_imap_messages m
         JOIN microsoft_imap_accounts a ON a.id = m.account_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY m.received_at DESC, m.id DESC LIMIT ?`,
    ).bind(...bindings, limit + 1).all<MicrosoftMessageRow>()
    const hasMore = results.length > limit
    const rows = results.slice(0, limit)
    const last = rows.at(-1)
    return microsoftPrivateJson({
      messages: rows.map(publicMessage),
      page: {
        hasMore,
        nextCursor: hasMore && last ? encodeCursor(last.received_at, last.id) : null,
        limit,
      },
      folderPath,
    })
  } catch (error) {
    return microsoftResponseError(error)
  }
}

async function ownedMessage(
  env: Env,
  userId: string,
  accountId: string,
  messageId: string,
): Promise<MicrosoftMessageRow> {
  const row = await env.DB.prepare(
    `SELECT m.*, a.name AS account_name, a.normalized_email AS account_email,
            a.status AS account_status
       FROM microsoft_imap_accounts a
       JOIN microsoft_imap_messages m ON m.account_id = a.id
      WHERE a.user_id = ? AND a.id = ? AND m.id = ? LIMIT 1`,
  ).bind(userId, accountId, messageId).first<MicrosoftMessageRow>()
  if (!row) throw new MicrosoftStoreError(404, 'message_not_found', 'Microsoft 邮件不存在。')
  return row
}

/**
 * Guards that the row can be addressed through the resolved transport.
 *
 * Locators are transport-private (decision card §1.3.1): an IMAP UID means
 * nothing to Graph and vice versa. When the cascade has moved the account to
 * the other channel, the row is re-adopted by the next folder refresh (the
 * Message-ID upsert rewrites its locator), so the honest answer here is "refresh
 * the list", not a guess at the other channel's id.
 */
function assertAddressable(row: MicrosoftMessageRow, transport: MicrosoftMailTransport): void {
  if (row.source_transport !== transport.transport) {
    throw new MicrosoftStoreError(
      409,
      'message_locator_stale',
      'Microsoft 邮件索引来自另一条通道，请刷新邮件列表后重试。',
    )
  }
}

/**
 * IMAP's optimistic identity check. Only rows that carry an epoch are checked;
 * a Graph row has none, and a Graph message that no longer exists surfaces as a
 * 404 from the fetch itself instead.
 */
async function assertIdentityUnchanged(
  row: MicrosoftMessageRow,
  transport: MicrosoftMailTransport,
): Promise<void> {
  if (row.uid_validity === null) return
  const state = await transport.folderState(row.folder_path)
  if (state.uidValidity !== row.uid_validity) {
    throw new MicrosoftStoreError(
      404,
      'message_identity_changed',
      'Microsoft 文件夹 UIDVALIDITY 已变化，请刷新邮件列表。',
    )
  }
}

/**
 * Marks the message read remotely, then locally — in that order, so OmniMail
 * never shows "read" for mail Outlook still shows unread (link table node 9).
 *
 * A write is never replayed over the other transport (fallback matrix §3.5): a
 * permission failure is recorded on the account as `permission_error`, which is
 * the status the UI already explains with a re-authorise prompt.
 */
async function markRemoteRead(
  env: Env,
  transport: MicrosoftMailTransport,
  row: MicrosoftMessageRow,
): Promise<boolean> {
  try {
    await transport.markSeen(row.folder_path, row.remote_id, row.uid_validity)
  } catch (error) {
    const failure = microsoftTransportFailure(error, transport.transport, 'write')
    console.error('Unable to mark Microsoft message as seen', {
      accountId: row.account_id,
      messageId: row.id,
      transport: transport.transport,
      code: failure.code,
    })
    if (failure.category === 'permission') {
      await recordMicrosoftAccountFailure(env, row.account_id, failure)
      row.account_status = 'permission_error'
    }
    return false
  }
  try {
    await env.DB.prepare(
      // `id` is the primary key; the extra predicates only guard against a stale row.
      `UPDATE microsoft_imap_messages SET is_read = 1, updated_at = ?
        WHERE id = ? AND account_id = ? AND folder_path = ?`,
    ).bind(Math.floor(Date.now() / 1000), row.id, row.account_id, row.folder_path).run()
  } catch (error) {
    console.error('Unable to persist Microsoft read state', {
      accountId: row.account_id,
      messageId: row.id,
      type: error instanceof Error ? error.name : typeof error,
    })
  }
  return true
}

async function remoteMessage(
  env: Env,
  user: SessionUser,
  accountId: string,
  messageId: string,
  markRead = false,
): Promise<{
  row: MicrosoftMessageRow
  parsed: MicrosoftMessageContent
  markedRead: boolean
}> {
  const row = await ownedMessage(env, user.id, accountId, messageId)
  const account = await new MicrosoftAccountStore(env, user.id).get(accountId)
  return await withRemote(env, account, async (transport) => {
    assertAddressable(row, transport)
    await assertIdentityUnchanged(row, transport)
    const parsed = await transport.getMessage(row.folder_path, row.remote_id)
    const markedRead = markRead && !row.is_read
      ? await markRemoteRead(env, transport, row)
      : false
    return { row, parsed, markedRead }
  })
}

export async function getMicrosoftMessage(
  env: Env,
  user: SessionUser,
  accountId: string,
  messageId: string,
): Promise<Response> {
  try {
    const { row, parsed, markedRead } = await remoteMessage(
      env, user, accountId, messageId, true,
    )
    return microsoftPrivateJson({
      message: {
        ...publicMessage(row),
        ...parsed.message,
        id: row.id,
        isRead: Boolean(row.is_read) || markedRead,
      },
    })
  } catch (error) {
    return microsoftResponseError(error)
  }
}

export async function getMicrosoftAttachment(
  env: Env,
  user: SessionUser,
  accountId: string,
  messageId: string,
  partId: string,
): Promise<Response> {
  try {
    const { parsed } = await remoteMessage(env, user, accountId, messageId)
    const index = /^\d+$/.test(partId) ? Number(partId) : -1
    const attachment = parsed.parsedAttachments[index]
    if (!attachment) throw new MicrosoftStoreError(404, 'attachment_not_found', '附件不存在。')
    const content = typeof attachment.content === 'string'
      ? new TextEncoder().encode(attachment.content)
      : attachment.content instanceof Uint8Array
        ? attachment.content : new Uint8Array(attachment.content)
    if (content.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new MicrosoftStoreError(413, 'attachment_too_large', '附件超过 5 MiB 下载上限。')
    }
    const filename = parsed.message.attachments[index]?.filename || `attachment-${index + 1}`
    const contentType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(attachment.mimeType)
      ? attachment.mimeType : 'application/octet-stream'
    return new Response(content, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': attachmentDisposition(filename),
        'Content-Length': String(content.byteLength),
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    return microsoftResponseError(error)
  }
}
