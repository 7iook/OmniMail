import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../../app/types'
import {
  hashMicrosoftGraphClientState,
  processMicrosoftGraphLifecycleItems,
  type MicrosoftGraphLifecycleItem,
} from './microsoft-graph-notifications'
import type {
  MicrosoftGraphSubscription,
  MicrosoftGraphSubscriptionRepository,
} from './microsoft-types'

/**
 * Split out of `microsoft-graph-notifications.test.ts`
 * (`node scripts/check-file-lines.mjs`) — duplicates that file's small
 * `subscriptionFixture`/`fakeRepository` helpers rather than importing them
 * across a test-file boundary.
 */

const env = {} as Env
const SUB_ID = 'c3f5f0a2-7b9e-4c6a-9d1e-0f2a3b4c5d6e'
const NOW = 1_700_000_000

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
      const hadPending = row.refreshPending
      row = { ...row, refreshState: hadPending ? 'queued' : 'idle', refreshPending: false, refreshStateAt: now }
      return hadPending
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

describe('processMicrosoftGraphLifecycleItems', () => {
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
