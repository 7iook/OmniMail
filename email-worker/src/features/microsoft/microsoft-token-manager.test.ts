import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../../app/types'
import { encryptMicrosoftCredential } from './microsoft-credentials'
import { microsoftAccessToken, microsoftGraphTokenContext } from './microsoft-token-manager'
import type { MicrosoftAccount } from './microsoft-types'

function account(): MicrosoftAccount {
  return {
    id: 'microsoft_account_1', userId: 'user_1', name: 'Outlook',
    providedEmail: 'user@outlook.com', normalizedEmail: 'user@outlook.com',
    authMode: 'oauth2', preferredTransport: 'unknown',
    clientId: '00000000-0000-4000-8000-000000000000',
    authority: 'common', refreshToken: 'refresh-token', accessToken: 'cached-token',
    accessTokenExpiresAt: 5_000, graphAccessTokenExpiresAt: null,
    password: '', status: 'active', lastSyncedAt: null,
    nextSyncAt: 0, lastErrorCode: '', lastErrorAt: null, syncLeaseId: null,
    syncLeaseUntil: null, tokenLeaseId: null, tokenLeaseUntil: null,
    lastManualSyncAt: null, createdAt: 1_000, updatedAt: 1_000,
  }
}

describe('Microsoft access token manager', () => {
  it('reuses a cached token before the expiry skew without touching D1', async () => {
    const prepare = vi.fn(() => { throw new Error('D1 should not be used') })
    await expect(microsoftAccessToken(
      { DB: { prepare } } as unknown as Env,
      account(),
      { now: 1_000 },
    )).resolves.toBe('cached-token')
    expect(prepare).not.toHaveBeenCalled()
  })

  it('claims a lease, rotates both tokens atomically, and clears the lease', async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = []
    const env = {
      MICROSOFT_CREDENTIALS_KEY: 'microsoft-token-key-longer-than-thirty-two-bytes',
      DB: {
        prepare: vi.fn((sql: string) => {
          const statement = {
            bindings: [] as unknown[],
            bind(...bindings: unknown[]) {
              statement.bindings = bindings
              return statement
            },
            async run() {
              statements.push({ sql, bindings: statement.bindings })
              return { meta: { changes: 1 } }
            },
          }
          return statement
        }),
      },
    } as unknown as Env
    const value = account()
    value.accessTokenExpiresAt = 1_010
    const fetcher = vi.fn(async () => Response.json({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
      scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access',
    }))
    await expect(microsoftAccessToken(env, value, { now: 1_000, fetcher }))
      .resolves.toBe('new-access')
    expect(statements[0].sql).toContain('token_lease_id')
    expect(statements[1].sql).toContain('refresh_token_cipher = ?')
    expect(statements[1].sql).toContain('token_lease_id = NULL')
    expect(statements[1].bindings.map(String)).not.toContain('new-refresh')
    expect(value).toMatchObject({
      refreshToken: 'new-refresh',
      accessToken: 'new-access',
      accessTokenExpiresAt: 4_600,
    })
  })
})

describe('Microsoft access token manager per transport', () => {
  const KEY = 'microsoft-token-key-longer-than-thirty-two-bytes'
  const GRAPH_GRANTED = [
    'https://graph.microsoft.com/Mail.Read',
    'https://graph.microsoft.com/Mail.ReadWrite',
    'https://graph.microsoft.com/User.Read',
  ].join(' ')

  function fakeDb(rows: Record<string, unknown> = {}) {
    const statements: Array<{ sql: string; bindings: unknown[] }> = []
    const prepare = vi.fn((sql: string) => {
      const statement = {
        bindings: [] as unknown[],
        bind(...bindings: unknown[]) {
          statement.bindings = bindings
          return statement
        },
        async run() {
          statements.push({ sql, bindings: statement.bindings })
          return { meta: { changes: 1 } }
        },
        async first() {
          statements.push({ sql, bindings: statement.bindings })
          return rows
        },
      }
      return statement
    })
    return {
      statements,
      prepare,
      env: { MICROSOFT_CREDENTIALS_KEY: KEY, DB: { prepare } } as unknown as Env,
    }
  }

  function graphTokenFetcher(accessToken = 'graph-access') {
    return vi.fn(async () => Response.json({
      access_token: accessToken,
      refresh_token: 'new-refresh',
      expires_in: 3600,
      scope: GRAPH_GRANTED,
    }))
  }

  it('mints a graph token and stores it in the graph cipher column, not the imap one', async () => {
    const db = fakeDb()
    const value = account()
    value.accessTokenExpiresAt = 9_000_000
    const fetcher = graphTokenFetcher()

    await expect(microsoftAccessToken(db.env, value, { now: 1_000, transport: 'graph', fetcher }))
      .resolves.toBe('graph-access')

    const writeback = db.statements.find((item) => item.sql.includes('refresh_token_cipher = ?'))
    expect(writeback?.sql).toContain('graph_access_token_cipher = ?')
    expect(writeback?.sql).toContain('graph_access_token_expires_at = ?')
    expect(writeback?.sql).not.toContain('access_token_cipher = ?, access_token_expires_at')
    expect(writeback?.sql).toContain('token_lease_id = NULL')
    expect(writeback?.bindings.map(String)).not.toContain('graph-access')
    expect(value.graphAccessTokenExpiresAt).toBe(4_600)
    // The IMAP token and its expiry are untouched by a graph refresh.
    expect(value.accessToken).toBe('cached-token')
    expect(value.accessTokenExpiresAt).toBe(9_000_000)
  })

  it('never serves a fresh imap token to a graph caller', async () => {
    const db = fakeDb()
    const value = account()
    value.accessToken = 'imap-only-token'
    value.accessTokenExpiresAt = 9_000_000
    value.graphAccessTokenExpiresAt = null
    const fetcher = graphTokenFetcher('minted-graph-token')

    const token = await microsoftAccessToken(
      db.env,
      value,
      { now: 1_000, transport: 'graph', fetcher },
    )
    expect(token).toBe('minted-graph-token')
    expect(token).not.toBe('imap-only-token')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('never serves a fresh graph token to an imap caller', async () => {
    const db = fakeDb()
    const value = account()
    value.accessToken = ''
    value.accessTokenExpiresAt = null
    value.graphAccessTokenExpiresAt = 9_000_000
    const fetcher = vi.fn(async () => Response.json({
      access_token: 'minted-imap-token',
      refresh_token: 'new-refresh',
      expires_in: 3600,
      scope: 'https://outlook.office.com/IMAP.AccessAsUser.All',
    }))

    await expect(microsoftAccessToken(db.env, value, { now: 1_000, transport: 'imap', fetcher }))
      .resolves.toBe('minted-imap-token')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('reuses a cached graph token before the expiry skew without refreshing it', async () => {
    const value = account()
    value.graphAccessTokenExpiresAt = 5_000
    const cipher = await encryptMicrosoftCredential(
      { MICROSOFT_CREDENTIALS_KEY: KEY } as unknown as Env,
      'cached-graph-token',
      microsoftGraphTokenContext(value.userId, value.id),
    )
    const db = fakeDb({ cipher })
    const fetcher = vi.fn(async () => { throw new Error('token endpoint must not be called') })

    await expect(microsoftAccessToken(db.env, value, { now: 1_000, transport: 'graph', fetcher }))
      .resolves.toBe('cached-graph-token')
    expect(fetcher).not.toHaveBeenCalled()
    expect(db.statements.every((item) => item.sql.startsWith('SELECT'))).toBe(true)
  })

  it('refreshes when the graph cache is fresh but the stored cipher is empty', async () => {
    const value = account()
    value.graphAccessTokenExpiresAt = 5_000
    const db = fakeDb({ cipher: '' })
    const fetcher = graphTokenFetcher('remitted-graph')

    await expect(microsoftAccessToken(db.env, value, { now: 1_000, transport: 'graph', fetcher }))
      .resolves.toBe('remitted-graph')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('keeps the imap fast path free of D1 reads', async () => {
    const prepare = vi.fn(() => { throw new Error('D1 should not be used') })
    await expect(microsoftAccessToken(
      { DB: { prepare } } as unknown as Env,
      account(),
      { now: 1_000, transport: 'imap' },
    )).resolves.toBe('cached-token')
    expect(prepare).not.toHaveBeenCalled()
  })
})
