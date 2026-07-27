import { replySubject, textPreview, textToHtml } from './mail'
import type { Env, MessageRow, SessionUser, StoredBody } from './types'

type ReplyInput = {
  text?: string
  idempotencyKey?: string
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254
}

async function ownedMessage(
  env: Env,
  userId: string,
  messageId: string,
): Promise<MessageRow | null> {
  return env.DB.prepare(
    `SELECT m.*
       FROM messages m
       JOIN mailboxes mb ON mb.address = m.mailbox_address
      WHERE m.id = ? AND mb.user_id = ?`,
  ).bind(messageId, userId).first<MessageRow>()
}

async function auditReply(
  env: Env,
  userId: string,
  outboundId: string,
  originalId: string,
  ip: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_logs (user_id, action, target_id, ip, detail_json)
     VALUES (?, 'message.reply', ?, ?, ?)`,
  ).bind(userId, outboundId, ip, JSON.stringify({ originalId })).run()
}

export async function sendReply(
  env: Env,
  user: SessionUser,
  messageId: string,
  input: ReplyInput,
  ip: string,
): Promise<Response> {
  if (user.role !== 'super_admin' && !user.canReply) {
    return json({ error: '当前账户没有回信权限。' }, 403)
  }
  if (!env.RESEND_API_KEY) {
    return json({ error: '管理员尚未配置 Resend。' }, 503)
  }

  const text = input.text?.trim() || ''
  const idempotencyKey = input.idempotencyKey?.trim() || ''
  if (!text || text.length > 50_000) {
    return json({ error: '回复内容需要在 1–50,000 个字符之间。' }, 400)
  }
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(idempotencyKey)) {
    return json({ error: '无效的请求标识。' }, 400)
  }

  const original = await ownedMessage(env, user.id, messageId)
  if (!original) return json({ error: '邮件不存在。' }, 404)
  if (original.direction !== 'incoming' || !validEmail(original.sender_address)) {
    return json({ error: '这封邮件无法回复。' }, 409)
  }

  const existing = await env.DB.prepare(
    `SELECT id, status, provider_id FROM messages
      WHERE client_request_id = ? AND mailbox_address = ?`,
  ).bind(idempotencyKey, original.mailbox_address).first<{
    id: string
    status: string
    provider_id: string | null
  }>()
  if (existing) return json({ message: existing })

  const outboundId = crypto.randomUUID()
  const bodyKey = `bodies/${outboundId}.json`
  const subject = replySubject(original.subject)
  const now = Math.floor(Date.now() / 1000)
  const references = [original.references_header, original.message_id].filter(Boolean).join(' ')
  const from = env.RESEND_FROM?.trim()
    || `${user.displayName.replace(/[<>"]/g, '')} <${original.mailbox_address}>`

  try {
    await env.DB.prepare(
      `INSERT INTO messages (
        id, mailbox_address, direction, status, folder, in_reply_to, references_header,
        sender_name, sender_address, recipients_json, subject, preview, sent_at,
        body_key, has_html, is_read, client_request_id
      ) VALUES (?, ?, 'outgoing', 'processing', 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`,
    ).bind(
      outboundId,
      original.mailbox_address,
      original.message_id,
      references || null,
      user.displayName,
      original.mailbox_address,
      JSON.stringify([original.sender_address]),
      subject,
      textPreview(text),
      now,
      bodyKey,
      idempotencyKey,
    ).run()
  } catch {
    const duplicate = await env.DB.prepare(
      'SELECT id, status, provider_id FROM messages WHERE client_request_id = ?',
    ).bind(idempotencyKey).first()
    if (duplicate) return json({ message: duplicate })
    return json({ error: '无法创建回复。' }, 409)
  }

  await env.MAIL_BUCKET.put(
    bodyKey,
    JSON.stringify({ text, html: textToHtml(text) } satisfies StoredBody),
    { httpMetadata: { contentType: 'application/json; charset=utf-8' } },
  )

  const headers: Record<string, string> = {}
  if (original.message_id) headers['In-Reply-To'] = original.message_id
  if (references) headers.References = references

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `omnimail-${idempotencyKey}`,
      },
      body: JSON.stringify({
        from,
        to: [original.sender_address],
        reply_to: original.mailbox_address,
        subject,
        text,
        html: textToHtml(text),
        headers,
      }),
    })
    const result = await response.json<{
      id?: string
      message?: string
    }>().catch(() => ({} as { id?: string; message?: string }))
    if (!response.ok || !result.id) {
      throw new Error(result.message || `Resend returned ${response.status}`)
    }

    await env.DB.prepare(
      `UPDATE messages
          SET status = 'sent', provider_id = ?, updated_at = unixepoch()
        WHERE id = ?`,
    ).bind(result.id, outboundId).run()
    await auditReply(env, user.id, outboundId, original.id, ip)
    return json({ message: { id: outboundId, status: 'sent', providerId: result.id } }, 201)
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
