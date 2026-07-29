import { normalizeEmail, validEmail } from './api-helpers'
import { reserveStorage } from './message-storage'
import {
  requeueFailedOutbound,
  sendOutboundMessage,
  type OutboundAttachment,
} from './outbound-message'
import { validateNewMessage } from './send-message'
import type { Env, SessionUser } from './types'

export const MAX_DRAFT_ATTACHMENTS = 5
export const MAX_DRAFT_ATTACHMENT_BYTES = 5 * 1024 * 1024
export const MAX_DRAFT_TOTAL_BYTES = 10 * 1024 * 1024

type DraftInput = {
  mailboxAddress?: string
  to?: string
  subject?: string
  text?: string
}

type ValidDraft = {
  mailboxAddress: string
  to: string
  subject: string
  text: string
}

type DraftRow = {
  user_id: string
  mailbox_address: string
  recipient_address: string
  subject: string
  body_text: string
  updated_at: number
}

type DraftAttachmentRow = {
  id: string
  user_id: string
  filename: string
  content_type: string
  size: number
  r2_key: string
  created_at: number
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function canCompose(user: SessionUser): boolean {
  return user.role === 'super_admin' || user.role === 'admin' || user.canReply
}

export function normalizeDraftFilename(value: string): string {
  return value.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 255) || 'attachment'
}

export function validateDraftInput(
  input: DraftInput,
): { value: ValidDraft; error?: never } | { error: string; value?: never } {
  const mailboxAddress = normalizeEmail(input.mailboxAddress || '')
  const to = normalizeEmail(input.to || '')
  const subject = input.subject?.trim() || ''
  const text = input.text?.trim() || ''
  if (!validEmail(mailboxAddress)) return { error: '发件邮箱格式无效。' }
  if (to.length > 254 || /[\r\n]/.test(input.to || '')) {
    return { error: '草稿收件人不能超过 254 个字符或包含换行。' }
  }
  if (subject.length > 500 || /[\r\n]/.test(subject)) {
    return { error: '草稿主题不能超过 500 个字符。' }
  }
  if (text.length > 50_000) return { error: '草稿正文不能超过 50,000 个字符。' }
  return { value: { mailboxAddress, to, subject, text } }
}

function attachmentJson(row: DraftAttachmentRow) {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
  }
}

async function draftAttachments(env: Env, userId: string): Promise<DraftAttachmentRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, user_id, filename, content_type, size, r2_key, created_at
       FROM draft_attachments WHERE user_id = ? ORDER BY created_at, id`,
  ).bind(userId).all<DraftAttachmentRow>()
  return results
}

async function activeOwnedMailbox(
  env: Env,
  userId: string,
  address: string,
): Promise<boolean> {
  const domain = address.slice(address.lastIndexOf('@') + 1)
  const row = await env.DB.prepare(
    `SELECT 1 AS available FROM mailboxes
      WHERE address = ? AND user_id = ? AND is_active = 1 AND is_hidden = 0
        AND EXISTS (
          SELECT 1 FROM domains d WHERE d.name = ? AND d.is_active = 1
        )`,
  ).bind(address, userId, domain).first<{ available: number }>()
  return Boolean(row)
}

export async function getDraft(env: Env, user: SessionUser): Promise<Response> {
  if (!canCompose(user)) return json({ error: '当前账户没有发信权限。' }, 403)
  const draft = await env.DB.prepare(
    `SELECT user_id, mailbox_address, recipient_address, subject, body_text, updated_at
       FROM drafts WHERE user_id = ?`,
  ).bind(user.id).first<DraftRow>()
  if (!draft) return json({ draft: null })
  return json({
    draft: {
      mailboxAddress: draft.mailbox_address,
      to: draft.recipient_address,
      subject: draft.subject,
      text: draft.body_text,
      updatedAt: draft.updated_at * 1000,
      attachments: (await draftAttachments(env, user.id)).map(attachmentJson),
    },
  })
}

export async function saveDraft(
  env: Env,
  user: SessionUser,
  request: Request,
): Promise<Response> {
  if (!canCompose(user)) return json({ error: '当前账户没有发信权限。' }, 403)
  const input = await request.json<DraftInput>().catch(() => ({} as DraftInput))
  const validated = validateDraftInput(input)
  if ('error' in validated) return json({ error: validated.error }, 400)
  const draft = validated.value
  if (!await activeOwnedMailbox(env, user.id, draft.mailboxAddress)) {
    return json({ error: '发件邮箱不存在或已停用。' }, 404)
  }
  await env.DB.prepare(
    `INSERT INTO drafts (
       user_id, mailbox_address, recipient_address, subject, body_text, updated_at
     ) VALUES (?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(user_id) DO UPDATE SET
       mailbox_address = excluded.mailbox_address,
       recipient_address = excluded.recipient_address,
       subject = excluded.subject,
       body_text = excluded.body_text,
       updated_at = excluded.updated_at`,
  ).bind(user.id, draft.mailboxAddress, draft.to, draft.subject, draft.text).run()
  return getDraft(env, user)
}

export async function uploadDraftAttachment(
  env: Env,
  user: SessionUser,
  request: Request,
): Promise<Response> {
  if (!canCompose(user)) return json({ error: '当前账户没有发信权限。' }, 403)
  const draft = await env.DB.prepare(
    'SELECT user_id FROM drafts WHERE user_id = ?',
  ).bind(user.id).first<{ user_id: string }>()
  if (!draft) return json({ error: '请先保存草稿。' }, 409)
  const form = await request.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File) || file.size <= 0) {
    return json({ error: '请选择要上传的附件。' }, 400)
  }
  if (file.size > MAX_DRAFT_ATTACHMENT_BYTES) {
    return json({ error: '单个附件不能超过 5 MiB。' }, 413)
  }
  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes
       FROM draft_attachments WHERE user_id = ?`,
  ).bind(user.id).first<{ count: number; bytes: number }>()
  if ((total?.count || 0) >= MAX_DRAFT_ATTACHMENTS) {
    return json({ error: '一封邮件最多添加 5 个附件。' }, 409)
  }
  if ((total?.bytes || 0) + file.size > MAX_DRAFT_TOTAL_BYTES) {
    return json({ error: '附件总大小不能超过 10 MiB。' }, 413)
  }
  if (!await reserveStorage(env.DB, user.id, file.size)) {
    return json({ error: '邮箱存储空间已满，请清理邮件后重试。' }, 409)
  }
  const id = crypto.randomUUID()
  const key = `drafts/${user.id}/${id}`
  const filename = normalizeDraftFilename(file.name)
  const contentType = file.type && file.type.length <= 100 && !/[\r\n]/.test(file.type)
    ? file.type
    : 'application/octet-stream'
  try {
    await env.MAIL_BUCKET.put(key, file, {
      httpMetadata: { contentType },
      customMetadata: { filename, userId: user.id },
    })
    await env.DB.prepare(
      `INSERT INTO draft_attachments (
         id, user_id, filename, content_type, size, r2_key
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(id, user.id, filename, contentType, file.size, key).run()
  } catch (error) {
    await env.MAIL_BUCKET.delete(key).catch(() => undefined)
    await env.DB.prepare(
      `UPDATE users SET storage_used_bytes = MAX(0, storage_used_bytes - ?)
        WHERE id = ?`,
    ).bind(file.size, user.id).run()
    throw error
  }
  return json({ attachment: attachmentJson({
    id,
    user_id: user.id,
    filename,
    content_type: contentType,
    size: file.size,
    r2_key: key,
    created_at: Math.floor(Date.now() / 1000),
  }) }, 201)
}

export async function deleteDraftAttachment(
  env: Env,
  user: SessionUser,
  attachmentId: string,
): Promise<Response> {
  const attachment = await env.DB.prepare(
    `SELECT id, user_id, filename, content_type, size, r2_key, created_at
       FROM draft_attachments WHERE id = ? AND user_id = ?`,
  ).bind(attachmentId, user.id).first<DraftAttachmentRow>()
  if (!attachment) return json({ error: '草稿附件不存在。' }, 404)
  await env.MAIL_BUCKET.delete(attachment.r2_key)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM draft_attachments WHERE id = ?').bind(attachment.id),
    env.DB.prepare(
      `UPDATE users SET storage_used_bytes = MAX(0, storage_used_bytes - ?),
        updated_at = unixepoch() WHERE id = ?`,
    ).bind(attachment.size, user.id),
  ])
  return json({ ok: true })
}

export async function discardDraft(env: Env, user: SessionUser): Promise<Response> {
  await purgeUserDraft(env, user.id)
  return json({ ok: true })
}

export async function purgeUserDraft(env: Env, userId: string): Promise<void> {
  const attachments = await draftAttachments(env, userId)
  if (attachments.length) {
    await env.MAIL_BUCKET.delete(attachments.map((attachment) => attachment.r2_key))
  }
  const bytes = attachments.reduce((total, attachment) => total + attachment.size, 0)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM drafts WHERE user_id = ?').bind(userId),
    env.DB.prepare(
      `UPDATE users SET storage_used_bytes = MAX(0, storage_used_bytes - ?),
        updated_at = unixepoch() WHERE id = ?`,
    ).bind(bytes, userId),
  ])
}

export async function sendDraft(
  env: Env,
  user: SessionUser,
  request: Request,
  ip: string,
): Promise<Response> {
  if (!canCompose(user)) return json({ error: '当前账户没有发信权限。' }, 403)
  if (!env.RESEND_API_KEY?.trim()) return json({ error: '管理员尚未配置 Resend。' }, 503)
  const body = await request.json<{ idempotencyKey?: string }>()
    .catch(() => ({} as { idempotencyKey?: string }))
  const idempotencyKey = body.idempotencyKey?.trim() || ''
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(idempotencyKey)) {
    return json({ error: '无效的请求标识。' }, 400)
  }
  const existing = await env.DB.prepare(
    `SELECT m.id, m.status, m.provider_id, m.body_key
       FROM messages m
       JOIN mailboxes mb ON mb.address = m.mailbox_address
      WHERE m.client_request_id = ? AND mb.user_id = ?`,
  ).bind(idempotencyKey, user.id).first<{
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
        'message.send',
        { retried: true },
      )
    }
    return json({ message: {
      id: existing.id,
      status: existing.status,
      providerId: existing.provider_id || undefined,
    } }, existing.status === 'sent' ? 200 : 202)
  }
  const draft = await env.DB.prepare(
    `SELECT user_id, mailbox_address, recipient_address, subject, body_text, updated_at
       FROM drafts WHERE user_id = ?`,
  ).bind(user.id).first<DraftRow>()
  if (!draft) return json({ error: '草稿不存在。' }, 404)
  const validated = validateNewMessage({
    mailboxAddress: draft.mailbox_address,
    to: draft.recipient_address,
    subject: draft.subject,
    text: draft.body_text,
    idempotencyKey,
  })
  if ('error' in validated) return json({ error: validated.error }, 400)
  if (!await activeOwnedMailbox(env, user.id, draft.mailbox_address)) {
    return json({ error: '发件邮箱不存在或已停用。' }, 404)
  }
  const attachments: OutboundAttachment[] = (await draftAttachments(env, user.id)).map((item) => ({
    id: item.id,
    filename: item.filename,
    contentType: item.content_type,
    size: item.size,
    r2Key: item.r2_key,
  }))
  const message = validated.value
  return sendOutboundMessage(env, user, {
    mailboxAddress: message.mailboxAddress,
    recipients: [message.to],
    subject: message.subject,
    text: message.text,
    idempotencyKey: message.idempotencyKey,
    attachments,
    draftUserId: user.id,
    auditAction: 'message.send',
    auditDetail: { recipient: message.to, attachmentCount: attachments.length },
  }, ip)
}
