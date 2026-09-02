import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../../app/types'
import {
  handleMicrosoftGraphLifecycle,
  handleMicrosoftGraphNotification,
  hashMicrosoftGraphClientState,
  MAX_NOTIFICATION_BODY_BYTES,
  MAX_NOTIFICATION_ITEMS,
  MICROSOFT_GRAPH_NOTIFICATION_PATH,
  processMicrosoftGraphLifecycleItems,
  processMicrosoftGraphNotificationItems,
  type MicrosoftGraphLifecycleItem,
  type MicrosoftGraphNotificationItem,
} from './microsoft-graph-notifications'
import type {
  MicrosoftGraphSubscription,
  MicrosoftGraphSubscriptionRepository,
} from './microsoft-types'

const env = {} as Env
const ORIGIN = 'https://omni-mail.example.workers.dev'
const SUB_ID = 'c3f5f0a2-7b9e-4c6a-9d1e-0f2a3b4c5d6e'

function post(body: unknown, query = '', headers: Record<string, string> = {}): Request {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return new Request(`${ORIGIN}${MICROSOFT_GRAPH_NOTIFICATION_PATH}${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: text,
  })
}

/**
 * A minimal `microsoft_imap_validation_limits` CAS counter, mirroring the SQL
 * `claimGraphNotificationAttempt` runs — real enough to exercise the CAS
 * outcome (`meta.changes`) without asserting on SQL text.
 */
function fakeValidationLimitsDb() {
  const limits = new Map<string, { windowStartedAt: number; count: number }>()
  let calls = 0
  return {
    get calls() { return calls },
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        async run() {
          if (!sql.includes('microsoft_imap_validation_limits')) return { meta: { changes: 0 } }
          calls += 1
          const [identity, windowStartedAt, , maxAttempts] = args as [string, number, number, number]
          const existing = limits.get(identity)
          if (!existing || existing.windowStartedAt !== windowStartedAt) {
            limits.set(identity, { windowStartedAt, count: 1 })
            return { meta: { changes: 1 } }
          }
          if (existing.count < maxAttempts) {
            existing.count += 1
            return { meta: { changes: 1 } }
          }
          return { meta: { changes: 0 } }
        },
        async first() { return null },
        async all() { return { results: [] } },
      }),
    }),
  }
}

function harness() {
  const deferred: Promise<unknown>[] = []
  const processed: MicrosoftGraphNotificationItem[][] = []
  const process = vi.fn(async (_env: Env, items: MicrosoftGraphNotificationItem[]) => {
    processed.push(items)
  })
  const db = fakeValidationLimitsDb()
  const harnessEnv = { DB: db } as unknown as Env
  const run = (request: Request, ip = '203.0.113.9') => handleMicrosoftGraphNotification(
    harnessEnv, request, ip, (task) => { deferred.push(task) }, process,
  )
  return { run, process, processed, db, settle: () => Promise.all(deferred) }
}

describe('Microsoft Graph notification endpoint · validation handshake (C-6 branch 1)', () => {
  it('echoes the validation token verbatim as text/plain and reads nothing else', async () => {
    const { run, process } = harness()
    const token = 'Validation: Testing client application reachability for subscription Request-Id: 1234'
    const request = post('{"value":[{"subscriptionId":"ignored"}]}', `?validationToken=${encodeURIComponent(token)}`)

    const response = await run(request)

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toMatch(/^text\/plain/)
    await expect(response.text()).resolves.toBe(token)
    expect(process).not.toHaveBeenCalled()
    // The body was never consumed: a handshake must not depend on it.
    expect(request.bodyUsed).toBe(false)
  })

  it('never touches D1 for a handshake, even with no DB configured at all', async () => {
    const response = await handleMicrosoftGraphNotification(
      env, // deliberately `{}` — this would throw if the handler read env.DB
      new Request(`${ORIGIN}${MICROSOFT_GRAPH_NOTIFICATION_PATH}?validationToken=abc`, { method: 'POST' }),
      '203.0.113.9', () => undefined, async () => undefined,
    )
    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('abc')
  })

  it('also answers the handshake on the lifecycle URL', async () => {
    const response = await handleMicrosoftGraphLifecycle(
      env,
      new Request(`${ORIGIN}/api/microsoft/graph/lifecycle?validationToken=abc`, { method: 'POST' }),
      '203.0.113.9', () => undefined, async () => undefined,
    )
    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('abc')
  })
})

describe('Microsoft Graph notification endpoint · notifications (C-6 branch 2, I-8)', () => {
  it('acknowledges with 202 before processing and defers the work', async () => {
    const { run, process, processed, settle } = harness()

    const response = await run(post({ value: [{
      subscriptionId: SUB_ID, clientState: 'secret', changeType: 'created', resource: 'me/mailFolders/inbox/messages/x',
    }] }))

    expect(response.status).toBe(202)
    await settle()
    expect(process).toHaveBeenCalledTimes(1)
    expect(processed[0]).toEqual([{
      subscriptionId: SUB_ID, clientState: 'secret', changeType: 'created', resource: 'me/mailFolders/inbox/messages/x',
    }])
  })

  it('answers 202 and processes nothing for malformed, oversized or non-JSON bodies, but still counts the attempt', async () => {
    const { run, process, db, settle } = harness()
    const cases = [
      post('not json'),
      post({ nope: [] }),
      post({ value: 'not-an-array' }),
      post({ value: [] }, '', { 'content-length': String(MAX_NOTIFICATION_BODY_BYTES + 1) }),
      post('x'.repeat(MAX_NOTIFICATION_BODY_BYTES + 1)),
    ]
    for (const request of cases) {
      expect((await run(request)).status).toBe(202)
    }
    await settle()
    expect(process).not.toHaveBeenCalled()
    // Every one of the 5 requests above reached the IP counter (I-8 counts
    // garbage too), even though none of them ever produced an `items` array.
    expect(db.calls).toBe(5)
  })

  it('drops malformed items individually and caps the batch, without changing the response', async () => {
    const { run, processed, settle } = harness()
    const good = { subscriptionId: SUB_ID, clientState: 's', changeType: 'created', resource: 'r' }
    const value = [
      good,
      { subscriptionId: 'not-a-uuid', clientState: 's' },
      { subscriptionId: SUB_ID },
      null,
      'string',
      ...Array.from({ length: MAX_NOTIFICATION_ITEMS + 10 }, () => good),
    ]

    const response = await run(post({ value }))

    expect(response.status).toBe(202)
    await settle()
    // The first MAX_NOTIFICATION_ITEMS raw entries are considered; 4 of them are junk.
    expect(processed[0]).toHaveLength(MAX_NOTIFICATION_ITEMS - 4)
  })

  it('never lets a processor failure change the response', async () => {
    const deferred: Promise<unknown>[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const response = await handleMicrosoftGraphNotification(
      { DB: fakeValidationLimitsDb() } as unknown as Env,
      post({ value: [{ subscriptionId: SUB_ID, clientState: 's' }] }),
      '203.0.113.9',
      (task) => { deferred.push(task) },
      async () => { throw new Error('boom') },
    )
    expect(response.status).toBe(202)
    await Promise.all(deferred)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })
})

describe('Microsoft Graph notification endpoint · per-IP abuse guard (C-6)', () => {
  it('the 601st request from one IP inside a 10-minute window gets 202 without reaching the processor', async () => {
    const { run, process, settle } = harness()
    const request = () => post({ value: [{
      subscriptionId: SUB_ID, clientState: 's', changeType: 'created', resource: 'r',
    }] })
    for (let index = 0; index < 600; index += 1) {
      expect((await run(request(), '198.51.100.7')).status).toBe(202)
    }
    process.mockClear()

    const response = await run(request(), '198.51.100.7')

    expect(response.status).toBe(202)
    await settle()
    expect(process).not.toHaveBeenCalled()
  })

  it('tracks each IP independently', async () => {
    const { run, process, settle } = harness()
    for (let index = 0; index < 600; index += 1) {
      await run(post({ value: [] }), '198.51.100.8')
    }
    process.mockClear()

    const response = await run(post({ value: [{
      subscriptionId: SUB_ID, clientState: 's', changeType: 'created', resource: 'r',
    }] }), '198.51.100.9')

    expect(response.status).toBe(202)
    await settle()
    expect(process).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// C-1 / C-3: the real notification/lifecycle processing logic, against a fake
// repository implementing the frozen `MicrosoftGraphSubscriptionRepository`
// port (P2-W2's real implementation is out of scope here per the brief).
// ---------------------------------------------------------------------------

function subscriptionFixture(overrides: Partial<MicrosoftGraphSubscription> = {}): MicrosoftGraphSubscription {
  return {
    id: 'sub-row-1',
    accountId: 'microsoft-1',
    folderPath: 'INBOX',
    subscriptionId: SUB_ID,
    clientStateHash: '',
    expiresAt: 0,
    status: 'active',
    failureCount: 0,
    nextAttemptAt: 0,
    refreshState: 'idle',
    refreshPending: false,
    refreshStateAt: 0,
    lastNotifiedAt: null,
    lastErrorCode: '',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function fakeRepository(initial: MicrosoftGraphSubscription | null) {
  let row = initial
  const repository: MicrosoftGraphSubscriptionRepository = {
    async bySubscriptionId(subscriptionId) {
      return row && row.subscriptionId === subscriptionId ? row : null
    },
    async forAccount(accountId) {
      return row && row.accountId === accountId ? [row] : []
    },
    async insert() { throw new Error('not used in these tests') },
    async remove() { throw new Error('not used in these tests') },
    async update(id, patch, now) {
      if (row && row.id === id) row = { ...row, ...patch, updatedAt: now }
      return row
    },
    async due() { return [] },
    async markQueued(id, now) {
      if (!row || row.id !== id || row.refreshState !== 'idle') return false
      row = { ...row, refreshState: 'queued', refreshStateAt: now }
      return true
    },
    async markPending(id, now) {
      if (row && row.id === id) row = { ...row, refreshPending: true, refreshStateAt: now }
    },
    async releaseQueued(id, now) {
      if (!row || row.id !== id || row.refreshState !== 'queued') return false
      row = { ...row, refreshState: 'idle', refreshStateAt: now }
      return true
    },
    async markRunning(id, now) {
      if (!row || row.id !== id) return false
      row = { ...row, refreshState: 'running', refreshStateAt: now }
      return true
    },
    async finishRunning(id, now) {
      if (!row || row.id !== id) return { requeue: false }
      const requeue = row.refreshPending
      row = { ...row, refreshState: requeue ? 'queued' : 'idle', refreshPending: false, refreshStateAt: now }
      return { requeue }
    },
  }
  return { repository, current: () => row }
}

describe('processMicrosoftGraphNotificationItems (C-1, C-3)', () => {
  const NOW = 1_700_000_000

  async function envWithQueue(): Promise<{ env: Env; send: ReturnType<typeof vi.fn> }> {
    const send = vi.fn(async () => undefined)
    return { env: { MAIL_QUEUE: { send } } as unknown as Env, send }
  }

  it('happy path: matching clientState enqueues exactly one job with the frozen shape', async () => {
    const hash = await hashMicrosoftGraphClientState('right-state')
    const { repository, current } = fakeRepository(subscriptionFixture({ clientStateHash: hash }))
    const { env: queueEnv, send } = await envWithQueue()

    await processMicrosoftGraphNotificationItems(queueEnv, repository, [
      { subscriptionId: SUB_ID, clientState: 'right-state', changeType: 'created', resource: 'r' },
    ], NOW)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      kind: 'microsoft-folder-refresh',
      accountId: 'microsoft-1',
      folderPath: 'INBOX',
      reason: 'notification',
    })
    expect(current()?.refreshState).toBe('queued')
  })

  it('a clientState mismatch drops the notification without enqueueing', async () => {
    const hash = await hashMicrosoftGraphClientState('right-state')
    const { repository, current } = fakeRepository(subscriptionFixture({ clientStateHash: hash }))
    const { env: queueEnv, send } = await envWithQueue()

    await processMicrosoftGraphNotificationItems(queueEnv, repository, [
      { subscriptionId: SUB_ID, clientState: 'wrong-state', changeType: 'created', resource: 'r' },
    ], NOW)

    expect(send).not.toHaveBeenCalled()
    expect(current()?.refreshState).toBe('idle')
  })

  it('an unknown subscriptionId is dropped silently', async () => {
    const { repository } = fakeRepository(null)
    const { env: queueEnv, send } = await envWithQueue()

    await processMicrosoftGraphNotificationItems(queueEnv, repository, [
      { subscriptionId: SUB_ID, clientState: 'anything', changeType: 'created', resource: 'r' },
    ], NOW)

    expect(send).not.toHaveBeenCalled()
  })

  it('a second notification while queued sets pending and does not send a second job', async () => {
    const hash = await hashMicrosoftGraphClientState('right-state')
    const { repository, current } = fakeRepository(
      subscriptionFixture({ clientStateHash: hash, refreshState: 'queued' }),
    )
    const { env: queueEnv, send } = await envWithQueue()

    await processMicrosoftGraphNotificationItems(queueEnv, repository, [
      { subscriptionId: SUB_ID, clientState: 'right-state', changeType: 'created', resource: 'r' },
    ], NOW)

    expect(send).not.toHaveBeenCalled()
    expect(current()).toMatchObject({ refreshState: 'queued', refreshPending: true })
  })

  it('a notification while running also just sets pending', async () => {
    const hash = await hashMicrosoftGraphClientState('right-state')
    const { repository, current } = fakeRepository(
      subscriptionFixture({ clientStateHash: hash, refreshState: 'running' }),
    )
    const { env: queueEnv, send } = await envWithQueue()

    await processMicrosoftGraphNotificationItems(queueEnv, repository, [
      { subscriptionId: SUB_ID, clientState: 'right-state', changeType: 'created', resource: 'r' },
    ], NOW)

    expect(send).not.toHaveBeenCalled()
    expect(current()).toMatchObject({ refreshState: 'running', refreshPending: true })
  })

  it('a queue send failure releases the slot back to idle', async () => {
    const hash = await hashMicrosoftGraphClientState('right-state')
    const { repository, current } = fakeRepository(subscriptionFixture({ clientStateHash: hash }))
    const env2 = { MAIL_QUEUE: { send: vi.fn(async () => { throw new Error('queue down') }) } } as unknown as Env
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await processMicrosoftGraphNotificationItems(env2, repository, [
      { subscriptionId: SUB_ID, clientState: 'right-state', changeType: 'created', resource: 'r' },
    ], NOW)

    expect(current()?.refreshState).toBe('idle')
    errorSpy.mockRestore()
  })

  it('a 50-notification storm for the same subscription enqueues exactly one refresh', async () => {
    const hash = await hashMicrosoftGraphClientState('right-state')
    const { repository } = fakeRepository(subscriptionFixture({ clientStateHash: hash }))
    const { env: queueEnv, send } = await envWithQueue()
    const items: MicrosoftGraphNotificationItem[] = Array.from({ length: 50 }, () => ({
      subscriptionId: SUB_ID, clientState: 'right-state', changeType: 'created', resource: 'r',
    }))

    await processMicrosoftGraphNotificationItems(queueEnv, repository, items, NOW)

    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('processMicrosoftGraphLifecycleItems', () => {
  const NOW = 1_700_000_000

  it('subscriptionRemoved marks the row stale so cron rebuilds it', async () => {
    const hash = await hashMicrosoftGraphClientState('right-state')
    const { repository, current } = fakeRepository(subscriptionFixture({ clientStateHash: hash }))
    const item: MicrosoftGraphLifecycleItem = {
      subscriptionId: SUB_ID, clientState: 'right-state', lifecycleEvent: 'subscriptionRemoved',
    }

    await processMicrosoftGraphLifecycleItems(env, repository, [item], NOW)

    expect(current()?.status).toBe('stale')
  })

  it('reauthorizationRequired marks the row stale', async () => {
    const hash = await hashMicrosoftGraphClientState('right-state')
    const { repository, current } = fakeRepository(subscriptionFixture({ clientStateHash: hash }))
    const item: MicrosoftGraphLifecycleItem = {
      subscriptionId: SUB_ID, clientState: 'right-state', lifecycleEvent: 'reauthorizationRequired',
    }

    await processMicrosoftGraphLifecycleItems(env, repository, [item], NOW)

    expect(current()?.status).toBe('stale')
  })

  it('missed is treated as a notification: it enqueues a refresh', async () => {
    const hash = await hashMicrosoftGraphClientState('right-state')
    const { repository, current } = fakeRepository(subscriptionFixture({ clientStateHash: hash }))
    const send = vi.fn(async () => undefined)
    const queueEnv = { MAIL_QUEUE: { send } } as unknown as Env
    const item: MicrosoftGraphLifecycleItem = {
      subscriptionId: SUB_ID, clientState: 'right-state', lifecycleEvent: 'missed',
    }

    await processMicrosoftGraphLifecycleItems(queueEnv, repository, [item], NOW)

    expect(send).toHaveBeenCalledTimes(1)
    expect(current()?.refreshState).toBe('queued')
  })

  it('a clientState mismatch is dropped, even for a real lifecycle event', async () => {
    const hash = await hashMicrosoftGraphClientState('right-state')
    const { repository, current } = fakeRepository(subscriptionFixture({ clientStateHash: hash }))
    const item: MicrosoftGraphLifecycleItem = {
      subscriptionId: SUB_ID, clientState: 'wrong-state', lifecycleEvent: 'subscriptionRemoved',
    }

    await processMicrosoftGraphLifecycleItems(env, repository, [item], NOW)

    expect(current()?.status).toBe('active')
  })

  it('an unrecognised lifecycle event is dropped without touching the row', async () => {
    const hash = await hashMicrosoftGraphClientState('right-state')
    const { repository, current } = fakeRepository(subscriptionFixture({ clientStateHash: hash }))
    const item: MicrosoftGraphLifecycleItem = {
      subscriptionId: SUB_ID, clientState: 'right-state', lifecycleEvent: 'somethingNew',
    }

    await processMicrosoftGraphLifecycleItems(env, repository, [item], NOW)

    expect(current()).toMatchObject({ status: 'active', refreshState: 'idle' })
  })
})