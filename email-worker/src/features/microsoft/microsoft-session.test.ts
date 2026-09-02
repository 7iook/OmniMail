import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../app/types'
import { ImapConnectionError } from '../../platform/imap/imap-errors'
import { MicrosoftGraphError } from './microsoft-graph'
import type { MicrosoftMailTransport } from './microsoft-transport'
import {
  __setMicrosoftTransportFactories,
  MicrosoftTransportUnavailableError,
  openMicrosoftTransport,
  resolveMicrosoftTransport,
} from './microsoft-session'
import { MicrosoftStoreError } from './microsoft-store'
import { MicrosoftTokenError } from './microsoft-token'
import {
  microsoftAccountStatusForFailure,
  microsoftTransportFailure,
  publicMicrosoftTransportAttempts,
} from './microsoft-transport-errors'
import type { MicrosoftAccount, MicrosoftPreferredTransport } from './microsoft-types'

const calls: string[] = []
const tokenCalls: string[] = []

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
    listFolders: vi.fn(async () => []),
    folderState: vi.fn(async () => ({ uidValidity: null, exists: null })),
    listRemoteIds: vi.fn(async () => []),
    listRecentMetadata: vi.fn(async () => []),
    getMessage: vi.fn(async () => ({ message: {}, parsedAttachments: [] }) as never),
    markSeen: vi.fn(async () => undefined),
  }
}

/** D1 double that records statements and can be told how many rows changed. */
function fakeDb(changes = 1) {
  const statements: Array<{ sql: string; bindings: unknown[] }> = []
  const DB = {
    prepare(sql: string) {
      return {
        bind(...bindings: unknown[]) {
          return {
            async run() {
              statements.push({ sql, bindings })
              return { meta: { changes } }
            },
          }
        },
      }
    },
  }
  return { DB: DB as unknown as Env['DB'], statements }
}

function account(
  preferredTransport: MicrosoftPreferredTransport,
): MicrosoftAccount {
  return {
    id: 'microsoft-1', userId: 'user-1', name: 'Work',
    providedEmail: 'user@outlook.com', normalizedEmail: 'user@outlook.com',
    authMode: 'oauth2', preferredTransport,
    clientId: '00000000-0000-4000-8000-000000000000', authority: 'common',
    refreshToken: 'refresh', accessToken: 'imap-token', accessTokenExpiresAt: null,
    graphAccessTokenExpiresAt: null, password: '', status: 'active',
    lastSyncedAt: null, nextSyncAt: 0, lastErrorCode: '', lastErrorAt: null,
    syncLeaseId: null, syncLeaseUntil: null, tokenLeaseId: null, tokenLeaseUntil: null,
    lastManualSyncAt: null, createdAt: 1, updatedAt: 1,
  }
}

function env(changes = 1) {
  const db = fakeDb(changes)
  return { env: { DB: db.DB } as Env, statements: db.statements }
}

/**
 * A factory mirroring the real contract: it opens the channel itself and closes
 * it again on failure, so the resolver only ever receives a proven transport.
 */
function factory(transport: 'graph' | 'imap', failWith?: unknown) {
  return async () => {
    tokenCalls.push(`${transport}.token`)
    const fake = fakeTransport(transport, failWith)
    try {
      await fake.open()
      return fake
    } catch (error) {
      await fake.close()
      throw error
    }
  }
}

/** Installs fakes for both channels; `failWith` decides which one is broken. */
function install(options: { graph?: unknown; imap?: unknown } = {}) {
  __setMicrosoftTransportFactories({
    graph: factory('graph', options.graph),
    imap: factory('imap', options.imap),
  })
}

const authFailure = new MicrosoftGraphError('graph_credential_rejected', 401, false)
const throttled = new MicrosoftGraphError('graph_throttled', 429, true, 30)

beforeEach(() => {
  calls.length = 0
  tokenCalls.length = 0
  __setMicrosoftTransportFactories(null)
})

describe('Microsoft transport cascade', () => {
  it('tries graph first for an unprobed account and records graph as the winner', async () => {
    install()
    const { env: environment, statements } = env()
    const resolved = await resolveMicrosoftTransport(environment, account('unknown'))
    expect(resolved.transport.transport).toBe('graph')
    expect(calls).toEqual(['graph.open'])
    const writeback = statements.find(({ sql }) => sql.includes('preferred_transport'))
    expect(writeback?.bindings).toContain('graph')
  })

  it('tries the recorded transport first instead of re-probing', async () => {
    install()
    const { env: environment, statements } = env()
    const resolved = await resolveMicrosoftTransport(environment, account('imap'))
    expect(resolved.transport.transport).toBe('imap')
    expect(calls).toEqual(['imap.open'])
    // Already on the recorded transport: nothing to rewrite.
    expect(statements.some(({ sql }) => sql.includes('preferred_transport'))).toBe(false)
  })

  it('falls back to imap when graph rejects the credential, and rewrites stickiness', async () => {
    install({ graph: authFailure })
    const { env: environment, statements } = env()
    const resolved = await resolveMicrosoftTransport(environment, account('graph'))
    expect(resolved.transport.transport).toBe('imap')
    expect(calls).toEqual(['graph.open', 'graph.close', 'imap.open'])
    const writeback = statements.find(({ sql }) => sql.includes('preferred_transport'))
    expect(writeback?.bindings).toContain('imap')
    // Conditional on the value that was read, so a concurrent sync cannot lose.
    expect(writeback?.sql).toContain('preferred_transport = ?')
    expect(writeback?.bindings).toContain('graph')
  })

  it('does not switch transport and does not rewrite stickiness on a 429', async () => {
    install({ graph: throttled })
    const { env: environment, statements } = env()
    const failure = await resolveMicrosoftTransport(environment, account('graph'))
      .catch((error: unknown) => error)
    expect(calls).toEqual(['graph.open', 'graph.close'])
    expect(calls).not.toContain('imap.open')
    expect(statements.some(({ sql }) => sql.includes('preferred_transport'))).toBe(false)
    expect(failure).toBeInstanceOf(MicrosoftGraphError)
    expect(failure).toMatchObject({ code: 'graph_throttled', retryAfterSeconds: 30 })
  })

  it('does not switch transport on a transient graph fault', async () => {
    install({ graph: new MicrosoftGraphError('graph_unavailable', 502, true) })
    const { env: environment, statements } = env()
    await resolveMicrosoftTransport(environment, account('graph')).catch(() => undefined)
    expect(calls).not.toContain('imap.open')
    expect(statements.some(({ sql }) => sql.includes('preferred_transport'))).toBe(false)
  })

  it('rejects the account with per-transport detail when both channels fail', async () => {
    install({
      graph: authFailure,
      imap: new ImapConnectionError(401, 'Microsoft 拒绝 IMAP OAuth2 登录。'),
    })
    const { env: environment } = env()
    const error = await resolveMicrosoftTransport(environment, account('unknown'))
      .catch((thrown: unknown) => thrown)
    expect(error).toMatchObject({ code: 'transport_unavailable' })
    const attempts = (error as { attempts?: Array<{ transport: string; code: string }> }).attempts
    expect(attempts?.map(({ transport }) => transport)).toEqual(['graph', 'imap'])
    expect(attempts?.map(({ code }) => code))
      .toEqual(['graph_credential_rejected', 'imap_access_rejected'])
  })

  it('does not clobber a concurrent write-back that already changed the value', async () => {
    install()
    // changes = 0: another sync moved preferred_transport between our read and write.
    const { env: environment, statements } = env(0)
    const resolved = await resolveMicrosoftTransport(environment, account('unknown'))
    // The fetch still succeeds; only the stickiness hint is dropped.
    expect(resolved.transport.transport).toBe('graph')
    expect(statements.some(({ sql }) => sql.includes('preferred_transport'))).toBe(true)
  })

  it('refuses a password account before probing any transport', async () => {
    install()
    const { env: environment } = env()
    const passwordAccount = { ...account('unknown'), authMode: 'password' as const }
    await expect(resolveMicrosoftTransport(environment, passwordAccount))
      .rejects.toMatchObject({ code: 'password_auth_removed' })
    expect(calls).toEqual([])
  })

  it('resolves an import candidate through the same cascade', async () => {
    install({ graph: authFailure })
    const { env: environment } = env()
    const resolved = await openMicrosoftTransport(environment, {
      email: 'user@outlook.com',
      authority: 'common',
      clientId: '00000000-0000-4000-8000-000000000000',
      refreshToken: 'refresh',
    })
    expect(resolved.transport.transport).toBe('imap')
    expect(calls).toEqual(['graph.open', 'graph.close', 'imap.open'])
  })
})

describe('Microsoft failure to account status', () => {
  const imapRejected = new ImapConnectionError(401, 'IMAP authentication failed')

  it('maps the classifier category, not a per-call-site code list', () => {
    expect(microsoftAccountStatusForFailure(microsoftTransportFailure(authFailure, 'graph')))
      .toBe('credential_error')
    expect(microsoftAccountStatusForFailure(microsoftTransportFailure(imapRejected, 'imap')))
      .toBe('credential_error')
    expect(microsoftAccountStatusForFailure(microsoftTransportFailure(
      new MicrosoftGraphError('graph_permission_denied', 403, false), 'graph',
    ))).toBe('permission_error')
    // The token codes verify used to drop and sync used to keep now agree.
    for (const code of ['unauthorized_client', 'consent_required', 'invalid_scope']) {
      expect(microsoftAccountStatusForFailure(microsoftTransportFailure(
        new MicrosoftTokenError(code, false, 400), 'graph',
      ))).toBe('permission_error')
    }
    expect(microsoftAccountStatusForFailure(microsoftTransportFailure(throttled, 'graph')))
      .toBe('error')
    expect(microsoftAccountStatusForFailure(microsoftTransportFailure(
      new ImapConnectionError(504, 'timeout'), 'imap',
    ))).toBe('error')
  })

  it('treats an unusable stored credential as a credential error', () => {
    expect(microsoftAccountStatusForFailure(microsoftTransportFailure(
      new MicrosoftStoreError(500, 'credential_decryption_failed', 'corrupt'), 'graph',
    ))).toBe('credential_error')
    expect(microsoftAccountStatusForFailure(microsoftTransportFailure(
      new MicrosoftStoreError(503, 'credential_key_unavailable', 'no key'), 'graph',
    ))).toBe('credential_error')
  })

  it('judges an exhausted cascade by its attempts and never asks for another switch', () => {
    const both = new MicrosoftTransportUnavailableError([
      microsoftTransportFailure(authFailure, 'graph'),
      microsoftTransportFailure(imapRejected, 'imap'),
    ])
    const failure = microsoftTransportFailure(both, 'imap')
    expect(failure).toMatchObject({
      code: 'transport_unavailable', category: 'auth',
      mayTryOtherTransport: false, mayRewritePreferred: false,
    })
    expect(microsoftAccountStatusForFailure(failure)).toBe('credential_error')

    const mixed = new MicrosoftTransportUnavailableError([
      microsoftTransportFailure(new MicrosoftGraphError('graph_permission_denied', 403, false), 'graph'),
      microsoftTransportFailure(imapRejected, 'imap'),
    ])
    expect(microsoftAccountStatusForFailure(microsoftTransportFailure(mixed, 'imap')))
      .toBe('permission_error')
  })

  it('never surfaces an exhausted cascade as HTTP 401', () => {
    // The frontend treats a 401 from our API as a lost session and logs out.
    const error = new MicrosoftTransportUnavailableError([
      microsoftTransportFailure(authFailure, 'graph'),
      microsoftTransportFailure(imapRejected, 'imap'),
    ])
    expect(error.status).toBe(400)
  })

  it('exposes only the per-channel facts a client needs', () => {
    const attempts = publicMicrosoftTransportAttempts([
      microsoftTransportFailure(authFailure, 'graph'),
      microsoftTransportFailure(imapRejected, 'imap'),
    ])
    expect(attempts).toEqual([
      { transport: 'graph', category: 'auth', code: 'graph_credential_rejected', status: 401 },
      { transport: 'imap', category: 'auth', code: 'imap_access_rejected', status: 401 },
    ])
    expect(Object.keys(attempts[0])).not.toContain('mayTryOtherTransport')
  })
})
