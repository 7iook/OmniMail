import type { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import type { AppContext } from '../context'
import { clearSessionCookie, SESSION_COOKIE } from '../session-cookies'
import { configuredSuperAdminEmail } from '../super-admin'
import { applySuperAdminRole, sessionUser } from '../../features/auth/session/auth'
import { syncSuperAdminIdentity } from '../../features/auth/account/super-admin-sync'
import { authenticateAccessToken, bearerToken } from '../../features/auth/tokens/token-api'
import { deviceScopesAllow } from '../../features/auth/tokens/token-scope'
import { officialExtensionEnabled } from '../../features/admin/settings/system-settings'
import {
  MICROSOFT_GRAPH_LIFECYCLE_PATH,
  MICROSOFT_GRAPH_NOTIFICATION_PATH,
} from '../../features/microsoft/microsoft-graph-notifications'
import { ensureSchema } from '../../platform/d1/schema'
import { isAllowedOrigin, isOfficialChromeExtensionOrigin } from './origin-policy'

const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/config',
  '/api/setup',
  '/api/login',
  '/api/login/mfa',
  '/api/register',
  '/api/session',
  '/api/auth/token',
  '/api/auth/token/refresh',
  '/api/auth/token/revoke',
  '/api/auth/extension/exchange',
  '/api/auth/linux-do',
  '/api/auth/linux-do/callback',
  '/api/webhooks/resend',
  MICROSOFT_GRAPH_NOTIFICATION_PATH,
  MICROSOFT_GRAPH_LIFECYCLE_PATH,
])

/**
 * Paths that must reach their handler without any D1 access from this
 * middleware stack (card C-6 branch 1: the handshake echoes the token and
 * touches nothing else). `/api/health` shares the same need for a cheap
 * liveness check; the two Graph paths need it for both handshake and
 * notification requests, since their own handlers already do their own
 * targeted D1 reads and schema is guaranteed by every other request plus
 * cron (review3 #1).
 */
const SCHEMA_BYPASS_PATHS = new Set([
  '/api/health',
  MICROSOFT_GRAPH_NOTIFICATION_PATH,
  MICROSOFT_GRAPH_LIFECYCLE_PATH,
])

export function registerMiddleware(app: Hono<AppContext>): void {
app.use('*', async (context, next) => {
  const requestOrigin = context.req.header('Origin')
  const officialEnabled = isOfficialChromeExtensionOrigin(requestOrigin)
    ? await officialExtensionEnabled(context.env.DB)
    : false
  const originAllowed = isAllowedOrigin(
    requestOrigin,
    context.req.url,
    context.env.APP_ORIGINS,
    officialEnabled,
  )

  if (context.req.method === 'OPTIONS') {
    if (!originAllowed) return context.json({ error: 'Origin is not allowed.' }, 403)
    const response = new Response(null, { status: 204 })
    if (requestOrigin) response.headers.set('Access-Control-Allow-Origin', requestOrigin)
    response.headers.set('Access-Control-Allow-Credentials', 'true')
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
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
  context.header('Content-Security-Policy', context.res.headers.get('Content-Security-Policy') ?? "default-src 'none'; frame-ancestors 'none'")
})

app.use('/api/*', async (context, next) => {
  if (SCHEMA_BYPASS_PATHS.has(context.req.path)) {
    await next()
    return
  }
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
    if (!await deviceScopesAllow(identity.scopes, context.req.raw)) {
      return context.json({ error: '当前设备令牌没有执行此操作的权限。' }, 403)
    }
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
}
