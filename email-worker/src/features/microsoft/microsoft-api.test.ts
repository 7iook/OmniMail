import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env, SessionUser } from '../../app/types'
import {
  claimMicrosoftValidationAttempt,
  deleteMicrosoftAccount,
  importMicrosoftAccounts,
  listMicrosoftAccounts,
  MICROSOFT_VALIDATION_ATTEMPTS,
  verifyMicrosoftAccount,
} from './microsoft-account-api'
import { microsoftResponseError } from './microsoft-api-shared'
import { ImapConnectionError } from '../../platform/imap/imap-errors'
import {
  encryptMicrosoftCredential,
  microsoftCredentialContext,
} from './microsoft-credentials'
import { MicrosoftGraphError } from './microsoft-graph'
import {
  getMicrosoftMessage,
  listMicrosoftMessages,
} from './microsoft-message-api'
import { __setMicrosoftTransportFactories } from './microsoft-session'
import type { MicrosoftMailTransport } from './microsoft-transport'
import type { MicrosoftAccountRow, MicrosoftFolder } from './microsoft-types'

const user = {
  id: 'user-1', email: 'user@example.com', displayName: 'User', role: 'user',
  mailboxLimit: 1, storageQuotaBytes: 1024, storageUsedBytes: 0,
  canCreateMailboxes: false, canReply: false, canTranslate: false,
  temporaryExpiresAt: null,
} satisfies SessionUser

const key = 'microsoft-api-key-that-is-longer-than-thirty-two-bytes'

function request(body: unknown): Request {
  return new Request('https://mail.example.com/api/microsoft/accounts/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  __setMicrosoftTransportFactories(null)
})

const inbox: MicrosoftFolder = {
  path: 'INBOX', displayName: 'Inbox', flags: [], specialUse: 'inbox',
  uidValidity: null, lastUid: 0,
}

const calls: string[] = []

/** A proven channel, or one that fails its handshake with `failWith`. */
function fakeTransport(
  transport: 'graph' | 'imap',
  failWith?: unknown,
): MicrosoftMailTransport {
  return {
    transport,
    open: vi.fn(async () => {
      calls.push(`${transport}.open`)
      if (failWith) throw failWith
    }),
    close: vi.fn(async () => { calls.push(`${transport}.close`) }),
    listFolders: vi.fn(async () => [inbox]),
    folderState: vi.fn(async () => ({ uidValidity: null, exists: 0 })),
    listRemoteIds: vi.fn(async () => []),
    listRecentMetadata: vi.fn(async () => []),
    getMessage: vi.fn(async () => ({ message: {}, parsedAttachments: [] }) as never),
    markSeen: vi.fn(async () => undefined),
  }
}

function installTransports(options: { graph?: unknown; imap?: unknown } = {}) {
  calls.length = 0
  const factory = (transport: 'graph' | 'imap', failWith?: unknown) => async () => {
    const fake = fakeTransport(transport, failWith)
    try {
      await fake.open()
      return fake
    } catch (error) {
      await fake.close()
      throw error
    }
  }
  __setMicrosoftTransportFactories({
    graph: factory('graph', options.graph),
    imap: factory('imap', options.imap),
  })
}

/**
 * D1 double that records every bound statement. `row` is what `first()` returns,
 * which is how a stored account is fed to the verify path.
 */
function fakeEnv(row: Record<string, unknown> | null = null) {
  const statements: Array<{ sql: string; bindings: unknown[] }> = []
  const DB = {
    prepare(sql: string) {
      const statement = {
        bindings: [] as unknown[],
        bind(...bindings: unknown[]) {
          statement.bindings = bindings
          return statement
        },
        async all() {
          statements.push({ sql, bindings: statement.bindings })
          return { results: [] }
        },
        async first() {
          statements.push({ sql, bindings: statement.bindings })
          return row
        },
        async run() {
          statements.push({ sql, bindings: statement.bindings })
          return { meta: { changes: 1 } }
        },
      }
      return statement
    },
    async batch(items: unknown[]) {
      return items.map(() => ({ meta: { changes: 1 } }))
    },
  }
  const env = {
    MICROSOFT_CREDENTIALS_KEY: key,
    DB,
    MAIL_QUEUE: { send: async () => undefined },
  } as unknown as Env
  return { env, statements }
}

const oauthImport = {
  email: 'user@outlook.com', authMode: 'oauth2', refreshToken: 'refresh-secret',
  clientId: '00000000-0000-4000-8000-000000000000', authority: 'common',
}

async function storedAccountRow(env: Env): Promise<MicrosoftAccountRow> {
  return {
    id: 'microsoft-1', user_id: user.id, name: 'Work',
    provided_email: 'user@outlook.com', normalized_email: 'user@outlook.com',
    auth_mode: 'oauth2', preferred_transport: 'unknown',
    client_id: '00000000-0000-4000-8000-000000000000', authority: 'common',
    refresh_token_cipher: await encryptMicrosoftCredential(
      env, 'refresh', microsoftCredentialContext(user.id, 'microsoft-1', 'refresh-token'),
    ),
    access_token_cipher: '', access_token_expires_at: null,
    graph_access_token_cipher: '', graph_access_token_expires_at: null,
    password_cipher: '', combination_password_cipher: '',
    status: 'active', last_synced_at: null, next_sync_at: 0,
    last_error_code: '', last_error_at: null,
    sync_lease_id: null, sync_lease_until: null,
    token_lease_id: null, token_lease_until: null,
    last_manual_sync_at: null, created_at: 1, updated_at: 1,
  }
}

describe('Microsoft import and verify go through the transport cascade', () => {
  it('imports a Graph-only credential and stores preferred_transport=graph', async () => {
    // The RCA shape: Microsoft refuses IMAP for this mailbox, Graph works.
    installTransports({ imap: new ImapConnectionError(401, 'IMAP authentication failed') })
    const { env, statements } = fakeEnv()
    const response = await importMicrosoftAccounts(
      env, user, request({ accounts: [oauthImport] }), '192.0.2.1',
    )
    const body = await response.json<{ results: Array<Record<string, unknown>> }>()
    expect(response.status).toBe(201)
    expect(body.results[0]).toMatchObject({
      status: 'accepted',
      account: { preferredTransport: 'graph', status: 'active' },
    })
    expect(calls).toEqual(['graph.open', 'graph.close'])
    expect(statements.some(({ sql }) => /INSERT INTO microsoft_imap_accounts/i.test(sql))).toBe(true)
    const stickiness = statements.find(({ sql }) => /SET preferred_transport = \?/.test(sql))
    expect(stickiness?.bindings[0]).toBe('graph')
  })

  it('reports each channel attempt when both Graph and IMAP reject the credential', async () => {
    installTransports({
      graph: new MicrosoftGraphError('graph_permission_denied', 403, false),
      imap: new ImapConnectionError(401, 'IMAP authentication failed'),
    })
    const { env, statements } = fakeEnv()
    const response = await importMicrosoftAccounts(
      env, user, request({ accounts: [oauthImport] }), '192.0.2.1',
    )
    const body = await response.json<{ results: Array<Record<string, unknown>> }>()
    expect(response.status).toBe(207)
    expect(body.results[0]).toMatchObject({ status: 'error', code: 'transport_unavailable' })
    // Each attempt carries the sentence from the worker's message table, so the
    // client can label "Graph: … · IMAP: …" without a table of its own.
    expect(body.results[0].attempts).toEqual([
      {
        transport: 'graph', category: 'permission', code: 'graph_permission_denied', status: 403,
        message: 'Microsoft 授权缺少 Outlook 邮件权限（Graph 403），请重新授权。',
      },
      {
        transport: 'imap', category: 'auth', code: 'imap_access_rejected', status: 401,
        message: 'Microsoft 拒绝 IMAP OAuth2 登录；请检查权限或租户是否启用 IMAP。',
      },
    ])
    expect(JSON.stringify(body)).not.toContain('refresh-secret')
    expect(statements.some(({ sql }) => /INSERT INTO microsoft_imap_accounts/i.test(sql))).toBe(false)
  })

  it('verifies through the cascade and records the winning transport', async () => {
    installTransports()
    const { env: seed } = fakeEnv()
    const { env, statements } = fakeEnv(await storedAccountRow(seed))
    const response = await verifyMicrosoftAccount(env, user, 'microsoft-1', '192.0.2.1')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true })
    expect(calls).toEqual(['graph.open', 'graph.close'])
    const stickiness = statements.find(({ sql }) => /SET preferred_transport = \?/.test(sql))
    expect(stickiness?.bindings[0]).toBe('graph')
    // Conditional on the value read from the row, so a concurrent sync cannot lose.
    expect(stickiness?.bindings).toContain('unknown')
    expect(statements.some(({ sql }) => /status = 'active'/.test(sql))).toBe(true)
  })

  it('derives the verify failure status from the transport classifier', async () => {
    installTransports({
      graph: new MicrosoftGraphError('graph_credential_rejected', 401, false),
      imap: new ImapConnectionError(401, 'IMAP authentication failed'),
    })
    const { env: seed } = fakeEnv()
    const { env, statements } = fakeEnv(await storedAccountRow(seed))
    const response = await verifyMicrosoftAccount(env, user, 'microsoft-1', '192.0.2.1')
    // Never 401: the frontend treats a 401 from our API as a lost session.
    expect(response.status).not.toBe(401)
    const body = await response.json<Record<string, unknown>>()
    expect(body).toMatchObject({ code: 'transport_unavailable' })
    expect(body.attempts).toEqual([
      {
        transport: 'graph', category: 'auth', code: 'graph_credential_rejected', status: 401,
        message: 'Microsoft 拒绝了 Graph 访问令牌，请重新授权。',
      },
      {
        transport: 'imap', category: 'auth', code: 'imap_access_rejected', status: 401,
        message: 'Microsoft 拒绝 IMAP OAuth2 登录；请检查权限或租户是否启用 IMAP。',
      },
    ])
    const failure = statements.find(({ sql }) => /SET status = \?, last_error_code = \?/.test(sql))
    // Both channels rejected the credential: the same verdict sync reaches, not a
    // generic `error` that would let the user keep re-syncing a dead account.
    expect(failure?.bindings.slice(0, 2)).toEqual(['credential_error', 'transport_unavailable'])
  })

  it('does not switch channel on a throttled verify and records a plain error', async () => {
    installTransports({ graph: new MicrosoftGraphError('graph_throttled', 429, true, 30) })
    const { env: seed } = fakeEnv()
    const { env, statements } = fakeEnv(await storedAccountRow(seed))
    const response = await verifyMicrosoftAccount(env, user, 'microsoft-1', '192.0.2.1')
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(calls).not.toContain('imap.open')
    const failure = statements.find(({ sql }) => /SET status = \?, last_error_code = \?/.test(sql))
    expect(failure?.bindings.slice(0, 2)).toEqual(['error', 'graph_throttled'])
    expect(statements.some(({ sql }) => /SET preferred_transport = \?/.test(sql))).toBe(false)
  })
})

describe('Microsoft mail API boundaries', () => {
  it('reports the feature as disabled without reading D1', async () => {
    const response = await listMicrosoftAccounts({} as Env, user)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ enabled: false, accounts: [] })
  })

  it('rejects password-only imports without remote access', async () => {
    const env = {
      MICROSOFT_CREDENTIALS_KEY: key,
      DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) },
    } as unknown as Env
    const response = await importMicrosoftAccounts(env, user, request({
      accounts: [{
        email: 'user@outlook.com', authMode: 'password', password: 'password',
        persistPasswordConfirmed: true,
      }],
    }), '192.0.2.1')
    expect(response.status).toBe(207)
    await expect(response.json()).resolves.toMatchObject({
      results: [{ status: 'error', code: 'password_auth_removed' }],
    })
  })

  it('does not insert OAuth credentials when Microsoft rejects the refresh token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'invalid_grant' }, { status: 400 })))
    const statements: string[] = []
    const env = {
      MICROSOFT_CREDENTIALS_KEY: key,
      DB: { prepare(sql: string) {
        statements.push(sql)
        return { bind: () => ({
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        }) }
      } },
    } as unknown as Env
    const response = await importMicrosoftAccounts(env, user, request({ accounts: [{
      email: 'user@outlook.com', authMode: 'oauth2', refreshToken: 'refresh-secret',
      clientId: '00000000-0000-4000-8000-000000000000', authority: 'common',
      password: 'combination-password-must-be-discarded',
      persistPasswordConfirmed: true,
    }] }), '192.0.2.1')
    const body = await response.json()
    expect(response.status).toBe(207)
    // The token endpoint is asked once per channel scope (its verdict is
    // scope-dependent, measured), so a dead grant surfaces on both attempts.
    expect(body).toMatchObject({ results: [{
      status: 'error',
      code: 'transport_unavailable',
      attempts: [
        { transport: 'graph', code: 'invalid_grant', category: 'auth',
          message: 'Microsoft 授权已失效或 refresh token 与 Client ID 不匹配。' },
        { transport: 'imap', code: 'invalid_grant', category: 'auth',
          message: 'Microsoft 授权已失效或 refresh token 与 Client ID 不匹配。' },
      ],
    }] })
    expect(JSON.stringify(body)).not.toContain('refresh-secret')
    expect(JSON.stringify(body)).not.toContain('combination-password')
    expect(statements.some((sql) => /INSERT INTO microsoft_imap_accounts/i.test(sql))).toBe(false)
  })

  it('allows two complete 25-account validation batches before rate limiting', async () => {
    let attempts = 0
    const env = { DB: { prepare: () => ({ bind: (...bindings: unknown[]) => ({
      run: async () => {
        const maximum = Number(bindings.at(-1))
        if (attempts >= maximum) return { meta: { changes: 0 } }
        attempts += 1
        return { meta: { changes: 1 } }
      },
    }) }) } } as unknown as Env
    expect(MICROSOFT_VALIDATION_ATTEMPTS).toBe(50)
    for (let index = 0; index < 50; index += 1) {
      await claimMicrosoftValidationAttempt(env, user.id, '192.0.2.1', 1_787_500_000)
    }
    await expect(claimMicrosoftValidationAttempt(
      env, user.id, '192.0.2.1', 1_787_500_000,
    )).rejects.toMatchObject({ status: 429, code: 'validation_rate_limited' })
  })

  it('keeps OAuth2 and password IMAP rejection messages distinct', async () => {
    const error = new ImapConnectionError(400, 'IMAP authentication failed', true)
    const oauth = await microsoftResponseError(error, 'oauth2').json<Record<string, string>>()
    const password = await microsoftResponseError(error, 'password').json<Record<string, string>>()
    expect(oauth).toMatchObject({ code: 'imap_access_rejected' })
    expect(oauth.error).toContain('OAuth2')
    expect(oauth.error).not.toContain('密码 LOGIN')
    expect(password).toMatchObject({ code: 'basic_auth_rejected' })
    expect(password.error).toContain('OAuth2 四字段凭据')
  })

  it('scopes local list and detail queries by the authenticated user', async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = []
    const env = {
      MICROSOFT_CREDENTIALS_KEY: key,
      DB: { prepare(sql: string) {
        return { bind: (...bindings: unknown[]) => {
          statements.push({ sql, bindings })
          return {
            all: async () => ({ results: [] }),
            first: async () => null,
          }
        } }
      } },
    } as unknown as Env
    const list = await listMicrosoftMessages(
      env,
      user,
      new Request('https://mail.example.com/api/microsoft/messages?q=Security%20100%25_'),
    )
    const detail = await getMicrosoftMessage(env, user, 'other-account', 'other-message')
    expect(list.status).toBe(200)
    expect(detail.status).toBe(404)
    expect(statements[0].sql).toContain('a.user_id = ?')
    expect(statements[0].bindings[0]).toBe(user.id)
    expect(statements[0].sql).toContain('instr(lower(m.subject), ?) > 0')
    expect(statements[1].sql).toContain('WHERE a.user_id = ? AND a.id = ? AND m.id = ?')
    expect(statements[1].bindings).toEqual([user.id, 'other-account', 'other-message'])
  })

  it('rejects list limits outside 1..200 before querying messages', async () => {
    const prepare = vi.fn()
    const response = await listMicrosoftMessages(
      { MICROSOFT_CREDENTIALS_KEY: key, DB: { prepare } } as unknown as Env,
      user,
      new Request('https://mail.example.com/api/microsoft/messages?limit=201'),
    )
    expect(response.status).toBe(400)
    expect(prepare).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Graph subscription lifecycle hooks (P2-W2). Uses `installTransports` for the
// cascade (as above) plus a stubbed global `fetch` for the token exchange and
// the Graph `/subscriptions` calls the hooks make on their own — the same
// seam the "does not insert OAuth credentials..." test above already uses.
// ---------------------------------------------------------------------------

const webhookBaseUrl = 'https://omni-mail.example.workers.dev'

function graphTokenResponse(): Response {
  return Response.json({
    access_token: 'graph-access-token',
    refresh_token: 'rotated-refresh',
    expires_in: 3_600,
    scope: 'https://graph.microsoft.com/Mail.ReadWrite',
  })
}

function graphSubscriptionResponse(id: string): Response {
  return Response.json({
    id,
    resource: "me/mailFolders('inbox')/messages",
    notificationUrl: `${webhookBaseUrl}/api/microsoft/graph/notifications`,
    expirationDateTime: new Date(Date.now() + 7 * 24 * 3_600 * 1_000).toISOString(),
  })
}

/**
 * Like `fakeEnv`, but `all()` also answers `microsoft_graph_subscriptions`
 * queries with caller-supplied rows — needed to exercise the delete hook,
 * which must find existing subscription rows before it can tear them down.
 */
function fakeEnvWithSubscriptions(
  accountRow: MicrosoftAccountRow,
  subscriptionRows: Record<string, unknown>[],
) {
  const statements: Array<{ sql: string; bindings: unknown[] }> = []
  const DB = {
    prepare(sql: string) {
      const statement = {
        bindings: [] as unknown[],
        bind(...bindings: unknown[]) { statement.bindings = bindings; return statement },
        async all() {
          statements.push({ sql, bindings: statement.bindings })
          if (/FROM microsoft_graph_subscriptions/i.test(sql)) return { results: subscriptionRows }
          return { results: [] }
        },
        async first() {
          statements.push({ sql, bindings: statement.bindings })
          return /FROM microsoft_imap_accounts/i.test(sql) ? accountRow : null
        },
        async run() {
          statements.push({ sql, bindings: statement.bindings })
          return { meta: { changes: 1 } }
        },
      }
      return statement
    },
    async batch(items: unknown[]) {
      return items.map(() => ({ meta: { changes: 1 } }))
    },
  }
  const env = {
    MICROSOFT_CREDENTIALS_KEY: key,
    DB,
    MAIL_QUEUE: { send: async () => undefined },
  } as unknown as Env
  return { env, statements }
}

function subscriptionRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'row-1',
    account_id: 'microsoft-1',
    folder_path: 'INBOX',
    subscription_id: 'remote-1',
    client_state_hash: 'a'.repeat(64),
    expires_at: 1,
    status: 'active',
    failure_count: 0,
    next_attempt_at: 0,
    refresh_state: 'idle',
    refresh_pending: 0,
    refresh_state_at: 0,
    last_notified_at: null,
    last_error_code: '',
    created_at: 1,
    updated_at: 1,
    ...overrides,
  }
}

describe('Microsoft Graph subscription lifecycle hooks', () => {
  it('creates an inbox and a junkemail subscription after a graph-transport import', async () => {
    installTransports({ imap: new ImapConnectionError(401, 'IMAP authentication failed') })
    let subscriptionCreates = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('login.microsoftonline.com')) return graphTokenResponse()
      if (url === 'https://graph.microsoft.com/v1.0/subscriptions') {
        subscriptionCreates += 1
        return graphSubscriptionResponse(`sub-${subscriptionCreates}`)
      }
      throw new Error(`unexpected fetch ${url}`)
    }))
    const { env, statements } = fakeEnv()
    env.MICROSOFT_GRAPH_WEBHOOK_BASE_URL = webhookBaseUrl

    const response = await importMicrosoftAccounts(
      env, user, request({ accounts: [oauthImport] }), '192.0.2.1',
    )

    expect(response.status).toBe(201)
    const body = await response.json<{ results: Array<Record<string, unknown>> }>()
    expect(body.results[0]).toMatchObject({ status: 'accepted' })
    expect(subscriptionCreates).toBe(2)
    expect(statements.filter(({ sql }) => /INSERT INTO microsoft_graph_subscriptions/i.test(sql)))
      .toHaveLength(2)
  })

  it('creates zero subscriptions, and still accepts the import, when the webhook base URL is unset', async () => {
    installTransports({ imap: new ImapConnectionError(401, 'IMAP authentication failed') })
    let subscriptionCreates = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('login.microsoftonline.com')) return graphTokenResponse()
      subscriptionCreates += 1
      return graphSubscriptionResponse('should-not-happen')
    }))
    const { env, statements } = fakeEnv()
    // MICROSOFT_GRAPH_WEBHOOK_BASE_URL is intentionally left unset.

    const response = await importMicrosoftAccounts(
      env, user, request({ accounts: [oauthImport] }), '192.0.2.1',
    )

    expect(response.status).toBe(201)
    const body = await response.json<{ results: Array<Record<string, unknown>> }>()
    expect(body.results[0]).toMatchObject({ status: 'accepted' })
    expect(subscriptionCreates).toBe(0)
    expect(statements.some(({ sql }) => /INSERT INTO microsoft_graph_subscriptions/i.test(sql))).toBe(false)
  })

  it('deletes every remote Graph subscription before the account row is removed', async () => {
    const { env: seed } = fakeEnv()
    const accountRow = await storedAccountRow(seed)
    const rows = [
      subscriptionRow({ id: 'row-1', subscription_id: 'remote-1', folder_path: 'INBOX' }),
      subscriptionRow({ id: 'row-2', subscription_id: 'remote-2', folder_path: 'Junk Email' }),
    ]
    const { env, statements } = fakeEnvWithSubscriptions(accountRow, rows)
    const remoteDeletesAt: number[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('login.microsoftonline.com')) return graphTokenResponse()
      if (url.startsWith('https://graph.microsoft.com/v1.0/subscriptions/') && init?.method === 'DELETE') {
        remoteDeletesAt.push(statements.length)
        return new Response(null, { status: 204 })
      }
      throw new Error(`unexpected fetch ${url}`)
    }))

    const response = await deleteMicrosoftAccount(env, user, accountRow.id, '192.0.2.1')

    expect(response.status).toBe(200)
    expect(remoteDeletesAt).toHaveLength(2)
    const removalIndex = statements.findIndex(({ sql }) => /DELETE FROM microsoft_imap_accounts/i.test(sql))
    expect(removalIndex).toBeGreaterThan(-1)
    // Every remote DELETE was recorded before the account row's own DELETE ran.
    expect(remoteDeletesAt.every((index) => index < removalIndex)).toBe(true)
  })
})
