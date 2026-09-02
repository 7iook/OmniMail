import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env, MailQueueJob } from '../../app/types'
import { ImapConnectionError } from '../../platform/imap/imap-errors'
import {
  encryptMicrosoftCredential,
  microsoftCredentialContext,
} from './microsoft-credentials'
import { MicrosoftGraphError } from './microsoft-graph'
import { configureMicrosoftGraphSubscriptionRuntime } from './microsoft-graph-notifications'
import { consumeMicrosoftFolderRefreshJob, consumeMicrosoftSyncJob, syncMicrosoftAccount } from './microsoft-sync'
import type { MicrosoftMailTransport } from './microsoft-transport'
import type {
  MicrosoftGraphSubscription,
  MicrosoftGraphSubscriptionRepository,
  MicrosoftMessageMetadata,
  MicrosoftTransport,
} from './microsoft-types'

const { resolveMicrosoftTransport } = vi.hoisted(() => ({
  resolveMicrosoftTransport: vi.fn(),
}))

vi.mock('./microsoft-session', () => ({ resolveMicrosoftTransport }))

type Statement = { sql: string; bindings: unknown[] }

const GRAPH_ID = 'AAMkAGI2THVSAAA'.padEnd(139, 'A') + '='
const NOW = 1_700_000_100
const key = 'microsoft-sync-test-key-longer-than-thirty-two-bytes'

function metadata(remoteId: string, uidValidity: number | null): MicrosoftMessageMetadata {
  return {
    remoteId, uidValidity, internetMessageId: `<${remoteId.slice(0, 6)}@example.com>`,
    senderName: 'Sender', senderAddress: 'sender@example.com', recipients: [], cc: [],
    subject: 'Subject', preview: '', receivedAt: NOW - 10, sentAt: null, sizeBytes: 0,
    flags: [], isRead: false, isStarred: false, hasAttachments: false,
  }
}

function fakeTransport(kind: MicrosoftTransport, remoteIds: string[]) {
  const uidValidity = kind === 'imap' ? 42 : null
  const calls: string[] = []
  const transport: MicrosoftMailTransport = {
    transport: kind,
    open: async () => { calls.push('open') },
    close: async () => { calls.push('close') },
    listFolders: async () => [{
      path: 'INBOX', displayName: 'INBOX', flags: [], specialUse: '\\inbox', uidValidity, lastUid: 0,
    }],
    folderState: async () => ({ uidValidity, exists: remoteIds.length }),
    listRemoteIds: async () => remoteIds,
    listRecentMetadata: async (_path, { limit }) => (
      remoteIds.slice(-limit).reverse().map((id) => metadata(id, uidValidity))
    ),
    getMessage: async () => { throw new Error('not used') },
    markSeen: async () => undefined,
  }
  return { transport, calls }
}

async function testEnv() {
  const refreshTokenCipher = await encryptMicrosoftCredential(
    { MICROSOFT_CREDENTIALS_KEY: key } as Env,
    'refresh-secret',
    microsoftCredentialContext('user-1', 'microsoft-1', 'refresh-token'),
  )
  const accountRow = {
    id: 'microsoft-1', user_id: 'user-1', name: 'Work',
    provided_email: 'user@outlook.com', normalized_email: 'user@outlook.com',
    auth_mode: 'oauth2', preferred_transport: 'unknown',
    client_id: '00000000-0000-4000-8000-000000000000',
    authority: 'common', refresh_token_cipher: refreshTokenCipher,
    access_token_cipher: '', access_token_expires_at: null,
    graph_access_token_cipher: '', graph_access_token_expires_at: null,
    password_cipher: '', combination_password_cipher: '', status: 'active', last_synced_at: 1,
    next_sync_at: 1, last_error_code: '', last_error_at: null, sync_lease_id: null,
    sync_lease_until: null, token_lease_id: null, token_lease_until: null,
    last_manual_sync_at: null, created_at: 1, updated_at: 1,
  }
  const statements: Statement[] = []
  const batches: Statement[][] = []
  const env = {
    MICROSOFT_CREDENTIALS_KEY: key,
    DB: {
      prepare(sql: string) {
        return {
          bind(...bindings: unknown[]) {
            const statement = { sql, bindings }
            statements.push(statement)
            return {
              ...statement,
              first: async () => (
                sql.includes('SELECT * FROM microsoft_imap_accounts') ? accountRow
                  : sql.includes('FROM microsoft_imap_folders') ? { uid_validity: null } : null
              ),
              all: async () => ({ results: [] }),
              run: async () => ({ meta: { changes: 1 } }),
            }
          },
        }
      },
      batch: async (items: Statement[]) => {
        batches.push(items.map(({ sql, bindings }) => ({ sql, bindings })))
        return []
      },
    },
  } as unknown as Env
  return { env, statements, batches }
}

const failureUpdate = ({ sql }: Statement) => sql.includes('last_error_code = ?')

describe('Microsoft account sync through the transport cascade', () => {
  beforeEach(() => {
    resolveMicrosoftTransport.mockReset()
  })

  it('indexes through whichever transport the cascade resolved and stamps its rows', async () => {
    const { transport, calls } = fakeTransport('graph', [GRAPH_ID])
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'graph' })
    const { env, statements, batches } = await testEnv()

    const result = await syncMicrosoftAccount(env, 'microsoft-1', NOW)

    expect(result).toEqual({ status: 'synced', retryable: false, retryAfterSeconds: null })
    const folderInsert = batches.flat().find(({ sql }) => sql.includes('INSERT INTO microsoft_imap_folders'))
    expect(folderInsert?.bindings.slice(0, 2)).toEqual(['microsoft-1', 'INBOX'])
    expect(folderInsert?.bindings[5]).toBeNull()
    const messageInsert = batches.flat().find(({ sql }) => sql.includes('INSERT INTO microsoft_imap_messages'))
    expect(messageInsert?.bindings.slice(1, 6)).toEqual(['microsoft-1', 'INBOX', 'graph', GRAPH_ID, null])
    const active = statements.find(({ sql }) => sql.includes("status = 'active'"))
    expect(active?.bindings).toEqual([NOW, NOW + 300, NOW, 'microsoft-1', expect.any(String)])
    expect(calls).toContain('close')
  })

  it('records an IMAP sync with the mailbox UIDVALIDITY on its rows', async () => {
    const { transport } = fakeTransport('imap', ['7'])
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'imap' })
    const { env, batches } = await testEnv()

    await syncMicrosoftAccount(env, 'microsoft-1', NOW)

    const messageInsert = batches.flat().find(({ sql }) => sql.includes('INSERT INTO microsoft_imap_messages'))
    expect(messageInsert?.bindings.slice(1, 6)).toEqual(['microsoft-1', 'INBOX', 'imap', '7', 42])
  })

  it('schedules a throttled account no earlier than Retry-After and reports the wait', async () => {
    resolveMicrosoftTransport.mockRejectedValue(new MicrosoftGraphError('graph_throttled', 429, true, 600))
    const { env, statements } = await testEnv()

    const result = await syncMicrosoftAccount(env, 'microsoft-1', NOW)

    expect(result).toEqual({ status: 'skipped', retryable: true, retryAfterSeconds: 600 })
    const failure = statements.find(failureUpdate)
    expect(failure?.bindings.slice(0, 4)).toEqual(['error', 'graph_throttled', NOW, NOW + 600])
  })

  it('never schedules a short Retry-After ahead of the normal cadence', async () => {
    resolveMicrosoftTransport.mockRejectedValue(new MicrosoftGraphError('graph_throttled', 429, true, 30))
    const { env, statements } = await testEnv()
    await syncMicrosoftAccount(env, 'microsoft-1', NOW)
    expect(statements.find(failureUpdate)?.bindings[3]).toBe(NOW + 300)
  })

  it('parks a rejected credential as credential_error for a day, without a job retry', async () => {
    resolveMicrosoftTransport.mockRejectedValue(new MicrosoftGraphError('graph_credential_rejected', 401, false))
    const { env, statements } = await testEnv()

    const result = await syncMicrosoftAccount(env, 'microsoft-1', NOW)

    expect(result).toEqual({ status: 'skipped', retryable: false, retryAfterSeconds: null })
    expect(statements.find(failureUpdate)?.bindings.slice(0, 4))
      .toEqual(['credential_error', 'graph_credential_rejected', NOW, NOW + 24 * 60 * 60])
  })

  it('parks a Graph 403 as permission_error, the status the UI already explains', async () => {
    resolveMicrosoftTransport.mockRejectedValue(new MicrosoftGraphError('graph_permission_denied', 403, false))
    const { env, statements } = await testEnv()
    const result = await syncMicrosoftAccount(env, 'microsoft-1', NOW)
    expect(result.retryable).toBe(false)
    expect(statements.find(failureUpdate)?.bindings.slice(0, 2))
      .toEqual(['permission_error', 'graph_permission_denied'])
  })

  it('classifies an IMAP fault that surfaces mid-sync with the same authority', async () => {
    const { transport } = fakeTransport('imap', ['7'])
    transport.listFolders = async () => { throw new ImapConnectionError(504, 'timed out') }
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'imap' })
    const { env, statements } = await testEnv()

    const result = await syncMicrosoftAccount(env, 'microsoft-1', NOW)

    expect(result).toEqual({ status: 'skipped', retryable: true, retryAfterSeconds: null })
    expect(statements.find(failureUpdate)?.bindings.slice(0, 4))
      .toEqual(['error', 'timeout', NOW, NOW + 300])
  })

  it('fails the sync when the transport lists no inbox', async () => {
    const { transport } = fakeTransport('graph', [])
    transport.listFolders = async () => []
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'graph' })
    const { env, statements } = await testEnv()
    await syncMicrosoftAccount(env, 'microsoft-1', NOW)
    expect(statements.find(failureUpdate)?.bindings[1]).toBe('inbox_unavailable')
  })

  it('also refreshes Junk Email for a Graph transport that lists it (card C-4)', async () => {
    const { transport } = fakeTransport('graph', [GRAPH_ID])
    transport.listFolders = async () => [
      { path: 'INBOX', displayName: 'INBOX', flags: [], specialUse: '\\inbox', uidValidity: null, lastUid: 0 },
      { path: 'Junk Email', displayName: 'Junk Email', flags: [], specialUse: '\\junk', uidValidity: null, lastUid: 0 },
    ]
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'graph' })
    const { env, batches } = await testEnv()

    await syncMicrosoftAccount(env, 'microsoft-1', NOW)

    const messageInserts = batches.flat().filter(({ sql }) => sql.includes('INSERT INTO microsoft_imap_messages'))
    const refreshedFolders = messageInserts.map(({ bindings }) => bindings[2])
    expect(refreshedFolders).toEqual(expect.arrayContaining(['INBOX', 'Junk Email']))
  })

  it('never refreshes a Junk Email folder for an IMAP transport (card C-4)', async () => {
    const { transport } = fakeTransport('imap', ['7'])
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'imap' })
    const { env, batches } = await testEnv()

    await syncMicrosoftAccount(env, 'microsoft-1', NOW)

    const messageInserts = batches.flat().filter(({ sql }) => sql.includes('INSERT INTO microsoft_imap_messages'))
    expect(messageInserts.map(({ bindings }) => bindings[2])).toEqual(['INBOX'])
  })
})

describe('Microsoft sync queue retries', () => {
  beforeEach(() => {
    resolveMicrosoftTransport.mockReset()
  })

  function queueMessage(attempts: number) {
    const retry = vi.fn()
    const ack = vi.fn()
    const message = {
      body: { kind: 'microsoft-sync', accountId: 'microsoft-1', reason: 'scheduled' },
      attempts,
      retry,
      ack,
    } as unknown as Message<MailQueueJob>
    return { message, retry, ack }
  }

  it('delays the queue retry by at least Retry-After when throttled', async () => {
    resolveMicrosoftTransport.mockRejectedValue(new MicrosoftGraphError('graph_throttled', 429, true, 600))
    const { env } = await testEnv()
    const { message, retry, ack } = queueMessage(1)
    await consumeMicrosoftSyncJob(message, env)
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 600 })
    expect(ack).not.toHaveBeenCalled()
  })

  it('keeps the exponential backoff for transient faults without a Retry-After', async () => {
    resolveMicrosoftTransport.mockRejectedValue(new MicrosoftGraphError('graph_unavailable', 503, true))
    const { env } = await testEnv()
    const { message, retry } = queueMessage(2)
    await consumeMicrosoftSyncJob(message, env)
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 60 })
  })

  it('acks instead of retrying when the credential is rejected', async () => {
    resolveMicrosoftTransport.mockRejectedValue(new MicrosoftGraphError('graph_credential_rejected', 401, false))
    const { env } = await testEnv()
    const { message, retry, ack } = queueMessage(1)
    await consumeMicrosoftSyncJob(message, env)
    expect(retry).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalled()
  })
})

describe('Microsoft Graph folder-refresh queue consumer (C-3, C-4)', () => {
  beforeEach(() => {
    resolveMicrosoftTransport.mockReset()
    configureMicrosoftGraphSubscriptionRuntime(null)
  })
  afterEach(() => {
    configureMicrosoftGraphSubscriptionRuntime(null)
  })

  function folderRefreshMessage(attempts = 1) {
    const retry = vi.fn()
    const ack = vi.fn()
    const message = {
      body: { kind: 'microsoft-folder-refresh', accountId: 'microsoft-1', folderPath: 'Junk Email', reason: 'notification' },
      attempts,
      retry,
      ack,
    } as unknown as Message<MailQueueJob>
    return { message, retry, ack }
  }

  function trackedTransport(kind: MicrosoftTransport) {
    const folderState = vi.fn(async () => ({ uidValidity: kind === 'imap' ? 42 : null, exists: 0 }))
    const listRecentMetadata = vi.fn(async () => [] as MicrosoftMessageMetadata[])
    const listRemoteIds = vi.fn(async () => [] as string[])
    const close = vi.fn(async () => undefined)
    const transport: MicrosoftMailTransport = {
      transport: kind,
      open: async () => undefined,
      close,
      listFolders: async () => [],
      folderState,
      listRemoteIds,
      listRecentMetadata,
      getMessage: async () => { throw new Error('not used') },
      markSeen: async () => undefined,
    }
    return { transport, folderState, listRecentMetadata, listRemoteIds, close }
  }

  function subscriptionFixture(overrides: Partial<MicrosoftGraphSubscription> = {}): MicrosoftGraphSubscription {
    return {
      id: 'sub-row-1', accountId: 'microsoft-1', folderPath: 'Junk Email', subscriptionId: 'sub-1',
      clientStateHash: '', expiresAt: 0, status: 'active', failureCount: 0, nextAttemptAt: 0,
      refreshState: 'idle', refreshPending: false, refreshStateAt: 0, lastNotifiedAt: null,
      lastErrorCode: '', createdAt: 0, updatedAt: 0,
      ...overrides,
    }
  }

  function fakeRuntimeWithRow(row: MicrosoftGraphSubscription) {
    let current = row
    const repository: MicrosoftGraphSubscriptionRepository = {
      async bySubscriptionId() { throw new Error('not used') },
      async forAccount(accountId) { return current.accountId === accountId ? [current] : [] },
      async insert() { throw new Error('not used') },
      async remove() { throw new Error('not used') },
      async update() { throw new Error('not used') },
      async due() { return [] },
      async markQueued() { throw new Error('not used') },
      async markPending() { throw new Error('not used') },
      async releaseQueued() { throw new Error('not used') },
      async markRunning(id, now) {
        if (current.id !== id) return false
        current = { ...current, refreshState: 'running', refreshStateAt: now }
        return true
      },
      async finishRunning(id, now) {
        if (current.id !== id) return { requeue: false }
        const requeue = current.refreshPending
        current = { ...current, refreshState: requeue ? 'queued' : 'idle', refreshPending: false, refreshStateAt: now }
        return { requeue }
      },
    }
    configureMicrosoftGraphSubscriptionRuntime({
      repositoryFor: () => repository,
      clientFor: () => { throw new Error('not used') },
    })
    return { current: () => current }
  }

  it('acks and makes zero Graph calls when the account has fallen back to IMAP (C-4)', async () => {
    const { transport, folderState, close } = trackedTransport('imap')
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'imap' })
    const { env } = await testEnv()
    const { message, retry, ack } = folderRefreshMessage()

    await consumeMicrosoftFolderRefreshJob(message, env)

    expect(ack).toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
    expect(folderState).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })

  it('refreshes exactly the named folder for a Graph transport and acks', async () => {
    const { transport, folderState } = trackedTransport('graph')
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'graph' })
    const { env, batches } = await testEnv()
    const { message, ack } = folderRefreshMessage()

    await consumeMicrosoftFolderRefreshJob(message, env)

    expect(ack).toHaveBeenCalled()
    expect(folderState).toHaveBeenCalledWith('Junk Email')
    const folderUpdate = batches.flat().find(({ sql }) => sql.includes('UPDATE microsoft_imap_folders'))
    expect(folderUpdate?.bindings.slice(2)).toEqual(['microsoft-1', 'Junk Email'])
  })

  it('releases the C-3 running state and sends a follow-up job when a notification arrived mid-run', async () => {
    const { transport } = trackedTransport('graph')
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'graph' })
    const { current } = fakeRuntimeWithRow(subscriptionFixture({ refreshPending: true }))
    const { env } = await testEnv()
    const send = vi.fn(async () => undefined)
    ;(env as unknown as { MAIL_QUEUE: { send: typeof send } }).MAIL_QUEUE = { send }
    const { message, ack } = folderRefreshMessage()

    await consumeMicrosoftFolderRefreshJob(message, env)

    expect(ack).toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      kind: 'microsoft-folder-refresh', accountId: 'microsoft-1', folderPath: 'Junk Email', reason: 'notification',
    })
    expect(current().refreshState).toBe('queued')
  })

  it('does not send a follow-up job when nothing arrived while running', async () => {
    const { transport } = trackedTransport('graph')
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'graph' })
    const { current } = fakeRuntimeWithRow(subscriptionFixture())
    const { env } = await testEnv()
    const send = vi.fn(async () => undefined)
    ;(env as unknown as { MAIL_QUEUE: { send: typeof send } }).MAIL_QUEUE = { send }
    const { message, ack } = folderRefreshMessage()

    await consumeMicrosoftFolderRefreshJob(message, env)

    expect(ack).toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(current().refreshState).toBe('idle')
  })

  it('reuses the sync retry shape: Retry-After wins over exponential backoff', async () => {
    resolveMicrosoftTransport.mockRejectedValue(new MicrosoftGraphError('graph_throttled', 429, true, 600))
    const { env } = await testEnv()
    const { message, retry, ack } = folderRefreshMessage(1)

    await consumeMicrosoftFolderRefreshJob(message, env)

    expect(retry).toHaveBeenCalledWith({ delaySeconds: 600 })
    expect(ack).not.toHaveBeenCalled()
  })

  it('acks instead of retrying a rejected credential, same as the scheduled sync consumer', async () => {
    resolveMicrosoftTransport.mockRejectedValue(new MicrosoftGraphError('graph_credential_rejected', 401, false))
    const { env } = await testEnv()
    const { message, retry, ack } = folderRefreshMessage(1)

    await consumeMicrosoftFolderRefreshJob(message, env)

    expect(retry).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalled()
  })

  it('exhausts retries after QUEUE_MAX_ATTEMPTS, same as the scheduled sync consumer', async () => {
    resolveMicrosoftTransport.mockRejectedValue(new MicrosoftGraphError('graph_unavailable', 503, true))
    const { env } = await testEnv()
    const { message, retry, ack } = folderRefreshMessage(3)

    await consumeMicrosoftFolderRefreshJob(message, env)

    expect(retry).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalled()
  })
})
