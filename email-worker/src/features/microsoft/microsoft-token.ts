import type { MicrosoftTransport } from './microsoft-types'

const IMAP_SCOPE = 'https://outlook.office.com/IMAP.AccessAsUser.All'
const GRAPH_RESOURCE = 'https://graph.microsoft.com/'
/** Mail.ReadWrite is required by the read-state write-back feature, not optional. */
const GRAPH_MAIL_SCOPES = ['Mail.Read', 'Mail.ReadWrite'] as const

export const MICROSOFT_TOKEN_SCOPE = `${IMAP_SCOPE} offline_access`
/**
 * Measured 2026-09-01 against all 20 real accounts: the refresh tokens originally
 * consented for IMAP exchange for these scopes with HTTP 200 and are granted
 * Mail.ReadWrite. No re-authorisation is needed (decision card §2.1).
 */
export const MICROSOFT_GRAPH_TOKEN_SCOPE = [
  `${GRAPH_RESOURCE}Mail.Read`,
  `${GRAPH_RESOURCE}Mail.ReadWrite`,
  `${GRAPH_RESOURCE}User.Read`,
  'offline_access',
].join(' ')

/**
 * Scope validation is per transport: a Graph token must never satisfy an IMAP
 * caller and vice versa (invariant I-4). Microsoft echoes back the granted
 * scopes without `offline_access`, so this validates what was actually granted
 * rather than comparing the request string.
 */
const SCOPE_REQUIREMENT: Record<MicrosoftTransport, {
  requestScope: string
  errorCode: string
  granted: (item: string) => boolean
}> = {
  imap: {
    requestScope: MICROSOFT_TOKEN_SCOPE,
    errorCode: 'imap_scope_missing',
    granted: (item) => item === IMAP_SCOPE.toLowerCase(),
  },
  graph: {
    requestScope: MICROSOFT_GRAPH_TOKEN_SCOPE,
    errorCode: 'graph_scope_missing',
    // Fully qualified against the Graph resource on purpose: the Outlook REST
    // resource also publishes a `Mail.Read`, and that token cannot call Graph.
    granted: (item) => GRAPH_MAIL_SCOPES
      .some((scope) => item === `${GRAPH_RESOURCE}${scope}`.toLowerCase()),
  },
}

const NAMED_AUTHORITIES = new Set(['common', 'consumers', 'organizations'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class MicrosoftTokenError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly status = 400,
  ) {
    super(`Microsoft token refresh failed (${code}).`)
    this.name = 'MicrosoftTokenError'
  }
}

export function validateMicrosoftAuthority(value: string): string {
  const authority = value.trim().toLowerCase()
  if (!NAMED_AUTHORITIES.has(authority) && !UUID.test(authority)) {
    throw new Error('Invalid Microsoft authority')
  }
  return authority
}

export function microsoftTokenEndpoint(authority: string): string {
  return `https://login.microsoftonline.com/${validateMicrosoftAuthority(authority)}/oauth2/v2.0/token`
}

function providerErrorCode(value: unknown, status: number): MicrosoftTokenError {
  const code = typeof value === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(value)
    ? value.toLowerCase() : 'token_refresh_failed'
  const retryable = status === 429 || status >= 500
  return new MicrosoftTokenError(code, retryable, retryable ? 503 : 400)
}

export async function refreshMicrosoftToken({
  authority,
  clientId,
  refreshToken,
  transport = 'imap',
  fetcher = fetch,
}: {
  authority: string
  clientId: string
  refreshToken: string
  /** Which transport the token is for. Defaults to `imap` — the pre-Graph contract. */
  transport?: MicrosoftTransport
  fetcher?: typeof fetch
}): Promise<{
  accessToken: string
  refreshToken: string
  expiresIn: number
  scope: string
}> {
  const requirement = SCOPE_REQUIREMENT[transport]
  let response: Response
  try {
    response = await fetcher(microsoftTokenEndpoint(authority), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope: requirement.requestScope,
      }),
    })
  } catch {
    throw new MicrosoftTokenError('token_endpoint_unavailable', true, 503)
  }

  let body: Record<string, unknown>
  try {
    const parsed = await response.json<unknown>()
    body = parsed && !Array.isArray(parsed) && typeof parsed === 'object'
      ? parsed as Record<string, unknown> : {}
  } catch {
    body = {}
  }
  if (!response.ok) throw providerErrorCode(body.error, response.status)

  const accessToken = typeof body.access_token === 'string' ? body.access_token : ''
  const rotated = typeof body.refresh_token === 'string' ? body.refresh_token : refreshToken
  const expiresIn = Number(body.expires_in)
  const scope = typeof body.scope === 'string' ? body.scope : ''
  if (!accessToken || !Number.isSafeInteger(expiresIn) || expiresIn < 1) {
    throw new MicrosoftTokenError('invalid_token_response', false, 502)
  }
  // Keep the assertion's protective intent: a token granted neither this
  // transport's scope still fails loudly, it is simply judged per transport now.
  if (scope && !scope.split(/\s+/).some((item) => requirement.granted(item.toLowerCase()))) {
    throw new MicrosoftTokenError(requirement.errorCode, false, 403)
  }
  return { accessToken, refreshToken: rotated, expiresIn, scope }
}
