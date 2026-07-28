import { archiveSentMessage } from './mail-archive'
import { textPreview, textToHtml } from './mail'
import { releaseStorage, reserveStorage } from './message-storage'
import type { Env, SessionUser, StoredBody } from './types'

export type OutboundMessage = {
  mailboxAddress: string
  recipients: string[]
  subject: string
  text: string
  idempotencyKey: string
  inReplyTo?: string | null
  references?: string
  auditAction: 'message.reply' | 'message.send'
  auditDetail: Record<string, unknown>
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

async function auditOutbound(
  env: Env,
  userId: string,
  outboundId: string,
  input: OutboundMessage,
  ip: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_logs (user_id, action, target_id, ip, detail_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(
    userId,
    input.auditAction,
    outboundId,
    ip,
    JSON.stringify(input.auditDetail),
  ).run()
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

export async function sendOutboundMessage(
  env: Env,
  user: SessionUser,
  input: OutboundMessage,
  ip: string,
): Promise<Response> {
  const existing = await env.DB.prepare(
    `SELECT id, status, provider_id FROM messages
      WHERE client_request_id = ? AND mailbox_address = ?`,
  ).bind(input.idempotencyKey, input.mailboxAddress).first<{
    id: string
    status: string
    provider_id: string | null
  }>()
  if (existing) return json({ message: messageResult(existing) })

  const outboundId = crypto.randomUUID()
  const bodyKey = `bodies/${outboundId}.json`
  const storedBody = JSON.stringify({
    text: input.text,
    html: textToHtml(input.text),
  } satisfies StoredBody)
  const quotaBytes = new TextEncoder().encode(storedBody).byteLength
  if (!await reserveStorage(env.DB, user.id, quotaBytes)) {
    return json({ error: '邮箱存储空间已满，请清理邮件后重试。' }, 409)
  }
  const now = Math.floor(Date.now() / 1000)
  const from = env.RESEND_FROM?.trim()
    || `${user.displayName.replace(/[\r\n<>"]/g, '')} <${input.mailboxAddress}>`

  try {
    await env.DB.prepare(
      `INSERT INTO messages (
        id, mailbox_address, direction, status, folder, in_reply_to, references_header,
        sender_name, sender_address, recipients_json, subject, preview, sent_at,
        body_key, size, quota_bytes, has_html, is_read, client_request_id
      ) VALUES (?, ?, 'outgoing', 'processing', 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`,
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
      input.idempotencyKey,
    ).run()
  } catch {
    const duplicate = await env.DB.prepare(
      `SELECT id, status, provider_id FROM messages
        WHERE client_request_id = ? AND mailbox_address = ?`,
    ).bind(input.idempotencyKey, input.mailboxAddress).first<{
      id: string
      status: string
      provider_id: string | null
    }>()
    await releaseStorage(env.DB, user.id, quotaBytes)
    if (duplicate) return json({ message: messageResult(duplicate) })
    return json({ error: '无法创建待发送邮件。' }, 409)
  }

  try {
    await env.MAIL_BUCKET.put(bodyKey, storedBody, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    })
    await archiveSentMessage(env, outboundId, storedBody, now)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unable to store outbound message'
    await env.DB.prepare(
      `UPDATE messages
          SET status = 'failed', processing_error = ?, updated_at = unixepoch()
        WHERE id = ?`,
    ).bind(detail.slice(0, 500), outboundId).run()
    return json({ error: `保存发件失败：${detail}` }, 502)
  }

  const headers: Record<string, string> = {}
  if (input.inReplyTo) headers['In-Reply-To'] = input.inReplyTo
  if (input.references) headers.References = input.references

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `omnimail-${input.idempotencyKey}`,
        'User-Agent': 'OmniMail/0.1',
      },
      body: JSON.stringify({
        from,
        to: input.recipients,
        reply_to: input.mailboxAddress,
        subject: input.subject,
        text: input.text,
        html: textToHtml(input.text),
        headers,
      }),
    })
    const result = await response.json<{ id?: string; message?: string }>()
      .catch(() => ({} as { id?: string; message?: string }))
    if (!response.ok || !result.id) {
      throw new Error(result.message || `Resend returned ${response.status}`)
    }
    await env.DB.prepare(
      `UPDATE messages
          SET status = 'sent', provider_id = ?, updated_at = unixepoch()
        WHERE id = ?`,
    ).bind(result.id, outboundId).run()
    await auditOutbound(env, user.id, outboundId, input, ip)
    return json({
      message: { id: outboundId, status: 'sent', providerId: result.id },
    }, 201)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Resend request failed'
    await env.DB.prepare(
      `UPDATE messages
          SET status = 'failed', processing_error = ?, updated_at = unixepoch()
        WHERE id = ?`,
    ).bind(detail.slice(0, 500), outboundId).run()
    return json({ error: `发送失败：${detail}` }, 502)
  }
}
