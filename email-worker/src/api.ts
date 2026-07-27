import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { applySuperAdminRole, createSessionToken, deleteSession, hashPassword, secretsEqual, sessionFromUser, sessionMaxAge, sessionUser, storeSession, validatePassword } from './auth'
import { attachmentDisposition, clientIp, normalizeEmail, safeJsonArray, validEmail } from './api-helpers'
import { deleteTemporaryAccount, updateAccount } from './account-api'
import { listAuditLogs } from './audit-log-api'
import { writeAudit } from './audit'
import { createDomain, deleteDomain, listDomains, updateDomain } from './domain-api'
import { deploymentCheck, publicSetupRequirements } from './deployment-check'
import { addMailbox, listMailboxes, updateMailbox } from './mailbox-api'
import { listMessages, messageSummary } from './message-list-api'
import { isAllowedOrigin } from './origin-policy'
import { authenticatePassword } from './password-login'
import { publicConfig } from './public-config'
import { externalRegistrationEnabled, registerExternalUser, registrationDomainPolicy, updateExternalRegistration, updateRegistrationDomainPolicy } from './registration-api'
import { registrationProtectionReady } from './registration-security'
import { sendReply } from './reply'
import { ensureSchema } from './schema'
import { mailStatistics } from './statistics-api'
import { syncSuperAdminIdentity } from './super-admin-sync'
import { mailRefreshInterval, remoteImagesEnabled, updateMailRefreshInterval, updateRemoteImagesSetting } from './system-settings'
import { createTemporaryInvite, listTemporaryInvites, registerTemporaryInvite, revokeTemporaryInvite, temporaryInvitePreview } from './temporary-invite-api'
import { authenticateAccessToken, bearerToken, issueDeviceToken, listDevices, refreshDeviceToken, revokeDevice, revokeRefreshToken } from './token-api'
import { createManagedUser, listManagedUsers, updateManagedUser } from './user-admin-api'
import type { AttachmentRow, Env, MessageRow, SessionUser, StoredBody } from './types'

const SESSION_COOKIE = 'omnimail_session'
const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/config',
  '/api/setup',
  '/api/login',
  '/api/register',
  '/api/session',
  '/api/auth/token',
  '/api/auth/token/refresh',
  '/api/auth/token/revoke',
])

type AppContext = {
  Bindings: Env
  Variables: {
    user: SessionUser
    authKind: 'cookie' | 'bearer'
    deviceSessionId?: string
  }
}

const app = new Hono<AppContext>()

function setSessionCookie(context: Parameters<typeof setCookie>[0], env: Env, token: string): void {
  setCookie(context, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE !== 'false',
    sameSite: 'Lax',
    path: '/',
    maxAge: sessionMaxAge,
  })
}

function clearSessionCookie(context: Parameters<typeof deleteCookie>[0], env: Env): void {
  deleteCookie(context, SESSION_COOKIE, {
    secure: env.COOKIE_SECURE !== 'false',
    sameSite: 'Lax',
    path: '/',
  })
}

async function setupComplete(db: D1Database): Promise<boolean> {
  const setting = await db.prepare(
    "SELECT value FROM settings WHERE key = 'setup_complete'",
  ).first<{ value: string }>()
  return setting?.value === '1'
}

function configuredSuperAdminEmail(env: Env): string {
  const email = normalizeEmail(env.SUPER_ADMIN_EMAIL || '')
  return validEmail(email) ? email : ''
}

app.use('*', async (context, next) => {
  const requestOrigin = context.req.header('Origin')
  const originAllowed = isAllowedOrigin(
    requestOrigin,
    context.req.url,
    context.env.APP_ORIGINS,
  )

  if (context.req.method === 'OPTIONS') {
    if (!originAllowed) return context.json({ error: 'Origin is not allowed.' }, 403)
    const response = new Response(null, { status: 204 })
    if (requestOrigin) response.headers.set('Access-Control-Allow-Origin', requestOrigin)
    response.headers.set('Access-Control-Allow-Credentials', 'true')
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    response.headers.set('Access-Control-Max-Age', '86400')
    response.headers.append('Vary', 'Origin')
    return response
  }

  if (!originAllowed) return context.json({ error: 'Origin is not allowed.' }, 403)
  await next()

  if (requestOrigin) context.header('Access-Control-Allow-Origin', requestOrigin)
  context.header('Access-Control-Allow-Credentials', 'true')
  context.header('Vary', 'Origin', { append: true })
  context.header('X-Content-Type-Options', 'nosniff')
  context.header('Referrer-Policy', 'no-referrer')
  context.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  context.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
})

app.use('/api/*', async (context, next) => {
  await ensureSchema(context.env.DB)
  await syncSuperAdminIdentity(context.env, configuredSuperAdminEmail(context.env))
  if (PUBLIC_PATHS.has(context.req.path) || context.req.path.startsWith('/api/invitations/')) {
    await next()
    return
  }

  const authorization = bearerToken(context.req.header('Authorization'))
  if (authorization === null) {
    return context.json({ error: 'Authorization 请求头无效。' }, 401)
  }
  if (authorization) {
    const identity = await authenticateAccessToken(context.env, authorization)
    if (!identity) return context.json({ error: '访问令牌已失效，请刷新或重新登录。' }, 401)
    context.set('user', identity.user)
    context.set('authKind', 'bearer')
    context.set('deviceSessionId', identity.deviceSessionId)
    await next()
    return
  }

  const cookieToken = getCookie(context, SESSION_COOKIE)
  const session = cookieToken ? await sessionUser(context.env.DB, cookieToken) : null
  if (!session) {
    clearSessionCookie(context, context.env)
    return context.json({ error: '请先登录。' }, 401)
  }
  context.set('user', applySuperAdminRole(session, context.env.SUPER_ADMIN_EMAIL))
  context.set('authKind', 'cookie')
  await next()
})

app.get('/api/health', (context) => context.json({ ok: true }))

app.get('/api/config', async (context) => context.json(await publicConfig(context.env)))

app.post('/api/setup', async (context) => {
  if (await setupComplete(context.env.DB)) {
    return context.json({ error: 'OmniMail 已完成初始化。' }, 409)
  }
  if (!context.env.SETUP_TOKEN) {
    return context.json({ error: '请先在 Worker 中配置 SETUP_TOKEN Secret。' }, 503)
  }
  const email = configuredSuperAdminEmail(context.env)
  if (!email) {
    return context.json({ error: '请先在 Worker 中配置有效的 SUPER_ADMIN_EMAIL。' }, 503)
  }

  const body = await context.req.json<{
    displayName?: string
    password?: string
    setupToken?: string
  }>().catch(() => ({} as {
    displayName?: string
    password?: string
    setupToken?: string
  }))
  const displayName = (body.displayName || '').trim()
  const password = body.password || ''
  const passwordError = validatePassword(password)

  if (!displayName || displayName.length > 60) {
    return context.json({ error: '显示名称需要在 1–60 个字符之间。' }, 400)
  }
  if (passwordError) return context.json({ error: passwordError }, 400)
  if (!await secretsEqual(body.setupToken || '', context.env.SETUP_TOKEN)) {
    return context.json({ error: '初始化令牌不正确。' }, 403)
  }

  const userId = crypto.randomUUID()
  const passwordHash = await hashPassword(password)
  try {
    await context.env.DB.batch([
      context.env.DB.prepare(
        "INSERT INTO settings (key, value) VALUES ('setup_complete', '1')",
      ),
      context.env.DB.prepare(
        `INSERT INTO users (
          id, email, display_name, password_hash, role, mailbox_limit,
          can_create_mailboxes, can_reply
        ) VALUES (?, ?, ?, ?, 'super_admin', 100, 1, 1)`,
      ).bind(userId, email, displayName, passwordHash),
    ])
  } catch {
    return context.json({ error: '初始化失败，可能已有管理员账户。' }, 409)
  }

  const token = createSessionToken()
  await storeSession(context.env.DB, userId, token)
  setSessionCookie(context, context.env, token)
  await writeAudit(context.env, userId, 'setup.complete', userId, clientIp(context.req.raw.headers))
  return context.json({
    user: {
      id: userId,
      email,
      displayName,
      role: 'super_admin' as const,
      mailboxLimit: 100,
      canCreateMailboxes: true,
      canReply: true,
      temporaryExpiresAt: null,
    },
  }, 201)
})
app.post('/api/login', async (context) => {
  const body = await context.req.json<{
    email?: string
    password?: string
  }>().catch(() => ({} as { email?: string; password?: string }))
  const ip = clientIp(context.req.raw.headers)
  const result = await authenticatePassword(
    context.env.DB,
    body.email || '',
    body.password || '',
    ip,
  )
  if ('error' in result) {
    await writeAudit(
      context.env,
      null,
      'auth.login_failed',
      result.email || null,
      ip,
      { channel: 'browser', reason: result.reason },
    )
    return context.json({ error: result.error }, result.status)
  }
  const { user, email } = result
  const token = createSessionToken()
  await storeSession(context.env.DB, user.id, token)
  setSessionCookie(context, context.env, token)
  await writeAudit(context.env, user.id, 'auth.login', user.id, ip, { channel: 'browser' })
  return context.json({
    user: applySuperAdminRole(sessionFromUser(user), context.env.SUPER_ADMIN_EMAIL),
  })
})

app.post('/api/register', async (context) => {
  const result = await registerExternalUser(context.env, context.req.raw, clientIp(context.req.raw.headers))
  if (result.sessionToken) setSessionCookie(context, context.env, result.sessionToken)
  return result.response
})
app.post('/api/auth/token', (context) => issueDeviceToken(context.env, context.req.raw))
app.post('/api/auth/token/refresh', (context) => refreshDeviceToken(context.env, context.req.raw))
app.post('/api/auth/token/revoke', (context) => revokeRefreshToken(context.env, context.req.raw))

app.get('/api/session', async (context) => {
  const authorization = bearerToken(context.req.header('Authorization'))
  if (authorization === null) {
    return context.json({ error: 'Authorization 请求头无效。' }, 401)
  }
  if (authorization) {
    const identity = await authenticateAccessToken(context.env, authorization)
    if (!identity) {
      return context.json({ error: '访问令牌已失效，请刷新或重新登录。' }, 401)
    }
    return context.json({ user: identity.user })
  }
  const token = getCookie(context, SESSION_COOKIE)
  const session = token ? await sessionUser(context.env.DB, token) : null
  const user = session
    ? applySuperAdminRole(session, context.env.SUPER_ADMIN_EMAIL)
    : null
  if (!session) clearSessionCookie(context, context.env)
  return context.json({ user })
})

app.post('/api/logout', async (context) => {
  const user = context.get('user')
  const authKind = context.get('authKind')
  if (authKind === 'bearer') {
    await context.env.DB.prepare(
      'UPDATE device_sessions SET revoked_at = unixepoch() WHERE id = ?',
    ).bind(context.get('deviceSessionId')).run()
  } else {
    const token = getCookie(context, SESSION_COOKIE)
    if (token) await deleteSession(context.env.DB, token)
  }
  await writeAudit(
    context.env,
    user.id,
    'auth.logout',
    user.id,
    clientIp(context.req.raw.headers),
    { channel: authKind },
  )
  clearSessionCookie(context, context.env)
  return context.json({ ok: true })
})
app.get('/api/auth/devices', (context) => (
  listDevices(context.env, context.get('user'), context.get('deviceSessionId'))
))
app.delete('/api/auth/devices/:id', (context) => revokeDevice(
  context.env,
  context.get('user'),
  context.req.param('id'),
  clientIp(context.req.raw.headers),
))
app.patch('/api/account', (context) => updateAccount(context.env, context.get('user'), context.req.raw, clientIp(context.req.raw.headers)))
app.delete('/api/account', async (context) => {
  const response = await deleteTemporaryAccount(context.env, context.get('user'), context.req.raw, clientIp(context.req.raw.headers))
  if (response.ok) clearSessionCookie(context, context.env)
  return response
})
app.get('/api/invitations/:token', (context) => temporaryInvitePreview(context.env, context.req.param('token')))
app.post('/api/invitations/:token', (context) => registerTemporaryInvite(context.env, context.req.param('token'), context.req.raw, clientIp(context.req.raw.headers)))
app.get('/api/admin/invites', (context) => listTemporaryInvites(
  context.env,
  context.get('user'),
  context.req.raw,
))
app.post('/api/admin/invites', (context) => createTemporaryInvite(context.env, context.get('user'), context.req.raw, clientIp(context.req.raw.headers)))
app.patch('/api/admin/invites/:id/revoke', (context) => revokeTemporaryInvite(context.env, context.get('user'), context.req.param('id'), clientIp(context.req.raw.headers)))
app.get('/api/admin/statistics', (context) => mailStatistics(context.env, context.get('user'), context.req.raw))
app.get('/api/admin/audit-logs', (context) => listAuditLogs(context.env, context.get('user'), context.req.raw))
app.get('/api/admin/deployment-check', (context) => deploymentCheck(context.env, context.get('user')))
app.get('/api/admin/users', (context) => listManagedUsers(
  context.env,
  context.get('user'),
  configuredSuperAdminEmail(context.env),
  context.req.raw,
))
app.post('/api/admin/users', (context) => createManagedUser(
  context.env,
  context.get('user'),
  configuredSuperAdminEmail(context.env),
  context.req.raw,
  clientIp(context.req.raw.headers),
))
app.patch('/api/admin/settings/registration', (context) => updateExternalRegistration(context.env, context.get('user'), context.req.raw, clientIp(context.req.raw.headers)))
app.patch('/api/admin/settings/registration-domains', (context) => updateRegistrationDomainPolicy(context.env, context.get('user'), context.req.raw, clientIp(context.req.raw.headers)))
app.patch('/api/admin/settings/mail-refresh', (context) => updateMailRefreshInterval(context.env, context.get('user'), context.req.raw, clientIp(context.req.raw.headers)))
app.patch('/api/admin/settings/remote-images', (context) => updateRemoteImagesSetting(context.env, context.get('user'), context.req.raw, clientIp(context.req.raw.headers)))
app.patch('/api/admin/users/:id', (context) => updateManagedUser(
  context.env,
  context.get('user'),
  configuredSuperAdminEmail(context.env),
  context.req.param('id'),
  context.req.raw,
  clientIp(context.req.raw.headers),
))
app.get('/api/domains', (context) => listDomains(context.env, context.get('user')))
app.post('/api/admin/domains', (context) => createDomain(context.env, context.get('user'), context.req.raw, clientIp(context.req.raw.headers)))
app.patch('/api/admin/domains/:name', (context) => updateDomain(context.env, context.get('user'), context.req.param('name'), context.req.raw, clientIp(context.req.raw.headers)))
app.delete('/api/admin/domains/:name', (context) => deleteDomain(context.env, context.get('user'), context.req.param('name'), clientIp(context.req.raw.headers)))
app.get('/api/mailboxes', (context) => (
  listMailboxes(context.env, context.get('user'))
))
app.post('/api/mailboxes', (context) => (
  addMailbox(
    context.env,
    context.get('user'),
    context.req.raw,
    clientIp(context.req.raw.headers),
  )
))
app.patch('/api/mailboxes/:address', (context) => (
  updateMailbox(
    context.env,
    context.get('user'),
    context.req.param('address'),
    context.req.raw,
    clientIp(context.req.raw.headers),
  )
))

app.get('/api/messages', (context) => (
  listMessages(context.env, context.get('user'), context.req.raw)
))

async function ownedMessage(env: Env, userId: string, messageId: string): Promise<MessageRow | null> {
  return env.DB.prepare(
    `SELECT m.*
       FROM messages m
       JOIN mailboxes mb ON mb.address = m.mailbox_address
      WHERE m.id = ? AND mb.user_id = ?`,
  ).bind(messageId, userId).first<MessageRow>()
}

app.get('/api/messages/:id', async (context) => {
  const user = context.get('user')
  const message = await ownedMessage(context.env, user.id, context.req.param('id'))
  if (!message) return context.json({ error: '邮件不存在。' }, 404)

  let body: StoredBody = { text: '', html: '' }
  if (message.body_key) {
    const object = await context.env.MAIL_BUCKET.get(message.body_key)
    if (object) body = await object.json<StoredBody>()
  }
  const { results: attachments } = await context.env.DB.prepare(
    `SELECT id, message_id, filename, content_type, size, r2_key, content_id, disposition
       FROM attachments WHERE message_id = ? ORDER BY id`,
  ).bind(message.id).all<AttachmentRow>()

  return context.json({
    message: {
      ...messageSummary(message),
      messageId: message.message_id,
      inReplyTo: message.in_reply_to,
      references: message.references_header,
      cc: safeJsonArray(message.cc_json),
      text: body.text,
      html: body.html,
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.content_type,
        size: attachment.size,
        disposition: attachment.disposition,
      })),
    },
  })
})

app.patch('/api/messages/:id', async (context) => {
  const user = context.get('user')
  const message = await ownedMessage(context.env, user.id, context.req.param('id'))
  if (!message) return context.json({ error: '邮件不存在。' }, 404)
  const body = await context.req.json<{
    isRead?: boolean
    isStarred?: boolean
    folder?: 'inbox' | 'sent' | 'trash'
  }>().catch(() => ({} as {
    isRead?: boolean
    isStarred?: boolean
    folder?: 'inbox' | 'sent' | 'trash'
  }))
  const allowedFolder = body.folder && ['inbox', 'sent', 'trash'].includes(body.folder)
    ? body.folder
    : message.folder

  await context.env.DB.prepare(
    `UPDATE messages
        SET is_read = ?, is_starred = ?, folder = ?, updated_at = unixepoch()
      WHERE id = ?`,
  ).bind(
    typeof body.isRead === 'boolean' ? Number(body.isRead) : message.is_read,
    typeof body.isStarred === 'boolean' ? Number(body.isStarred) : message.is_starred,
    allowedFolder,
    message.id,
  ).run()
  return context.json({ ok: true })
})

app.delete('/api/messages/:id', async (context) => {
  const user = context.get('user')
  const message = await ownedMessage(context.env, user.id, context.req.param('id'))
  if (!message) return context.json({ error: '邮件不存在。' }, 404)
  if (message.folder !== 'trash') {
    return context.json({ error: '请先将邮件移入垃圾箱。' }, 409)
  }

  const { results: attachments } = await context.env.DB.prepare(
    'SELECT r2_key FROM attachments WHERE message_id = ?',
  ).bind(message.id).all<{ r2_key: string }>()
  const objectKeys = [
    message.raw_key,
    message.body_key,
    ...attachments.map((attachment) => attachment.r2_key),
  ].filter((key): key is string => Boolean(key))
  if (objectKeys.length) await context.env.MAIL_BUCKET.delete(objectKeys)
  await context.env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(message.id).run()
  await writeAudit(context.env, user.id, 'message.delete', message.id, clientIp(context.req.raw.headers))
  return context.json({ ok: true })
})

app.get('/api/messages/:messageId/attachments/:attachmentId', async (context) => {
  const user = context.get('user')
  const row = await context.env.DB.prepare(
    `SELECT a.id, a.message_id, a.filename, a.content_type, a.size, a.r2_key, a.content_id, a.disposition
       FROM attachments a
       JOIN messages m ON m.id = a.message_id
       JOIN mailboxes mb ON mb.address = m.mailbox_address
      WHERE a.id = ? AND a.message_id = ? AND mb.user_id = ?`,
  ).bind(
    context.req.param('attachmentId'),
    context.req.param('messageId'),
    user.id,
  ).first<AttachmentRow>()
  if (!row) return context.json({ error: '附件不存在。' }, 404)

  const object = await context.env.MAIL_BUCKET.get(row.r2_key)
  if (!object) return context.json({ error: '附件文件不存在。' }, 404)
  return new Response(object.body, {
    headers: {
      'Content-Type': row.content_type || 'application/octet-stream',
      'Content-Length': String(row.size),
      'Content-Disposition': attachmentDisposition(row.filename),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

app.get('/api/messages/:id/raw', async (context) => {
  const user = context.get('user')
  const message = await ownedMessage(context.env, user.id, context.req.param('id'))
  if (!message?.raw_key) return context.json({ error: '原始邮件不存在。' }, 404)
  const object = await context.env.MAIL_BUCKET.get(message.raw_key)
  if (!object) return context.json({ error: '原始邮件不存在。' }, 404)
  return new Response(object.body, {
    headers: {
      'Content-Type': 'message/rfc822',
      'Content-Disposition': attachmentDisposition(`${message.subject || 'message'}.eml`),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

app.post('/api/messages/:id/reply', async (context) => {
  const body = await context.req.json<{
    text?: string
    idempotencyKey?: string
  }>().catch(() => ({} as { text?: string; idempotencyKey?: string }))
  return sendReply(
    context.env,
    context.get('user'),
    context.req.param('id'),
    body,
    clientIp(context.req.raw.headers),
  )
})

app.onError((error, context) => {
  console.error(error)
  return context.json({ error: '服务器暂时无法处理这个请求。' }, 500)
})

app.notFound((context) => context.json({ error: '接口不存在。' }, 404))

export const fetchApi = app.fetch
