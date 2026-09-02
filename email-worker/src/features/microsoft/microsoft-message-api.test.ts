import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env, SessionUser } from '../../app/types'
import {
  encryptMicrosoftCredential,
  microsoftCredentialContext,
} from './microsoft-credentials'
import { MicrosoftGraphError } from './microsoft-graph'
import { getMicrosoftMessage } from './microsoft-message-api'
import type { MicrosoftMailTransport } from './microsoft-transport'
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
  const env = {
    MICROSOFT_CREDENTIALS_KEY: key,
    DB: { prepare(sql: string) {
      return { bind: (...bindings: unknown[]) => {
        statements.push({ sql, bindings })
        return {
          first: async () => sql.includes('JOIN microsoft_imap_messages')
            ? messageRow : sql.includes('SELECT * FROM microsoft_imap_accounts')
              ? accountRow : null,
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
