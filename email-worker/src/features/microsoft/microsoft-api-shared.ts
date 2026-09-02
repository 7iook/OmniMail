import type { Env } from '../../app/types'
import { ImapConnectionError } from '../../platform/imap/imap-errors'
import { MicrosoftInputError } from './microsoft-fields'
import { MicrosoftGraphError } from './microsoft-graph'
import { MicrosoftStoreError } from './microsoft-store'
import { MicrosoftTokenError } from './microsoft-token'
import {
  microsoftAccountStatusForFailure,
  microsoftTransportFailure,
  type MicrosoftTransportFailure,
} from './microsoft-transport-errors'
import type { MicrosoftAuthMode } from './microsoft-types'

export function microsoftPrivateJson(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store', ...headers },
  })
}

const messages: Record<string, string> = {
  invalid_grant: 'Microsoft 授权已失效或 refresh token 与 Client ID 不匹配。',
  invalid_client: 'Microsoft Client ID 无法用于这份 refresh token。',
  invalid_scope: 'Microsoft 授权不包含 Outlook 邮件权限。',
  imap_scope_missing: 'Microsoft token 缺少 Outlook IMAP 权限，请重新授权。',
  graph_scope_missing: 'Microsoft token 缺少 Outlook 邮件（Graph）权限，请重新授权。',
  imap_access_rejected: 'Microsoft 拒绝 IMAP OAuth2 登录；请检查权限或租户是否启用 IMAP。',
  xoauth2_unavailable: 'Microsoft IMAP 未提供 XOAUTH2 认证。',
  basic_auth_rejected: 'Microsoft 拒绝密码 LOGIN；这不是导入格式错误。请改用包含 refresh token 与 Client ID 的 OAuth2 四字段凭据。',
  remote_message_not_found: 'Microsoft 邮件已不存在，请刷新邮件列表。',
  timeout: '连接 Microsoft 邮箱超时，请稍后重试。',
  response_too_large: 'Microsoft 邮箱响应超过安全读取上限。',
  connection_failed: '暂时无法连接 Microsoft 邮箱，请稍后重试。',
  token_endpoint_unavailable: 'Microsoft token 服务暂时不可用，请稍后重试。',
  token_refresh_busy: 'Microsoft token 正在刷新，请稍后重试。',
  graph_credential_rejected: 'Microsoft 拒绝了 Graph 访问令牌，请重新授权。',
  graph_permission_denied: 'Microsoft 授权缺少 Outlook 邮件权限（Graph 403），请重新授权。',
  graph_throttled: 'Microsoft 正在限流这个邮箱，请稍后重试。',
  graph_message_not_found: 'Microsoft 邮件已不存在，请刷新邮件列表。',
  graph_unavailable: 'Microsoft Graph 暂时不可用，请稍后重试。',
  graph_connection_failed: '暂时无法连接 Microsoft Graph，请稍后重试。',
  graph_timeout: '连接 Microsoft Graph 超时，请稍后重试。',
  graph_listing_truncated: 'Microsoft 邮箱列表过大，本次未能完整读取，请稍后重试。',
  graph_invalid_response: 'Microsoft Graph 返回了无法解析的响应。',
  graph_invalid_next_link: 'Microsoft Graph 返回了无法信任的分页链接。',
  graph_invalid_message_id: 'Microsoft 邮件标识无效，请刷新邮件列表。',
  graph_invalid_folder: 'Microsoft 文件夹无法通过 Graph 定位，请刷新文件夹列表。',
  graph_request_failed: 'Microsoft Graph 拒绝了这个请求。',
}

/**
 * The HTTP status we answer with for a classified transport failure.
 *
 * Never 401: the frontend API client treats that as a lost OmniMail session and
 * logs the user out, which is why the pre-Graph IMAP path already downgraded
 * 400/401 to 400. Everything else passes Microsoft's own status through when it
 * is a real HTTP status, and falls back to 502 for protocol-level codes.
 */
function responseStatus(failure: MicrosoftTransportFailure): number {
  switch (failure.category) {
    case 'auth': return 400
    case 'permission': return 403
    case 'throttled': return 429
    default:
      return failure.status >= 400 && failure.status <= 599 && failure.status !== 401
        ? failure.status : 502
  }
}

function transportFailureResponse(
  error: ImapConnectionError | MicrosoftGraphError,
  authMode?: MicrosoftAuthMode,
): Response {
  const failure = microsoftTransportFailure(
    error,
    error instanceof MicrosoftGraphError ? 'graph' : 'imap',
  )
  // Password LOGIN and OAuth2 rejections read identically on the wire; only the
  // credential shape tells the user which advice applies.
  const code = failure.code === 'imap_access_rejected' && authMode === 'password'
    ? 'basic_auth_rejected' : failure.code
  const headers: Record<string, string> = failure.retryAfterSeconds !== null
    ? { 'Retry-After': String(failure.retryAfterSeconds) } : {}
  return microsoftPrivateJson({
    error: messages[code] || messages.connection_failed,
    code,
  }, responseStatus(failure), headers)
}

export function microsoftResponseError(
  error: unknown,
  authMode?: MicrosoftAuthMode,
): Response {
  if (error instanceof MicrosoftInputError) {
    return microsoftPrivateJson({ error: error.message, code: error.code }, 400)
  }
  if (error instanceof MicrosoftStoreError) {
    return microsoftPrivateJson({ error: error.message, code: error.code }, error.status)
  }
  if (error instanceof MicrosoftTokenError) {
    return microsoftPrivateJson({
      error: messages[error.code] || 'Microsoft token 刷新失败。',
      code: error.code,
    }, error.status)
  }
  if (error instanceof ImapConnectionError || error instanceof MicrosoftGraphError) {
    return transportFailureResponse(error, authMode)
  }
  console.error('Microsoft mail request failed', {
    code: microsoftTransportFailure(error, 'graph').code,
    type: error instanceof Error ? error.name : typeof error,
  })
  return microsoftPrivateJson({
    error: 'Microsoft 邮箱暂时无法处理这个请求。',
    code: 'request_failed',
  }, 500)
}

/**
 * Leaves a classified failure on the account row outside the sync lease.
 *
 * Used where a request path — not the scheduler — learns something definitive
 * about the account, such as a 403 on read write-back. Best effort: the remote
 * outcome has already been decided and must not be masked by a D1 hiccup.
 */
export async function recordMicrosoftAccountFailure(
  env: Env,
  accountId: string,
  failure: MicrosoftTransportFailure,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE microsoft_imap_accounts
          SET status = ?, last_error_code = ?, last_error_at = ?, updated_at = ?
        WHERE id = ?`,
    ).bind(microsoftAccountStatusForFailure(failure), failure.code, now, now, accountId).run()
  } catch (error) {
    console.error('Unable to record Microsoft account failure', {
      accountId,
      code: failure.code,
      type: error instanceof Error ? error.name : typeof error,
    })
  }
}

export async function microsoftJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json<unknown>()
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error()
    return body as Record<string, unknown>
  } catch {
    throw new MicrosoftInputError('invalid_json', '请求体必须是 JSON 对象。')
  }
}

export function microsoftName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name.length > 60 || /[\r\n\0]/.test(name)) {
    throw new MicrosoftInputError('invalid_name', '账号名称需要为 1–60 个字符。')
  }
  return name
}

export function maskedMicrosoftEmail(email: string): string {
  const [local, domain] = email.split('@')
  return `${local.slice(0, 2)}***@${domain}`
}
