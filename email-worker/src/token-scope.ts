export const FULL_DEVICE_SCOPES = '*'
export const EXTENSION_DEVICE_SCOPES = [
  'domains:read',
  'mailboxes:read',
  'mailboxes:create',
  'messages:read',
  'messages:mark-read',
  'icloud:accounts:read',
  'icloud:aliases:read',
  'icloud:aliases:create',
  'icloud:messages:read',
].join(' ')

function hasScope(scopes: string, required: string): boolean {
  if (scopes === FULL_DEVICE_SCOPES) return true
  return scopes.split(/\s+/).includes(required)
}

async function markReadRequest(request: Request): Promise<boolean> {
  const body = await request.clone().json<Record<string, unknown>>().catch(() => null)
  return Boolean(
    body
    && Object.keys(body).length === 1
    && body.isRead === true,
  )
}

export async function deviceScopesAllow(scopes: string, request: Request): Promise<boolean> {
  if (scopes === FULL_DEVICE_SCOPES) return true
  const requestMethod = request.method.toUpperCase()
  const path = new URL(request.url).pathname
  if (requestMethod === 'GET' && path === '/api/domains') {
    return hasScope(scopes, 'domains:read')
  }
  if (path === '/api/mailboxes') {
    if (requestMethod === 'GET') return hasScope(scopes, 'mailboxes:read')
    if (requestMethod === 'POST') return hasScope(scopes, 'mailboxes:create')
  }
  if (requestMethod === 'GET' && /^\/api\/messages(?:\/[^/]+)?$/.test(path)) {
    return hasScope(scopes, 'messages:read')
  }
  if (requestMethod === 'PATCH' && /^\/api\/messages\/[^/]+$/.test(path)) {
    return hasScope(scopes, 'messages:mark-read') && await markReadRequest(request)
  }
  if (requestMethod === 'GET' && path === '/api/icloud/accounts') {
    return hasScope(scopes, 'icloud:accounts:read')
  }
  if (requestMethod === 'GET' && path === '/api/icloud/aliases') {
    return hasScope(scopes, 'icloud:aliases:read')
  }
  if (requestMethod === 'POST' && path === '/api/icloud/aliases') {
    return hasScope(scopes, 'icloud:aliases:create')
  }
  if (requestMethod === 'GET' && /^\/api\/icloud\/inbox(?:\/[^/]+)?$/.test(path)) {
    return hasScope(scopes, 'icloud:messages:read')
  }
  return false
}
