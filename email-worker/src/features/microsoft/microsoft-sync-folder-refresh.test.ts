import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env, MailQueueJob } from '../../app/types'
import {
  encryptMicrosoftCredential,
  microsoftCredentialContext,
} from './microsoft-credentials'
import { MicrosoftGraphError } from './microsoft-graph'
import { configureMicrosoftGraphSubscriptionRuntime } from './microsoft-graph-notifications'
import { consumeMicrosoftFolderRefreshJob } from './microsoft-sync'
import type { MicrosoftMailTransport } from './microsoft-transport'
import type {
  MicrosoftGraphSubscription,
  MicrosoftGraphSubscriptionRepository,
  MicrosoftMessageMetadata,
  MicrosoftTransport,
} from './microsoft-types'

// Split out of `microsoft-sync.test.ts` (review3 fixes) to stay under the
// 600-line gate (`scripts/check-file-lines.mjs`); covers only the
// notification-triggered `consumeMicrosoftFolderRefreshJob` consumer (C-3/C-4).

const { resolveMicrosoftTransport } = vi.hoisted(() => ({
  resolveMicrosoftTransport: vi.fn(),
}))

vi.mock('./microsoft-session', () => ({ resolveMicrosoftTransport }))

type Statement = { sql: string; bindings: unknown[] }

const NOW = 1_700_000_100
const key = 'microsoft-sync-test-key-longer-than-thirty-two-bytes'

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

  const STALE_SECONDS = 10 * 60

  /**
   * A faithful in-memory reimplementation of the real C-3 state machine
   * (`MicrosoftGraphSubscriptionStore`'s conditional `UPDATE`s), not just a
   * stub that always succeeds — review3 Important #4/Minor #1 flagged the
   * previous `markRunning` fake for always returning `true` regardless of
   * the row's actual state, which hid the consumer's missing CAS check.
   *
   * `requeueForRetry` is always present now: the port made it required
   * (re-review Important #4's "New-mechanism scrutiny" note), so the
   * consumer no longer has — and this fake no longer needs to exercise — a
   * fallback for a repository built without it.
   */
  function fakeSubscriptionRepository(row: MicrosoftGraphSubscription) {
    let current = row
    const calls = { markRunning: 0, finishRunning: 0, releaseQueued: 0, requeueForRetry: 0 }
    const stale = (now: number) => current.refreshStateAt < now - STALE_SECONDS
    const base = {
      async bySubscriptionId() { throw new Error('not used') },
      async forAccount(accountId: string) { return current.accountId === accountId ? [current] : [] },
      async insert() { throw new Error('not used') },
      async remove() { throw new Error('not used') },
      async update() { throw new Error('not used') },
      async due() { return [] },
      async markQueued(id: string, now: number) {
        if (current.id !== id) return false
        const claimed = current.refreshState === 'idle' || stale(now)
        if (claimed) current = { ...current, refreshState: 'queued', refreshStateAt: now }
        return claimed
      },
      async markPending(id: string) {
        current = { ...current, refreshPending: true }
      },
      async releaseQueued(id: string, now: number) {
        calls.releaseQueued += 1
        if (current.id !== id || current.refreshState !== 'queued') return false
        const hadPending = current.refreshPending
        current = {
          ...current,
          refreshState: hadPending ? 'queued' : 'idle',
          refreshPending: false,
          refreshStateAt: now,
        }
        return hadPending
      },
      async markRunning(id: string, now: number) {
        calls.markRunning += 1
        if (current.id !== id) return false
        const claimed = current.refreshState === 'queued' || stale(now)
        if (claimed) current = { ...current, refreshState: 'running', refreshStateAt: now }
        return claimed
      },
      async finishRunning(id: string, now: number) {
        calls.finishRunning += 1
        if (current.id !== id) return { requeue: false }
        const requeue = current.refreshPending
        current = { ...current, refreshState: requeue ? 'queued' : 'idle', refreshPending: false, refreshStateAt: now }
        return { requeue }
      },
    }
    const repository: MicrosoftGraphSubscriptionRepository = {
      ...base,
      async requeueForRetry(id: string, now: number) {
        calls.requeueForRetry += 1
        if (current.id !== id) return false
        const claimed = current.refreshState === 'running'
        if (claimed) current = { ...current, refreshState: 'queued', refreshStateAt: now }
        return claimed
      },
    }
    configureMicrosoftGraphSubscriptionRuntime({
      repositoryFor: () => repository,
      clientFor: () => { throw new Error('not used') },
    })
    return { current: () => current, calls, repository }
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
    const { current } = fakeSubscriptionRepository(subscriptionFixture({ refreshState: 'queued', refreshPending: true }))
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
    const { current } = fakeSubscriptionRepository(subscriptionFixture({ refreshState: 'queued' }))
    const { env } = await testEnv()
    const send = vi.fn(async () => undefined)
    ;(env as unknown as { MAIL_QUEUE: { send: typeof send } }).MAIL_QUEUE = { send }
    const { message, ack } = folderRefreshMessage()

    await consumeMicrosoftFolderRefreshJob(message, env)

    expect(ack).toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(current().refreshState).toBe('idle')
  })

  it('acks a duplicate/stale delivery that cannot claim the C-3 CAS and does zero refresh work (Important #4)', async () => {
    const { transport, folderState } = trackedTransport('graph')
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'graph' })
    // Already `running` and fresh (not stale): the real owner has this
    // claimed, so a second, concurrent delivery of the same notification
    // must not also refresh. `consumeMicrosoftFolderRefreshJob` uses real
    // wall-clock time internally, so "fresh" must be relative to that, not
    // to the fixture's fixed `NOW` constant (which is otherwise always
    // "ancient" and, before this fix, always looked stale).
    const freshNow = Math.floor(Date.now() / 1000)
    const { current, calls } = fakeSubscriptionRepository(subscriptionFixture({ refreshState: 'running', refreshStateAt: freshNow }))
    const { env } = await testEnv()
    const { message, retry, ack } = folderRefreshMessage()

    await consumeMicrosoftFolderRefreshJob(message, env)

    expect(ack).toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
    expect(folderState).not.toHaveBeenCalled()
    expect(resolveMicrosoftTransport).not.toHaveBeenCalled()
    expect(calls.finishRunning).toBe(0)
    expect(current().refreshState).toBe('running')
  })

  it('a retry redelivery claims the CAS after the first attempt hands the row back to queued (Important #4)', async () => {
    const { transport } = trackedTransport('graph')
    resolveMicrosoftTransport.mockRejectedValue(new MicrosoftGraphError('graph_unavailable', 503, true))
    // `queued`, as it would be right after a notification's `markQueued`
    // sent this very message.
    const { current, calls } = fakeSubscriptionRepository(subscriptionFixture({ refreshState: 'queued' }))
    const { env } = await testEnv()
    const { message: first, retry } = folderRefreshMessage(1)

    await consumeMicrosoftFolderRefreshJob(first, env)

    expect(retry).toHaveBeenCalledWith({ delaySeconds: 30 })
    // Retry ownership modelled explicitly: back to `queued` for the
    // redelivery, never through `finishRunning`'s running->idle path.
    expect(calls.requeueForRetry).toBe(1)
    expect(calls.finishRunning).toBe(0)
    expect(current().refreshState).toBe('queued')

    // The platform redelivers the same logical message (attempts=2). It must
    // be able to claim queued->running exactly like a fresh claim would.
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'graph' })
    const { message: second, ack: secondAck } = folderRefreshMessage(2)
    await consumeMicrosoftFolderRefreshJob(second, env)

    expect(secondAck).toHaveBeenCalled()
    expect(current().refreshState).toBe('idle')
  })

  it('acks and makes zero Graph calls when no subscription row matches the (account, folder) (re-review Important #4)', async () => {
    const { transport, folderState, close } = trackedTransport('graph')
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'graph' })
    // A repository IS configured (runtime present), but `forAccount` returns
    // nothing for this folder — e.g. a delayed duplicate delivered after
    // teardown or reconciliation deleted the row.
    configureMicrosoftGraphSubscriptionRuntime({
      repositoryFor: () => ({
        async bySubscriptionId() { throw new Error('not used') },
        async forAccount() { return [] },
        async insert() { throw new Error('not used') },
        async remove() { throw new Error('not used') },
        async update() { throw new Error('not used') },
        async due() { return [] },
        async markQueued() { throw new Error('not used') },
        async markPending() { throw new Error('not used') },
        async releaseQueued() { throw new Error('not used') },
        async markRunning() { throw new Error('not used') },
        async finishRunning() { throw new Error('not used') },
        async requeueForRetry() { throw new Error('not used') },
      }),
      clientFor: () => { throw new Error('not used') },
    })
    const { env } = await testEnv()
    const { message, retry, ack } = folderRefreshMessage()

    await consumeMicrosoftFolderRefreshJob(message, env)

    expect(ack).toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
    expect(resolveMicrosoftTransport).not.toHaveBeenCalled()
    expect(folderState).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('conditionally releases the queued follow-up slot when the follow-up send fails (Important #5/#8)', async () => {
    const { transport } = trackedTransport('graph')
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'graph' })
    const { current, calls } = fakeSubscriptionRepository(subscriptionFixture({ refreshState: 'queued', refreshPending: true }))
    const { env } = await testEnv()
    const send = vi.fn(async () => { throw new Error('queue unavailable') })
    ;(env as unknown as { MAIL_QUEUE: { send: typeof send } }).MAIL_QUEUE = { send }
    const { message, ack } = folderRefreshMessage()

    await consumeMicrosoftFolderRefreshJob(message, env)

    expect(ack).toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
    // finishRunning already resolved requeue=true (no pending was set after
    // it ran); the send failure must not leave the row stuck claiming a job
    // is in flight when none exists.
    expect(calls.releaseQueued).toBe(1)
    expect(current().refreshState).toBe('idle')
  })

  it('a send failure racing a fresh notification preserves the pending wakeup instead of erasing it (Important #8)', async () => {
    const { transport } = trackedTransport('graph')
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'graph' })
    const fixture = fakeSubscriptionRepository(subscriptionFixture({ refreshState: 'queued', refreshPending: true }))
    const { env } = await testEnv()
    let sendCalls = 0
    const send = vi.fn(async () => {
      sendCalls += 1
      if (sendCalls === 1) {
        // A fresh notification races in right as the follow-up send is
        // failing, observing the row already `queued` and only flagging it.
        await fixture.repository.markPending('sub-row-1', NOW)
        throw new Error('queue unavailable')
      }
    })
    ;(env as unknown as { MAIL_QUEUE: { send: typeof send } }).MAIL_QUEUE = { send }
    const { message, ack } = folderRefreshMessage()

    await consumeMicrosoftFolderRefreshJob(message, env)

    expect(ack).toHaveBeenCalled()
    // The preserved pending flag makes `releaseQueued` report that a job
    // must still be sent, so this same caller retries the enqueue once —
    // the row ends up `queued` because a message now genuinely exists for
    // it, not because the wakeup was silently dropped.
    expect(send).toHaveBeenCalledTimes(2)
    expect(fixture.current().refreshState).toBe('queued')
  })

  it('a double follow-up send failure with no further wakeup ends idle, not stuck queued (re-review Important #2)', async () => {
    const { transport } = trackedTransport('graph')
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'graph' })
    // `finishRunning` consumes this initial pending flag (requeue=true,
    // refresh_pending reset to false) before any send is attempted — so a
    // fresh wakeup must arrive DURING the first failing send for the
    // recovery loop's own `releaseQueued` to ever see `true`.
    const fixture = fakeSubscriptionRepository(subscriptionFixture({ refreshState: 'queued', refreshPending: true }))
    const { env } = await testEnv()
    let sendCalls = 0
    const send = vi.fn(async () => {
      sendCalls += 1
      if (sendCalls === 1) {
        // A fresh notification races in during the first failing send.
        await fixture.repository.markPending('sub-row-1', NOW)
      }
      throw new Error('queue unavailable') // both attempts fail
    })
    ;(env as unknown as { MAIL_QUEUE: { send: typeof send } }).MAIL_QUEUE = { send }
    const { message, ack } = folderRefreshMessage()

    await consumeMicrosoftFolderRefreshJob(message, env)

    expect(ack).toHaveBeenCalled()
    // Send #1 fails; the race sets `refresh_pending` again, so `releaseQueued`
    // reports `true` (must resend). Send #2 fails too, but nothing raced in
    // this time, so `releaseQueued` reports `false` — recovery stops, never
    // a third send, and the row ends `idle` rather than stranded `queued`.
    expect(send).toHaveBeenCalledTimes(2)
    expect(fixture.calls.releaseQueued).toBe(2)
    expect(fixture.current().refreshState).toBe('idle')
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
