import type { Env } from '../../app/types'
import {
  decryptMicrosoftCredential,
  encryptMicrosoftCredential,
  microsoftCredentialContext,
} from './microsoft-credentials'
import { MicrosoftStoreError, microsoftAccountForSync } from './microsoft-store'
import { refreshMicrosoftToken } from './microsoft-token'
import type { MicrosoftAccount, MicrosoftTransport } from './microsoft-types'

const TOKEN_LEASE_SECONDS = 60
const TOKEN_EXPIRY_SKEW_SECONDS = 60

/**
 * Graph and IMAP access tokens carry different scopes and are never interchangeable
 * (invariant I-4), so each transport owns its own cipher column and expiry. The
 * refresh token is shared — there is one per account — and keeps the existing
 * lease plus atomic rotated-ciphertext writeback.
 */
// Literal types, not `string`: these names are interpolated into SQL, so the
// compiler — not a reviewer's judgement — is what keeps caller input out of it.
const TOKEN_COLUMNS = {
  imap: { cipher: 'access_token_cipher', expiresAt: 'access_token_expires_at' },
  graph: { cipher: 'graph_access_token_cipher', expiresAt: 'graph_access_token_expires_at' },
} as const satisfies Record<MicrosoftTransport, { cipher: string; expiresAt: string }>

/**
 * Distinct AAD context from the IMAP `access-token` one, so a graph ciphertext
 * cannot be decrypted as an IMAP token even if the columns were ever swapped.
 */
export function microsoftGraphTokenContext(userId: string, accountId: string): string {
  return `${userId}:${accountId}:graph-access-token`
}

function expiresAt(account: MicrosoftAccount, transport: MicrosoftTransport): number | null {
  return transport === 'graph' ? account.graphAccessTokenExpiresAt : account.accessTokenExpiresAt
}

function fresh(
  account: MicrosoftAccount,
  transport: MicrosoftTransport,
  now: number,
): boolean {
  const expiry = expiresAt(account, transport)
  return !!expiry && expiry > now + TOKEN_EXPIRY_SKEW_SECONDS
}

function cached(
  account: MicrosoftAccount,
  transport: MicrosoftTransport,
  now: number,
): string | null {
  // The IMAP token is already decrypted onto the account; the graph one is not
  // carried by the domain type, so it is read from D1 by `cachedGraphToken`.
  if (transport === 'graph') return null
  return account.accessToken && fresh(account, transport, now) ? account.accessToken : null
}

async function cachedGraphToken(
  env: Env,
  account: MicrosoftAccount,
  now: number,
): Promise<string | null> {
  if (!fresh(account, 'graph', now)) return null
  const row = await env.DB.prepare(
    `SELECT graph_access_token_cipher AS cipher FROM microsoft_imap_accounts
      WHERE id = ? LIMIT 1`,
  ).bind(account.id).first<{ cipher: string }>()
  if (!row?.cipher) return null
  try {
    return await decryptMicrosoftCredential(
      env,
      row.cipher,
      microsoftGraphTokenContext(account.userId, account.id),
    )
  } catch {
    // A cipher we cannot read is not a usable cached token; fall through to a
    // refresh rather than failing the caller on a cache miss.
    return null
  }
}

export async function microsoftAccessToken(
  env: Env,
  account: MicrosoftAccount,
  options: {
    force?: boolean
    now?: number
    transport?: MicrosoftTransport
    fetcher?: typeof fetch
  } = {},
): Promise<string> {
  if (account.authMode !== 'oauth2') {
    throw new MicrosoftStoreError(400, 'invalid_auth_mode', 'Microsoft 账号不是 OAuth2 模式。')
  }
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const transport = options.transport ?? 'imap'
  const columns = TOKEN_COLUMNS[transport]
  if (!options.force) {
    const available = transport === 'graph'
      ? await cachedGraphToken(env, account, now)
      : cached(account, transport, now)
    if (available) return available
  }

  const leaseId = crypto.randomUUID()
  const claim = await env.DB.prepare(
    `UPDATE microsoft_imap_accounts
        SET token_lease_id = ?, token_lease_until = ?, updated_at = ?
      WHERE id = ? AND auth_mode = 'oauth2'
        AND (token_lease_until IS NULL OR token_lease_until <= ?)`,
  ).bind(leaseId, now + TOKEN_LEASE_SECONDS, now, account.id, now).run()
  if (!claim.meta.changes) {
    const latest = await microsoftAccountForSync(env, account.id)
    const available = latest && !options.force
      ? (transport === 'graph'
        ? await cachedGraphToken(env, latest, now)
        : cached(latest, transport, now))
      : null
    if (available) return available
    throw new MicrosoftStoreError(409, 'token_refresh_busy', 'Microsoft token 正在刷新，请稍后重试。')
  }

  try {
    const result = await refreshMicrosoftToken({
      authority: account.authority,
      clientId: account.clientId,
      refreshToken: account.refreshToken,
      transport,
      fetcher: options.fetcher,
    })
    const refreshCipher = await encryptMicrosoftCredential(
      env,
      result.refreshToken,
      microsoftCredentialContext(account.userId, account.id, 'refresh-token'),
    )
    const accessCipher = await encryptMicrosoftCredential(
      env,
      result.accessToken,
      transport === 'graph'
        ? microsoftGraphTokenContext(account.userId, account.id)
        : microsoftCredentialContext(account.userId, account.id, 'access-token'),
    )
    const tokenExpiresAt = now + result.expiresIn
    // Only this transport's columns are written; the other transport's cached
    // token stays valid and is never overwritten by a sibling refresh.
    const saved = await env.DB.prepare(
      `UPDATE microsoft_imap_accounts
          SET refresh_token_cipher = ?, ${columns.cipher} = ?,
              ${columns.expiresAt} = ?, token_lease_id = NULL,
              token_lease_until = NULL, updated_at = ?
        WHERE id = ? AND token_lease_id = ?`,
    ).bind(refreshCipher, accessCipher, tokenExpiresAt, now, account.id, leaseId).run()
    if (!saved.meta.changes) {
      throw new MicrosoftStoreError(409, 'token_refresh_lost', 'Microsoft token 刷新租约已失效。')
    }
    account.refreshToken = result.refreshToken
    if (transport === 'graph') {
      account.graphAccessTokenExpiresAt = tokenExpiresAt
    } else {
      account.accessToken = result.accessToken
      account.accessTokenExpiresAt = tokenExpiresAt
    }
    return result.accessToken
  } catch (error) {
    try {
      await env.DB.prepare(
        `UPDATE microsoft_imap_accounts
            SET token_lease_id = NULL, token_lease_until = NULL
          WHERE id = ? AND token_lease_id = ?`,
      ).bind(account.id, leaseId).run()
    } catch { /* preserve token error */ }
    throw error
  }
}
