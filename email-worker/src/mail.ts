import PostalMime from 'postal-mime'
import { archiveIncomingMessage } from './mail-archive'
import { releaseStorage, reserveStorage } from './message-storage'
import { ensureSchema } from './schema'
import type { Env, MessageRow, ParseJob, StoredBody } from './types'

type ParsedAddress = {
  address?: string
  name?: string
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase()
}

export function baseMailboxAddress(value: string): string {
  const normalized = normalizeAddress(value)
  const at = normalized.lastIndexOf('@')
  if (at < 1) return normalized
  const local = normalized.slice(0, at)
  const plus = local.indexOf('+')
  return plus > 0 ? `${local.slice(0, plus)}${normalized.slice(at)}` : normalized
}

export function replySubject(subject: string): string {
  const clean = subject.trim() || '无主题'
  return /^re:/i.test(clean) ? clean : `Re: ${clean}`
}

export function textPreview(value: string, maximum = 180): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > maximum ? `${clean.slice(0, maximum - 1)}…` : clean
}

export function textToHtml(value: string): string {
  const escaped = value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
  return escaped
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replaceAll('\n', '<br>')}</p>`)
    .join('')
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
}

function addressValue(address: ParsedAddress | undefined): string {
  return normalizeAddress(address?.address ?? '')
}

function addressName(address: ParsedAddress | undefined): string {
  return address?.name?.trim() ?? ''
}

function addressList(addresses: ParsedAddress[] | undefined): string[] {
  return (addresses ?? []).map(addressValue).filter(Boolean)
}

function referenceValue(value: unknown): string {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string').join(' ')
  return typeof value === 'string' ? value : ''
}

async function mailboxForRecipient(
  db: D1Database,
  recipient: string,
): Promise<{ address: string; userId: string } | null> {
  const exact = normalizeAddress(recipient)
  const base = baseMailboxAddress(recipient)
  const row = await db.prepare(
    `SELECT mb.address, mb.user_id
       FROM mailboxes mb
       JOIN users u ON u.id = mb.user_id
      WHERE mb.is_active = 1
        AND mb.address IN (?, ?)
        AND u.status = 'active'
        AND u.deleted_at IS NULL
      ORDER BY CASE WHEN mb.address = ? THEN 0 ELSE 1 END
      LIMIT 1`,
  ).bind(exact, base, exact).first<{ address: string; user_id: string }>()
  return row ? { address: row.address, userId: row.user_id } : null
}

export async function receiveEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  await ensureSchema(env.DB)
  const mailbox = await mailboxForRecipient(env.DB, message.to)
  if (!mailbox) {
    message.setReject('Mailbox unavailable')
    return
  }

  const id = crypto.randomUUID()
  const rawKey = `raw/${id}.eml`
  const now = Math.floor(Date.now() / 1000)
  const incomingMessageId = message.headers.get('message-id')?.trim() || null
  const subject = message.headers.get('subject')?.trim() || '无主题'

  if (incomingMessageId) {
    const duplicate = await env.DB.prepare(
      'SELECT id FROM messages WHERE mailbox_address = ? AND message_id = ?',
    ).bind(mailbox.address, incomingMessageId).first<{ id: string }>()
    if (duplicate) return
  }

  const quotaBytes = Math.max(0, message.rawSize)
  if (!await reserveStorage(env.DB, mailbox.userId, quotaBytes)) {
    message.setReject('Mailbox storage quota exceeded')
    return
  }

  let rawStored = false
  let inserted = false
  try {
    const raw = await new Response(message.raw).arrayBuffer()
    await env.MAIL_BUCKET.put(rawKey, raw, {
      httpMetadata: { contentType: 'message/rfc822' },
    })
    rawStored = true
    const insertResult = await env.DB.prepare(
      `INSERT OR IGNORE INTO messages (
        id, mailbox_address, direction, status, folder, message_id,
        sender_address, recipients_json, subject, received_at, raw_key, size, quota_bytes
      ) VALUES (?, ?, 'incoming', 'processing', 'inbox', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      mailbox.address,
      incomingMessageId,
      normalizeAddress(message.from),
      JSON.stringify([normalizeAddress(message.to)]),
      subject,
      now,
      rawKey,
      message.rawSize,
      quotaBytes,
    ).run()

    if (!insertResult.meta.changes) {
      await env.MAIL_BUCKET.delete(rawKey)
      await releaseStorage(env.DB, mailbox.userId, quotaBytes)
      return
    }
    inserted = true
    try {
      await archiveIncomingMessage(env, id, raw, now)
    } catch (error) {
      console.error('Unable to archive incoming message', error)
    }

    await env.MAIL_QUEUE.send({ messageId: id })
  } catch (error) {
    if (inserted) {
      await env.DB.prepare(
        `UPDATE messages
            SET status = 'failed', processing_error = ?, updated_at = unixepoch()
          WHERE id = ?`,
      ).bind(error instanceof Error ? error.message : 'Unable to queue message', id).run()
    } else {
      if (rawStored) await env.MAIL_BUCKET.delete(rawKey)
      await releaseStorage(env.DB, mailbox.userId, quotaBytes)
    }
    throw error
  }
}

async function parseMessage(job: ParseJob, env: Env): Promise<void> {
  const record = await env.DB.prepare(
    'SELECT * FROM messages WHERE id = ?',
  ).bind(job.messageId).first<MessageRow>()
  if (!record || record.status === 'ready' || record.status === 'sent') return
  if (!record.raw_key) throw new Error('Raw message key is missing')

  const raw = await env.MAIL_BUCKET.get(record.raw_key)
  if (!raw) throw new Error('Raw message object is missing')

  const parsed = await PostalMime.parse(await raw.arrayBuffer())
  const text = parsed.text?.trim() || stripHtml(parsed.html ?? '').replace(/\s+/g, ' ').trim()
  const html = parsed.html?.trim() ?? ''
  const bodyKey = `bodies/${record.id}.json`
  const body: StoredBody = { text, html }
  await env.MAIL_BUCKET.put(bodyKey, JSON.stringify(body), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  })

  const attachmentStatements: D1PreparedStatement[] = [
    env.DB.prepare('DELETE FROM attachments WHERE message_id = ?').bind(record.id),
  ]
  for (const [index, attachment] of (parsed.attachments ?? []).entries()) {
    const attachmentId = `${record.id}-${index}`
    const attachmentKey = `attachments/${record.id}/${index}`
    const attachmentSize = typeof attachment.content === 'string'
      ? new TextEncoder().encode(attachment.content).byteLength
      : attachment.content.byteLength
    await env.MAIL_BUCKET.put(attachmentKey, attachment.content, {
      httpMetadata: {
        contentType: attachment.mimeType || 'application/octet-stream',
      },
    })
    attachmentStatements.push(env.DB.prepare(
      `INSERT INTO attachments (
        id, message_id, filename, content_type, size, r2_key, content_id, disposition
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      attachmentId,
      record.id,
      attachment.filename || `附件-${index + 1}`,
      attachment.mimeType || 'application/octet-stream',
      attachmentSize,
      attachmentKey,
      attachment.contentId || null,
      attachment.disposition || 'attachment',
    ))
  }

  const parsedDate = parsed.date ? Math.floor(new Date(parsed.date).getTime() / 1000) : NaN
  const sender = addressValue(parsed.from) || record.sender_address
  const senderDisplayName = addressName(parsed.from)
  const subject = parsed.subject?.trim() || record.subject || '无主题'
  const references = referenceValue(parsed.references)

  attachmentStatements.push(env.DB.prepare(
    `UPDATE messages SET
       status = 'ready',
       message_id = COALESCE(?, message_id),
       in_reply_to = ?,
       references_header = ?,
       sender_name = ?,
       sender_address = ?,
       recipients_json = ?,
       cc_json = ?,
       subject = ?,
       preview = ?,
       received_at = ?,
       body_key = ?,
       attachment_count = ?,
       has_html = ?,
       processing_error = NULL,
       updated_at = unixepoch()
     WHERE id = ?`,
  ).bind(
    parsed.messageId?.trim() || null,
    parsed.inReplyTo?.trim() || null,
    references || null,
    senderDisplayName || null,
    sender,
    JSON.stringify(addressList(parsed.to)),
    JSON.stringify(addressList(parsed.cc)),
    subject,
    textPreview(text || subject),
    Number.isFinite(parsedDate) ? parsedDate : record.received_at,
    bodyKey,
    parsed.attachments?.length ?? 0,
    html ? 1 : 0,
    record.id,
  ))

  await env.DB.batch(attachmentStatements)
}

export async function consumeEmailQueue(batch: MessageBatch<ParseJob>, env: Env): Promise<void> {
  await ensureSchema(env.DB)
  for (const message of batch.messages) {
    try {
      await parseMessage(message.body, env)
      message.ack()
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unable to parse message'
      await env.DB.prepare(
        `UPDATE messages
            SET status = 'failed', processing_error = ?, updated_at = unixepoch()
          WHERE id = ?`,
      ).bind(detail.slice(0, 500), message.body.messageId).run()
      message.retry({ delaySeconds: 30 })
    }
  }
}
