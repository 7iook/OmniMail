import type { Env } from '../../app/types'
import { MicrosoftStoreError } from './microsoft-store'
import type { MicrosoftMailTransport } from './microsoft-transport'
import { microsoftTransportFailure } from './microsoft-transport-errors'
import type { MicrosoftMessageMetadata, MicrosoftTransport } from './microsoft-types'

/** How many rows per (account, folder, transport) survive retention trimming. */
export const INDEX_MESSAGE_LIMIT = 500

export interface MicrosoftFolderRefreshResult {
  /** Rows written or refreshed from the transport's metadata listing. */
  indexed: number
  /**
   * Whether remote deletions were reconciled this run. `false` means the remote
   * id listing failed (truncated, throttled, transient) and nothing was deleted
   * — never that the folder was found empty.
   */
  reconciled: boolean
  /** The transport's locator epoch for this folder; `null` when it has none. */
  uidValidity: number | null
}

/**
 * Local ids that are absent remotely. Pure set difference on opaque strings;
 * an IMAP UID and a Graph id never meet here because the caller scopes both
 * sides to one transport.
 */
export function missingMicrosoftRemoteIds(local: string[], remote: string[]): string[] {
  const present = new Set(remote)
  return local.filter((id) => !present.has(id))
}

async function storedFolder(
  env: Env,
  accountId: string,
  folderPath: string,
): Promise<{ uid_validity: number | null }> {
  const folder = await env.DB.prepare(
    `SELECT uid_validity FROM microsoft_imap_folders
      WHERE account_id = ? AND path = ? LIMIT 1`,
  ).bind(accountId, folderPath).first<{ uid_validity: number | null }>()
  // The messages table has a composite FK onto this row, so indexing without it
  // would fail inside the batch with a far less readable error.
  if (!folder) throw new MicrosoftStoreError(404, 'folder_not_found', 'Microsoft 文件夹不存在。')
  return folder
}

/**
 * The newest locally indexed locators this transport issued for the folder.
 *
 * Scoped by `source_transport` because locators are not comparable across
 * transports (decision card §1.3.1): diffing Graph ids against an IMAP UID set
 * would read every Graph row as "deleted remotely".
 */
async function localRemoteIds(
  env: Env,
  accountId: string,
  folderPath: string,
  transport: MicrosoftTransport,
): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT remote_id FROM microsoft_imap_messages
      WHERE account_id = ? AND folder_path = ? AND source_transport = ?
      ORDER BY received_at DESC, id DESC LIMIT ?`,
  ).bind(accountId, folderPath, transport, INDEX_MESSAGE_LIMIT).all<{ remote_id: string }>()
  return results.map(({ remote_id }) => remote_id)
}

/**
 * Locators that vanished remotely, or `null` when that cannot be known.
 *
 * A failed listing is not an empty listing. Treating it as one would delete
 * the whole local index on a throttled or truncated response, so reconciliation
 * is skipped for the run and the caller reports `reconciled: false`.
 */
async function vanishedRemoteIds(
  transport: MicrosoftMailTransport,
  folderPath: string,
  local: string[],
): Promise<string[] | null> {
  if (!local.length) return []
  try {
    return missingMicrosoftRemoteIds(local, await transport.listRemoteIds(folderPath))
  } catch (error) {
    const failure = microsoftTransportFailure(error, transport.transport)
    console.warn('Skipping Microsoft deletion reconciliation: remote listing failed', {
      transport: transport.transport,
      code: failure.code,
      category: failure.category,
    })
    return null
  }
}

function messageStatement(
  env: Env,
  accountId: string,
  folderPath: string,
  transport: MicrosoftTransport,
  message: MicrosoftMessageMetadata,
  now: number,
): D1PreparedStatement {
  // Two upsert paths, because a row can collide on either identity layer:
  //  1. named locator target — the same transport re-fetching the same message;
  //     refresh the payload in place.
  //  2. targetless fallback — the same mail (matched on RFC5322 Message-ID by the
  //     partial index) arriving over the OTHER transport, or from a folder this
  //     transport names differently. Take over the existing row and adopt the new
  //     locator, so later fetches and deletion reconciliation address it through
  //     whichever transport last won. Without this the insert fails outright and
  //     takes the entire D1 batch with it.
  // SQLite only permits a target on non-final clauses, so the fallback must come
  // last and stay targetless — a second named target is rejected at prepare time.
  return env.DB.prepare(
    `INSERT INTO microsoft_imap_messages (
      id, account_id, folder_path, source_transport, remote_id, uid_validity,
      internet_message_id, sender_name, sender_address, recipients_json,
      cc_json, subject, preview, received_at, sent_at, size_bytes, flags_json,
      is_read, is_starred, has_attachments, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, folder_path, source_transport, remote_id) DO UPDATE SET
      internet_message_id = excluded.internet_message_id,
      sender_name = excluded.sender_name,
      sender_address = excluded.sender_address,
      recipients_json = excluded.recipients_json,
      cc_json = excluded.cc_json,
      subject = excluded.subject,
      preview = excluded.preview,
      received_at = excluded.received_at,
      sent_at = excluded.sent_at,
      size_bytes = excluded.size_bytes,
      flags_json = excluded.flags_json,
      is_read = excluded.is_read,
      is_starred = excluded.is_starred,
      has_attachments = excluded.has_attachments,
      updated_at = excluded.updated_at
    ON CONFLICT DO UPDATE SET
      folder_path = excluded.folder_path,
      source_transport = excluded.source_transport,
      remote_id = excluded.remote_id,
      uid_validity = excluded.uid_validity,
      sender_name = excluded.sender_name,
      sender_address = excluded.sender_address,
      recipients_json = excluded.recipients_json,
      cc_json = excluded.cc_json,
      subject = excluded.subject,
      preview = excluded.preview,
      received_at = excluded.received_at,
      sent_at = excluded.sent_at,
      size_bytes = excluded.size_bytes,
      flags_json = excluded.flags_json,
      is_read = excluded.is_read,
      is_starred = excluded.is_starred,
      has_attachments = excluded.has_attachments,
      updated_at = excluded.updated_at`,
  ).bind(
    `microsoft_msg_${crypto.randomUUID().replaceAll('-', '')}`,
    accountId,
    folderPath,
    transport,
    message.remoteId,
    // The transport stamps its own epoch (IMAP: the mailbox UIDVALIDITY; Graph:
    // null). The orchestrator never fabricates one (decision card §3.2).
    message.uidValidity,
    message.internetMessageId,
    message.senderName,
    message.senderAddress,
    JSON.stringify(message.recipients),
    JSON.stringify(message.cc),
    message.subject,
    message.preview,
    message.receivedAt || now,
    message.sentAt,
    message.sizeBytes,
    JSON.stringify(message.flags),
    Number(message.isRead),
    Number(message.isStarred),
    Number(message.hasAttachments),
    now,
    now,
  )
}

/**
 * Re-indexes one folder through whichever transport the cascade resolved.
 *
 * Shared by scheduled sync and the manual folder refresh, and deliberately free
 * of any `transport.transport` branch (decision card §3.2, invariant I-1). The
 * three IMAP facts that used to live here are now behind the interface:
 *
 *  - "newest N" is the transport's call (`listRecentMetadata`), because only
 *    IMAP can slice an ascending UID set;
 *  - the locator epoch (`folderState().uidValidity`) is the transport's, and a
 *    transport that has none reports `null`, which can never trigger the wipe;
 *  - there is no high-water UID to compute — `last_uid` was write-only.
 *
 * Every DELETE is scoped to `source_transport = <this transport>`. Rows the
 * other transport produced are never ranked, diffed or wiped by this run.
 */
export async function refreshMicrosoftFolderWithTransport(
  env: Env,
  accountId: string,
  folderPath: string,
  limit: number,
  transport: MicrosoftMailTransport,
  now = Math.floor(Date.now() / 1000),
): Promise<MicrosoftFolderRefreshResult> {
  const kind = transport.transport
  const folder = await storedFolder(env, accountId, folderPath)
  const state = await transport.folderState(folderPath)
  // A changed epoch voids every locator this transport previously issued for
  // the folder, so the local set is not worth diffing: it all goes.
  const epochChanged = state.uidValidity !== null
    && folder.uid_validity !== null
    && folder.uid_validity !== state.uidValidity
  const existing = epochChanged ? [] : await localRemoteIds(env, accountId, folderPath, kind)
  const targetCount = Math.min(INDEX_MESSAGE_LIMIT, Math.max(limit, existing.length))
  const metadata = await transport.listRecentMetadata(folderPath, { limit: targetCount })
  const vanished = epochChanged ? [] : await vanishedRemoteIds(transport, folderPath, existing)

  const statements: D1PreparedStatement[] = []
  if (epochChanged) {
    statements.push(env.DB.prepare(
      `DELETE FROM microsoft_imap_messages
        WHERE account_id = ? AND folder_path = ? AND source_transport = ?`,
    ).bind(accountId, folderPath, kind))
  }
  statements.push(...metadata.map((message) => messageStatement(
    env, accountId, folderPath, kind, message, now,
  )))
  statements.push(...(vanished ?? []).map((remoteId) => env.DB.prepare(
    `DELETE FROM microsoft_imap_messages
      WHERE account_id = ? AND folder_path = ? AND source_transport = ?
        AND remote_id = ?`,
  ).bind(accountId, folderPath, kind, remoteId)))
  // Retention trim, scoped to this transport: ranking IMAP and Graph rows together
  // would let an IMAP sync evict Graph-fetched mail (and vice versa) purely because
  // the other transport happened to hold newer messages.
  statements.push(env.DB.prepare(
    `DELETE FROM microsoft_imap_messages
      WHERE account_id = ? AND folder_path = ? AND source_transport = ?
        AND id NOT IN (
        SELECT id FROM microsoft_imap_messages
          WHERE account_id = ? AND folder_path = ? AND source_transport = ?
          ORDER BY received_at DESC, id DESC LIMIT ?
      )`,
  ).bind(accountId, folderPath, kind, accountId, folderPath, kind, INDEX_MESSAGE_LIMIT))
  // COALESCE keeps the IMAP epoch on the folder row while Graph is the active
  // transport. Nulling it would let IMAP come back after a UIDVALIDITY change
  // and find no stored epoch to compare against — leaving its stale rows alive.
  statements.push(env.DB.prepare(
    `UPDATE microsoft_imap_folders
        SET uid_validity = COALESCE(?, uid_validity), last_listed_at = ?
      WHERE account_id = ? AND path = ?`,
  ).bind(state.uidValidity, now, accountId, folderPath))
  await env.DB.batch(statements)
  return {
    indexed: metadata.length,
    reconciled: vanished !== null,
    uidValidity: state.uidValidity,
  }
}
