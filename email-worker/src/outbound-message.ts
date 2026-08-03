import { archiveSentAttachments, archiveSentMessage } from './mail-archive'
import { textPreview, textToHtml } from './mail'
import { messageSearchStatement } from './message-search'
import { claimOutboundSend } from './outbound-rate-limit'
import { releaseStorage, reserveStorage } from './message-storage'
import { reconcileResendEvents } from './resend-webhook'
import { resendConfigForAddress } from './resend-config'
import type { Env, OutboundJob, SessionUser, StoredBody } from './types'

export type OutboundMessage = {
  mailboxAddress: string
  recipients: string[]
  subject: string
  text: string
  idempotencyKey: string
  inReplyTo?: string | null
  references?: string
  attachments?: OutboundAttachment[]
  draftUserId?: string
  auditAction: 'message.reply' | 'message.send'
  auditDetail: Record<string, unknown>
}

export type OutboundAttachment = {
  id: string
  filename: string
  contentType: string
  size: number
  r2Key: string
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function auditOutboundStatement(
  env: Env,
  userId: string,
  outboundId: string,
  input: OutboundMessage,
  ip: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO audit_logs (user_id, action, target_id, ip, detail_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(
    userId,
    input.auditAction,
    outboundId,
    ip,
    JSON.stringify(input.auditDetail),
  )
}

function messageResult(row: {
  id: string
  status: string
  provider_id: string | null
}) {
  return {
    id: row.id,
    status: row.status,
    providerId: row.provider_id || undefined,
  }
}

export class OutboundDeliveryError extends Error {
  retryable: boolean

  constructor(message: string, retryable = true) {
    super(message)
    this.name = 'OutboundDeliveryError'
    this.retryable = retryable
  }
}

export function arrayBufferToBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

async function queueOutbound(
  env: Env,
  messageId: string,
  userId: string,
  input: OutboundMessage,
  ip: string,
): Promise<void> {
  await env.MAIL_QUEUE.send({
    kind: 'outbound',
    messageId,
    userId,
    ip,
    auditAction: input.auditAction,
    auditDetail: input.auditDetail,
  })
}

export async function requeueFailedOutbound(
  env: Env,
  messageId: string,
  userId: string,
  ip: string,
  auditAction: OutboundJob['auditAction'],
  auditDetail: Record<string, unknown>,
): Promise<Response> {
  await env.DB.prepare(
    `UPDATE messages
        SET status = 'processing', processing_error = NULL, updated_at = unixepoch()
      WHERE id = ? AND status = 'failed'`,
  ).bind(messageId).run()
  try {
    await env.MAIL_QUEUE.send({
      kind: 'outbound',
      messageId,
      userId,
      ip,
      auditAction,
      auditDetail,
    })
    return json({ message: { id: messageId, status: 'processing' } }, 202)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unable to queue outbound message'
    await env.DB.prepare(
      `UPDATE messages SET status = 'failed', processing_error = ?,
          last_failed_at = unixepoch(), updated_at = unixepoch() WHERE id = ?`,
    ).bind(detail.slice(0, 500), messageId).run()
    return json({ error: '发送任务暂时无法入队，请稍后重试。' }, 503)
  }
}

export async function sendOutboundMessage(
  env: Env,
  user: SessionUser,
  input: OutboundMessage,
  ip: string,
): Promise<Response> {
  const existing = await env.DB.prepare(
    `SELECT id, status, provider_id, body_key FROM messages
      WHERE client_request_id = ? AND mailbox_address = ?`,
  ).bind(input.idempotencyKey, input.mailboxAddress).first<{
    id: string
    status: string
    provider_id: string | null
    body_key: string | null
  }>()
  if (existing) {
    if (existing.status === 'failed' && existing.body_key) {
      return requeueFailedOutbound(
        env,
        existing.id,
        user.id,
        ip,
        input.auditAction,
        input.auditDetail,
      )
    }
    return json(
      { message: messageResult(existing) },
      existing.status === 'sent' ? 200 : 202,
    )
  }

  const rateLimit = await claimOutboundSend(env.DB, user.id)
  if (!rateLimit.allowed) {
    return Response.json(
      { error: '发信过于频繁，请稍后再试。' },
      {
        status: 429,
        headers: { 'Retry-After': String(rateLimit.retryAfter) },
      },
    )
  }

  const outboundId = crypto.randomUUID()
  const bodyKey = `bodies/${outboundId}.json`
  const storedBody = JSON.stringify({
    text: input.text,
    html: textToHtml(input.text),
  } satisfies StoredBody)
  const bodyBytes = new TextEncoder().encode(storedBody).byteLength
  const attachments = input.attachments ?? []
  const attachmentBytes = attachments.reduce((total, attachment) => total + attachment.size, 0)
  const quotaBytes = bodyBytes + attachmentBytes
  const reserveBytes = input.draftUserId ? bodyBytes : quotaBytes
  if (!await reserveStorage(env.DB, user.id, reserveBytes)) {
    return json({ error: '邮箱存储空间已满，请清理邮件后重试。' }, 409)
  }
  const now = Math.floor(Date.now() / 1000)

  try {
    await env.MAIL_BUCKET.put(bodyKey, storedBody, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unable to store outbound message'
    await releaseStorage(env.DB, user.id, reserveBytes)
    return json({ error: `保存发件失败：${detail}` }, 502)
  }

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO messages (
        id, mailbox_address, direction, status, folder, in_reply_to, references_header,
        sender_name, sender_address, recipients_json, subject, preview, sent_at,
        body_key, size, quota_bytes, stored_bytes, attachment_count, has_html, is_read,
        client_request_id, delivery_status
      ) VALUES (?, ?, 'outgoing', 'processing', 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 'queued')`,
    ).bind(
      outboundId,
      input.mailboxAddress,
      input.inReplyTo || null,
      input.references || null,
      user.displayName,
      input.mailboxAddress,
      JSON.stringify(input.recipients),
      input.subject,
      textPreview(input.text),
      now,
      bodyKey,
      quotaBytes,
      quotaBytes,
      quotaBytes,
      attachments.length,
      input.idempotencyKey,
    ),
    ...attachments.map((attachment) => env.DB.prepare(
      `INSERT INTO attachments (
         id, message_id, filename, content_type, size, r2_key, disposition
       ) VALUES (?, ?, ?, ?, ?, ?, 'attachment')`,
    ).bind(
      attachment.id,
      outboundId,
      attachment.filename,
      attachment.contentType,
      attachment.size,
      attachment.r2Key,
    )),
    messageSearchStatement(env.DB, outboundId, {
      subject: input.subject,
      sender: input.mailboxAddress,
      recipients: input.recipients,
      body: input.text,
    }),
  ]
  if (input.draftUserId) {
    statements.push(
      env.DB.prepare('DELETE FROM draft_attachments WHERE user_id = ?')
        .bind(input.draftUserId),
      env.DB.prepare('DELETE FROM drafts WHERE user_id = ?')
        .bind(input.draftUserId),
    )
  }
  try {
    await env.DB.batch(statements)
  } catch {
    const duplicate = await env.DB.prepare(
      `SELECT id, status, provider_id FROM messages
        WHERE client_request_id = ? AND mailbox_address = ?`,
    ).bind(input.idempotencyKey, input.mailboxAddress).first<{
      id: string
      status: string
      provider_id: string | null
    }>()
    await env.MAIL_BUCKET.delete(bodyKey).catch((error) => {
      console.error('Unable to remove unused outbound body', error)
    })
    await releaseStorage(env.DB, user.id, reserveBytes)
    if (duplicate) return json({ message: messageResult(duplicate) })
    return json({ error: '无法创建待发送邮件。' }, 409)
  }

  try {
    await archiveSentMessage(env, outboundId, storedBody, now)
    await archiveSentAttachments(env, outboundId, attachments, now)
  } catch (error) {
    console.error('Unable to archive outbound message', error)
  }

  try {
    await queueOutbound(env, outboundId, user.id, input, ip)
    return json({ message: { id: outboundId, status: 'processing' } }, 202)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unable to queue outbound message'
    await env.DB.prepare(
      `UPDATE messages
          SET status = 'failed', processing_error = ?, last_failed_at = unixepoch(),
              updated_at = unixepoch()
        WHERE id = ?`,
    ).bind(detail.slice(0, 500), outboundId).run()
    return json({ error: '发送任务暂时无法入队，请稍后重试。' }, 503)
  }
}

type OutboundRecord = {
  id: string
  status: string
  mailbox_address: string
  sender_name: string | null
  recipients_json: string
  subject: string
  body_key: string | null
  in_reply_to: string | null
  references_header: string | null
  client_request_id: string | null
  domain_is_active: number
}

export async function deliverOutboundMessage(env: Env, job: OutboundJob): Promise<void> {
  const record = await env.DB.prepare(
    `SELECT id, status, mailbox_address, sender_name, recipients_json, subject,
            body_key, in_reply_to, references_header, client_request_id,
            EXISTS (
              SELECT 1 FROM domains d
               WHERE d.name = LOWER(SUBSTR(messages.mailbox_address,
                 INSTR(messages.mailbox_address, '@') + 1))
                 AND d.is_active = 1
            ) AS domain_is_active
       FROM messages WHERE id = ? AND direction = 'outgoing'`,
  ).bind(job.messageId).first<OutboundRecord>()
  if (!record || record.status === 'sent') return
  if (!record.domain_is_active) {
    throw new OutboundDeliveryError('Outbound mailbox domain is disabled', false)
  }
  const resendConfig = resendConfigForAddress(env, record.mailbox_address)
  if (!resendConfig) {
    throw new OutboundDeliveryError('Resend is not configured for the outbound domain', false)
  }
  if (!record.body_key || !record.client_request_id) {
    throw new OutboundDeliveryError('Outbound message body is missing', false)
  }
  const stored = await env.MAIL_BUCKET.get(record.body_key)
  if (!stored) throw new OutboundDeliveryError('Outbound message body object is missing', false)
  let body: StoredBody
  let recipients: unknown
  try {
    body = await stored.json<StoredBody>()
    recipients = JSON.parse(record.recipients_json) as unknown
  } catch {
    throw new OutboundDeliveryError('Outbound message data is invalid', false)
  }
  if (!Array.isArray(recipients) || !recipients.every((value) => typeof value === 'string')) {
    throw new OutboundDeliveryError('Outbound recipients are invalid', false)
  }
  const { results: attachmentRows } = await env.DB.prepare(
    `SELECT filename, r2_key FROM attachments
      WHERE message_id = ? ORDER BY id`,
  ).bind(record.id).all<{ filename: string; r2_key: string }>()
  const attachments = await Promise.all(attachmentRows.map(async (attachment) => {
    const object = await env.MAIL_BUCKET.get(attachment.r2_key)
    if (!object) {
      throw new OutboundDeliveryError(
        `Outbound attachment is missing: ${attachment.filename}`,
        false,
      )
    }
    return {
      filename: attachment.filename,
      content: arrayBufferToBase64(await object.arrayBuffer()),
    }
  }))
  const from = resendConfig.from
    || `${(record.sender_name || record.mailbox_address).replace(/[\r\n<>"]/g, '')} <${record.mailbox_address}>`
  const headers: Record<string, string> = {}
  if (record.in_reply_to) headers['In-Reply-To'] = record.in_reply_to
  if (record.references_header) headers.References = record.references_header
  let response: Response
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendConfig.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `omnimail-${record.client_request_id}`,
        'User-Agent': 'OmniMail/0.1',
      },
      body: JSON.stringify({
        from,
        to: recipients,
        reply_to: record.mailbox_address,
        subject: record.subject,
        text: body.text,
        html: body.html,
        attachments: attachments.length ? attachments : undefined,
        headers,
      }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new OutboundDeliveryError(
      error instanceof Error ? error.message : 'Resend request failed',
    )
  }
  const result = await response.json<{ id?: string; message?: string }>()
    .catch(() => ({} as { id?: string; message?: string }))
  if (!response.ok || !result.id) {
    throw new OutboundDeliveryError(
      result.message || `Resend returned ${response.status}`,
      response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
    )
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE messages
        SET status = 'sent', provider_id = ?, delivery_status = 'sent',
            processing_error = NULL, updated_at = unixepoch()
      WHERE id = ?`,
    ).bind(result.id, record.id),
    auditOutboundStatement(env, job.userId, record.id, {
      mailboxAddress: record.mailbox_address,
      recipients,
      subject: record.subject,
      text: body.text,
      idempotencyKey: record.client_request_id,
      inReplyTo: record.in_reply_to,
      references: record.references_header || undefined,
      auditAction: job.auditAction,
      auditDetail: job.auditDetail,
    }, job.ip),
  ])
  await reconcileResendEvents(env, result.id, record.id)
}
