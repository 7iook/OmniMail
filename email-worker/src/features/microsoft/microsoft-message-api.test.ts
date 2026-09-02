import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env, SessionUser } from '../../app/types'
import { ImapConnectionError } from '../../platform/imap/imap-errors'
import {
  encryptMicrosoftCredential,
  microsoftCredentialContext,
} from './microsoft-credentials'
import { MicrosoftGraphError } from './microsoft-graph'
import {
  getMicrosoftAttachment,
  getMicrosoftMessage,
  listMicrosoftMessages,
} from './microsoft-message-api'
import type { MicrosoftMailTransport } from './microsoft-transport'
import {
  microsoftTransportFailure,
  MicrosoftTransportUnavailableError,
} from './microsoft-transport-errors'
import type { MicrosoftTransport } from './microsoft-types'

const { resolveMicrosoftTransport } = vi.hoisted(() => ({
  resolveMicrosoftTransport: vi.fn(),
}))

vi.mock('./microsoft-session', () => ({ resolveMicrosoftTransport }))

const GRAPH_ID = 'AAMkAGI2THVSAAA'.padEnd(139, 'A') + '='

const user = {
  id: 'user-1', email: 'user@example.com', displayName: 'User', role: 'user',
  mailboxLimit: 1, storageQuotaBytes: 1024, storageUsedBytes: 0,
  canCreateMailboxes: false, canReply: false, canTranslate: false,
  temporaryExpiresAt: null,
} satisfies SessionUser

const key = 'microsoft-message-test-key-longer-than-thirty-two-bytes'

type Statement = { sql: string; bindings: unknown[] }

function fakeTransport(kind: MicrosoftTransport, uidValidity: number | null) {
  const calls: string[] = []
  const transport: MicrosoftMailTransport = {
    transport: kind,
    open: async () => undefined,
    close: async () => { calls.push('close') },
    listFolders: async () => [],
    folderState: async (path) => {
      calls.push(`folderState(${path})`)
      return { uidValidity, exists: 1 }
    },
    listRemoteIds: async () => [],
    listRecentMetadata: async () => [],
    getMessage: async (path, remoteId) => {
      calls.push(`getMessage(${path},${remoteId})`)
      return {
        message: {
          id: remoteId, from: 'Sender <sender@example.com>', to: 'user@outlook.com', cc: '',
          subject: 'Subject', date: '2026-08-25T00:00:00.000Z', body: 'Body', html: '',
          attachments: [],
        },
        parsedAttachments: [],
      }
    },
    markSeen: async (path, remoteId, expected) => {
      calls.push(`markSeen(${path},${remoteId},${expected})`)
    },
  }
  return { transport, calls }
}

async function testEnv(row: {
  source_transport: MicrosoftTransport
  remote_id: string
  uid_validity: number | null
  is_read?: number
}) {
  const refreshTokenCipher = await encryptMicrosoftCredential(
    { MICROSOFT_CREDENTIALS_KEY: key } as Env,
    'refresh-secret',
    microsoftCredentialContext(user.id, 'microsoft-1', 'refresh-token'),
  )
  const statements: Statement[] = []
  const messageRow = {
    id: 'message-1', account_id: 'microsoft-1', folder_path: 'INBOX',
    source_transport: row.source_transport, remote_id: row.remote_id,
    uid_validity: row.uid_validity, internet_message_id: '<message@example.com>',
    sender_name: 'Sender', sender_address: 'sender@example.com', recipients_json: '[]',
    cc_json: '[]', subject: 'Subject', preview: '', received_at: 1, sent_at: null,
    size_bytes: 100, is_read: row.is_read ?? 0, is_starred: 0, has_attachments: 0,
    account_name: 'Work', account_email: 'user@outlook.com', account_status: 'active',
  }
  const accountRow = {
    id: 'microsoft-1', user_id: user.id, name: 'Work',
    provided_email: 'user@outlook.com', normalized_email: 'user@outlook.com',
    auth_mode: 'oauth2', preferred_transport: row.source_transport,
    client_id: '00000000-0000-4000-8000-000000000000',
    authority: 'common', refresh_token_cipher: refreshTokenCipher,
    access_token_cipher: '', access_token_expires_at: null,
    graph_access_token_cipher: '', graph_access_token_expires_at: null,
    password_cipher: '', combination_password_cipher: '', status: 'active', last_synced_at: 1,
    next_sync_at: 1, last_error_code: '', last_error_at: null, sync_lease_id: null,
    sync_lease_until: null, token_lease_id: null, token_lease_until: null,
    last_manual_sync_at: null, created_at: 1, updated_at: 1,
  }
  const folderRow = {
    account_id: 'microsoft-1', path: 'INBOX', display_name: 'Inbox', flags_json: '[]',
    special_use: 'inbox', uid_validity: row.uid_validity, last_uid: 0,
  }
  const env = {
    MICROSOFT_CREDENTIALS_KEY: key,
    DB: { prepare(sql: string) {
      return { bind: (...bindings: unknown[]) => {
        statements.push({ sql, bindings })
        return {
          first: async () => sql.includes('JOIN microsoft_imap_messages')
            ? messageRow : sql.includes('SELECT * FROM microsoft_imap_accounts')
              ? accountRow : null,
          all: async () => ({
            results: sql.includes('FROM microsoft_imap_folders') ? [folderRow] : [],
          }),
          run: async () => ({ meta: { changes: 1 } }),
        }
      } }
    } },
  } as unknown as Env
  return { env, statements }
}

const readUpdate = ({ sql }: Statement) => sql.includes('UPDATE microsoft_imap_messages SET is_read = 1')
const accountStatusUpdate = ({ sql }: Statement) => (
  sql.includes('UPDATE microsoft_imap_accounts') && sql.includes('status = ?')
)

type Body = { message: { isRead: boolean; body: string; account: { status: string } } }

describe('Microsoft message open through the transport interface', () => {
  beforeEach(() => {
    resolveMicrosoftTransport.mockReset()
  })

  it('reads an IMAP row after checking UIDVALIDITY, marks it Seen and persists is_read', async () => {
    const { transport, calls } = fakeTransport('imap', 42)
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'imap' })
    const { env, statements } = await testEnv({ source_transport: 'imap', remote_id: '7', uid_validity: 42 })

    const response = await getMicrosoftMessage(env, user, 'microsoft-1', 'message-1')
    const result = await response.json() as Body

    expect(response.status).toBe(200)
    expect(result.message).toMatchObject({ isRead: true, body: 'Body' })
    expect(calls).toEqual(['folderState(INBOX)', 'getMessage(INBOX,7)', 'markSeen(INBOX,7,42)', 'close'])
    const update = statements.find(readUpdate)
    expect(update?.bindings).toEqual([expect.any(Number), 'message-1', 'microsoft-1', 'INBOX'])
  })

  it('reads a Graph row by opaque id, skipping the UIDVALIDITY check it cannot have', async () => {
    const { transport, calls } = fakeTransport('graph', null)
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'graph' })
    const { env, statements } = await testEnv({ source_transport: 'graph', remote_id: GRAPH_ID, uid_validity: null })

    const response = await getMicrosoftMessage(env, user, 'microsoft-1', 'message-1')
    const result = await response.json() as Body

    expect(response.status).toBe(200)
    expect(result.message).toMatchObject({ isRead: true, body: 'Body' })
    expect(calls).toEqual([`getMessage(INBOX,${GRAPH_ID})`, `markSeen(INBOX,${GRAPH_ID},null)`, 'close'])
    expect(statements.some(readUpdate)).toBe(true)
  })

  it('refuses an IMAP row whose folder UIDVALIDITY moved on', async () => {
    const { transport, calls } = fakeTransport('imap', 43)
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'imap' })
    const { env } = await testEnv({ source_transport: 'imap', remote_id: '7', uid_validity: 42 })

    const response = await getMicrosoftMessage(env, user, 'microsoft-1', 'message-1')

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ code: 'message_identity_changed' })
    expect(calls).not.toContain('getMessage(INBOX,7)')
  })

  it('does not address a row through a transport that did not issue its locator', async () => {
    const { transport, calls } = fakeTransport('graph', null)
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'graph' })
    const { env } = await testEnv({ source_transport: 'imap', remote_id: '7', uid_validity: 42 })

    const response = await getMicrosoftMessage(env, user, 'microsoft-1', 'message-1')

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: 'message_locator_stale' })
    expect(calls).toEqual(['close'])
  })

  it('surfaces a Graph 404 for the body instead of a generic failure', async () => {
    const { transport } = fakeTransport('graph', null)
    transport.getMessage = async () => { throw new MicrosoftGraphError('graph_message_not_found', 404, false) }
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'graph' })
    const { env } = await testEnv({ source_transport: 'graph', remote_id: GRAPH_ID, uid_validity: null })

    const response = await getMicrosoftMessage(env, user, 'microsoft-1', 'message-1')

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ code: 'graph_message_not_found' })
  })

  it('still returns the body when the remote Seen update is rejected, and keeps is_read unset', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { transport } = fakeTransport('imap', 42)
    transport.markSeen = async () => { throw new Error('STORE rejected') }
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'imap' })
    const { env, statements } = await testEnv({ source_transport: 'imap', remote_id: '7', uid_validity: 42 })

    const response = await getMicrosoftMessage(env, user, 'microsoft-1', 'message-1')
    const result = await response.json() as Body
    logged.mockRestore()

    expect(response.status).toBe(200)
    expect(result.message).toMatchObject({ isRead: false, body: 'Body' })
    expect(statements.some(readUpdate)).toBe(false)
    expect(statements.some(accountStatusUpdate)).toBe(false)
  })

  it('turns a Graph 403 on the write path into permission_error without switching transport', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { transport } = fakeTransport('graph', null)
    transport.markSeen = async () => { throw new MicrosoftGraphError('graph_permission_denied', 403, false) }
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'graph' })
    const { env, statements } = await testEnv({ source_transport: 'graph', remote_id: GRAPH_ID, uid_validity: null })

    const response = await getMicrosoftMessage(env, user, 'microsoft-1', 'message-1')
    const result = await response.json() as Body
    logged.mockRestore()

    expect(response.status).toBe(200)
    expect(result.message.isRead).toBe(false)
    expect(result.message.account.status).toBe('permission_error')
    expect(statements.some(readUpdate)).toBe(false)
    const status = statements.find(accountStatusUpdate)
    expect(status?.bindings.slice(0, 2)).toEqual(['permission_error', 'graph_permission_denied'])
    expect(resolveMicrosoftTransport).toHaveBeenCalledTimes(1)
  })

  it('does not write Seen again when the indexed message is already read', async () => {
    const { transport, calls } = fakeTransport('graph', null)
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'graph' })
    const { env } = await testEnv({ source_transport: 'graph', remote_id: GRAPH_ID, uid_validity: null, is_read: 1 })

    const response = await getMicrosoftMessage(env, user, 'microsoft-1', 'message-1')
    const result = await response.json() as Body

    expect(response.status).toBe(200)
    expect(result.message.isRead).toBe(true)
    expect(calls.some((call) => call.startsWith('markSeen'))).toBe(false)
  })
})

/**
 * Review F2: a credential that dies between two scheduled syncs must stop
 * reading `active` the moment a list or read request hits it, using the same
 * status derivation verify and sync already use.
 */
describe('Microsoft message handlers leave transport verdicts on the account row', () => {
  const listRequest = new Request(
    'https://mail.example.com/api/microsoft/messages?accountId=microsoft-1&refresh=1',
  )
  const graphRow = { source_transport: 'graph' as const, remote_id: GRAPH_ID, uid_validity: null }

  beforeEach(() => {
    resolveMicrosoftTransport.mockReset()
  })

  it('records credential_error when the cascade is exhausted during a list refresh', async () => {
    resolveMicrosoftTransport.mockRejectedValue(new MicrosoftTransportUnavailableError([
      microsoftTransportFailure(new MicrosoftGraphError('graph_credential_rejected', 401, false), 'graph'),
      microsoftTransportFailure(new ImapConnectionError(401, 'IMAP authentication failed'), 'imap'),
    ]))
    const { env, statements } = await testEnv(graphRow)

    const response = await listMicrosoftMessages(env, user, listRequest)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'transport_unavailable' })
    const status = statements.find(accountStatusUpdate)
    expect(status?.bindings).toEqual([
      'credential_error', 'transport_unavailable', expect.any(Number), expect.any(Number), 'microsoft-1',
    ])
  })

  it('records credential_error when Graph rejects the token while opening a message', async () => {
    resolveMicrosoftTransport.mockRejectedValue(
      new MicrosoftGraphError('graph_credential_rejected', 401, false),
    )
    const { env, statements } = await testEnv(graphRow)

    const response = await getMicrosoftMessage(env, user, 'microsoft-1', 'message-1')

    // Never 401: the frontend treats a 401 from our API as a lost session.
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'graph_credential_rejected' })
    const status = statements.find(accountStatusUpdate)
    expect(status?.bindings.slice(0, 2)).toEqual(['credential_error', 'graph_credential_rejected'])
    expect(status?.bindings.at(-1)).toBe('microsoft-1')
  })

  it('records permission_error when a Graph 403 surfaces on an attachment download', async () => {
    const { transport, calls } = fakeTransport('graph', null)
    transport.getMessage = async () => { throw new MicrosoftGraphError('graph_permission_denied', 403, false) }
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'graph' })
    const { env, statements } = await testEnv(graphRow)

    const response = await getMicrosoftAttachment(env, user, 'microsoft-1', 'message-1', '0')

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ code: 'graph_permission_denied' })
    const status = statements.find(accountStatusUpdate)
    expect(status?.bindings.slice(0, 2)).toEqual(['permission_error', 'graph_permission_denied'])
    expect(calls).toContain('close')
  })

  it('records a throttled read as a plain error, the way verify does', async () => {
    const { transport } = fakeTransport('graph', null)
    transport.getMessage = async () => { throw new MicrosoftGraphError('graph_throttled', 429, true, 30) }
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'graph' })
    const { env, statements } = await testEnv(graphRow)

    const response = await getMicrosoftMessage(env, user, 'microsoft-1', 'message-1')

    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('30')
    const status = statements.find(accountStatusUpdate)
    expect(status?.bindings.slice(0, 2)).toEqual(['error', 'graph_throttled'])
  })

  it('does not touch the account when the row is refused by our own 404 or 409', async () => {
    // UIDVALIDITY moved on: a MicrosoftStoreError 404 about the row, not the credential.
    const stale = fakeTransport('imap', 43)
    resolveMicrosoftTransport.mockResolvedValue({ transport: stale.transport, preferredTransport: 'imap' })
    const identity = await testEnv({ source_transport: 'imap', remote_id: '7', uid_validity: 42 })
    const identityResponse = await getMicrosoftMessage(identity.env, user, 'microsoft-1', 'message-1')
    expect(identityResponse.status).toBe(404)
    await expect(identityResponse.json()).resolves.toMatchObject({ code: 'message_identity_changed' })
    expect(identity.statements.some(accountStatusUpdate)).toBe(false)

    // Locator from the other channel: a 409 that only asks for a list refresh.
    const other = fakeTransport('graph', null)
    resolveMicrosoftTransport.mockResolvedValue({ transport: other.transport, preferredTransport: 'graph' })
    const locator = await testEnv({ source_transport: 'imap', remote_id: '7', uid_validity: 42 })
    const locatorResponse = await getMicrosoftMessage(locator.env, user, 'microsoft-1', 'message-1')
    expect(locatorResponse.status).toBe(409)
    expect(locator.statements.some(accountStatusUpdate)).toBe(false)
  })

  it('does not touch the account when the remote mail itself is gone', async () => {
    const { transport } = fakeTransport('graph', null)
    transport.getMessage = async () => { throw new MicrosoftGraphError('graph_message_not_found', 404, false) }
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'graph' })
    const { env, statements } = await testEnv(graphRow)

    const response = await getMicrosoftMessage(env, user, 'microsoft-1', 'message-1')

    expect(response.status).toBe(404)
    expect(statements.some(accountStatusUpdate)).toBe(false)
  })

  it('does not record our own folder-refresh rate limit against the account', async () => {
    const { env, statements } = await testEnv(graphRow)
    const claimed = env.DB.prepare
    env.DB.prepare = (sql: string) => {
      const statement = claimed.call(env.DB, sql)
      if (!sql.includes('SET last_manual_sync_at = ?')) return statement
      return { bind: (...bindings: unknown[]) => {
        statements.push({ sql, bindings })
        return { run: async () => ({ meta: { changes: 0 } }) }
      } } as never
    }

    const response = await listMicrosoftMessages(env, user, listRequest)

    expect(response.status).toBe(429)
    await expect(response.json()).resolves.toMatchObject({ code: 'folder_refresh_rate_limited' })
    expect(resolveMicrosoftTransport).not.toHaveBeenCalled()
    expect(statements.some(accountStatusUpdate)).toBe(false)
  })
})

describe('Microsoft aggregate message list (no accountId)', () => {
  it('includes both Inbox and Junk Email in the combined "all accounts" view (card C-4)', async () => {
    const statements: Statement[] = []
    const env = {
      MICROSOFT_CREDENTIALS_KEY: key,
      DB: { prepare(sql: string) {
        return { bind: (...bindings: unknown[]) => {
          statements.push({ sql, bindings })
          return { all: async () => ({ results: [] }) }
        } }
      } },
    } as unknown as Env
    const request = new Request('https://mail.example.com/api/microsoft/messages')

    const response = await listMicrosoftMessages(env, user, request)

    expect(response.status).toBe(200)
    const listQuery = statements.find(({ sql }) => sql.includes('FROM microsoft_imap_messages m'))
    expect(listQuery?.sql).toContain("upper(m.folder_path) IN ('INBOX', 'JUNK EMAIL')")
  })
})
