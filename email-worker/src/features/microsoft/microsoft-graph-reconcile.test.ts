import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../app/types'
import type { MicrosoftGraphSubscriptionRuntime } from './microsoft-graph-notifications'
import { reconcileMicrosoftGraphSubscriptions } from './microsoft-graph-reconcile'
import type {
  MicrosoftGraphRemoteSubscription,
  MicrosoftGraphSubscription,
  MicrosoftGraphSubscriptionClient,
  MicrosoftGraphSubscriptionRepository,
} from './microsoft-types'

const { microsoftAccountForSync } = vi.hoisted(() => ({ microsoftAccountForSync: vi.fn() }))
vi.mock('./microsoft-store', () => ({ microsoftAccountForSync }))

const { microsoftAccessToken } = vi.hoisted(() => ({ microsoftAccessToken: vi.fn() }))
vi.mock('./microsoft-token-manager', () => ({ microsoftAccessToken }))

const BASE_URL = 'https://omni-mail.example.workers.dev'
const NOW = 1_700_000_000
const SUBSCRIPTION_LIFETIME_SECONDS = 7 * 24 * 60 * 60 - 60 * 60
const RENEW_LEAD_SECONDS = 24 * 60 * 60

function account(id: string, preferredTransport: 'graph' | 'imap' = 'graph') {
  return { id, preferredTransport } as never
}

function subscriptionRow(overrides: Partial<MicrosoftGraphSubscription> = {}): MicrosoftGraphSubscription {
  return {
    id: `row-${Math.random().toString(36).slice(2)}`,
    accountId: 'acct-1',
    folderPath: 'INBOX',
    subscriptionId: 'graph-sub-1',
    clientStateHash: 'hash',
    expiresAt: NOW + 60,
    status: 'active',
    failureCount: 0,
    nextAttemptAt: NOW - 1,
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

/** In-memory repository implementing the frozen port — real enough to exercise the reconcile pass. */
function fakeRepository(initialRows: MicrosoftGraphSubscription[] = []) {
  const rows = new Map(initialRows.map((row) => [row.id, row]))
  const repository: MicrosoftGraphSubscriptionRepository = {
    async bySubscriptionId(subscriptionId) {
      return [...rows.values()].find((row) => row.subscriptionId === subscriptionId) ?? null
    },
    async forAccount(accountId) {
      return [...rows.values()].filter((row) => row.accountId === accountId)
    },
    async insert(row, now) {
      rows.set(row.id, { ...row, createdAt: now, updatedAt: now })
    },
    async remove(id) { rows.delete(id) },
    async update(id, patch, now) {
      const row = rows.get(id)
      if (!row) return null
      const updated = { ...row, ...patch, updatedAt: now }
      rows.set(id, updated)
      return updated
    },
    async due(now, limit) {
      return [...rows.values()]
        .filter((row) => row.nextAttemptAt <= now)
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
        .slice(0, limit)
    },
    async markQueued() { throw new Error('not used in reconciliation tests') },
    async markPending() { throw new Error('not used in reconciliation tests') },
    async releaseQueued() { throw new Error('not used in reconciliation tests') },
    async markRunning() { throw new Error('not used in reconciliation tests') },
    async finishRunning() { throw new Error('not used in reconciliation tests') },
  }
  return { repository, rows: () => [...rows.values()] }
}

function fakeClient(overrides: Partial<MicrosoftGraphSubscriptionClient> = {}): MicrosoftGraphSubscriptionClient {
  return {
    create: vi.fn(async (): Promise<MicrosoftGraphRemoteSubscription> => ({
      subscriptionId: `created-${Math.random().toString(36).slice(2)}`,
      resource: 'r',
      notificationUrl: `${BASE_URL}/api/microsoft/graph/notifications`,
      expiresAt: NOW + SUBSCRIPTION_LIFETIME_SECONDS,
    })),
    renew: vi.fn(async (subscriptionId: string, expiresAt: number): Promise<MicrosoftGraphRemoteSubscription> => ({
      subscriptionId,
      resource: 'r',
      notificationUrl: `${BASE_URL}/api/microsoft/graph/notifications`,
      expiresAt,
    })),
    remove: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    ...overrides,
  }
}

function fakeEnv(options: {
  missingSubscriptionAccountIds?: string[]
  nonGraphAccountIds?: string[]
} = {}): Env {
  return {
    MICROSOFT_GRAPH_WEBHOOK_BASE_URL: BASE_URL,
    DB: {
      prepare(sql: string) {
        return {
          bind: () => ({
            async all() {
              if (sql.includes("preferred_transport = 'graph'")) {
                return { results: (options.missingSubscriptionAccountIds ?? []).map((id) => ({ id })) }
              }
              if (sql.includes("preferred_transport != 'graph'")) {
                return { results: (options.nonGraphAccountIds ?? []).map((id) => ({ id })) }
              }
              return { results: [] }
            },
          }),
        }
      },
    },
  } as unknown as Env
}

function runtimeFor(
  repository: MicrosoftGraphSubscriptionRepository,
  client: MicrosoftGraphSubscriptionClient,
): MicrosoftGraphSubscriptionRuntime {
  return { repositoryFor: () => repository, clientFor: () => client }
}

describe('reconcileMicrosoftGraphSubscriptions (C-2, C-5)', () => {
  beforeEach(() => {
    microsoftAccountForSync.mockReset().mockResolvedValue(account('acct-1'))
    microsoftAccessToken.mockReset().mockResolvedValue('graph-token')
  })

  it('does nothing when the webhook base URL is unset (push disabled)', async () => {
    const { repository, rows } = fakeRepository([subscriptionRow()])
    const client = fakeClient()
    const env = { ...fakeEnv({}), MICROSOFT_GRAPH_WEBHOOK_BASE_URL: undefined } as Env

    await reconcileMicrosoftGraphSubscriptions(env, NOW, runtimeFor(repository, client))

    expect(client.renew).not.toHaveBeenCalled()
    expect(rows()).toHaveLength(1)
  })

  it('renews a due active subscription and reschedules the next check 24h before the new expiry', async () => {
    const { repository, rows } = fakeRepository([subscriptionRow()])
    const client = fakeClient()

    await reconcileMicrosoftGraphSubscriptions(fakeEnv(), NOW, runtimeFor(repository, client))

    expect(client.renew).toHaveBeenCalledWith('graph-sub-1', NOW + SUBSCRIPTION_LIFETIME_SECONDS)
    const [row] = rows()
    expect(row).toMatchObject({ status: 'active', failureCount: 0 })
    expect(row.nextAttemptAt).toBe(row.expiresAt - RENEW_LEAD_SECONDS)
  })

  it('a permanent rejection (403) on renew marks the row rejected and retries in 24h (C-5)', async () => {
    const { repository, rows } = fakeRepository([subscriptionRow()])
    const client = fakeClient({ renew: vi.fn(async () => { throw { status: 403 } }) })

    await reconcileMicrosoftGraphSubscriptions(fakeEnv(), NOW, runtimeFor(repository, client))

    const [row] = rows()
    expect(row).toMatchObject({ status: 'rejected', failureCount: 1 })
    expect(row.nextAttemptAt).toBe(NOW + 24 * 60 * 60)
  })

  it('a transient failure (503) on renew backs off without rejecting the subscription (C-5)', async () => {
    const { repository, rows } = fakeRepository([subscriptionRow({ failureCount: 0 })])
    const client = fakeClient({ renew: vi.fn(async () => { throw { status: 503 } }) })

    await reconcileMicrosoftGraphSubscriptions(fakeEnv(), NOW, runtimeFor(repository, client))

    const [row] = rows()
    expect(row).toMatchObject({ status: 'active', failureCount: 1 })
    expect(row.nextAttemptAt).toBe(NOW + 5 * 60)
  })

  it('retrying a rejected row that now succeeds returns it to active', async () => {
    const { repository, rows } = fakeRepository([subscriptionRow({ status: 'rejected', failureCount: 2 })])
    const client = fakeClient()

    await reconcileMicrosoftGraphSubscriptions(fakeEnv(), NOW, runtimeFor(repository, client))

    expect(client.renew).toHaveBeenCalled()
    expect(rows()[0]).toMatchObject({ status: 'active', failureCount: 0 })
  })

  it('a stale row (lifecycle event) is removed then recreated with a fresh clientState', async () => {
    const staleRow = subscriptionRow({ status: 'stale', subscriptionId: 'old-sub' })
    const { repository, rows } = fakeRepository([staleRow])
    const client = fakeClient()

    await reconcileMicrosoftGraphSubscriptions(fakeEnv(), NOW, runtimeFor(repository, client))

    expect(client.remove).toHaveBeenCalledWith('old-sub')
    expect(client.create).toHaveBeenCalledTimes(1)
    const [row] = rows()
    expect(row.status).toBe('active')
    expect(row.subscriptionId).not.toBe('old-sub')
  })

  it('processes at most 10 due rows per pass (C-5 fairness)', async () => {
    const many = Array.from({ length: 15 }, (_, index) => subscriptionRow({
      id: `row-${index}`, subscriptionId: `sub-${index}`, nextAttemptAt: NOW - index,
    }))
    const { repository } = fakeRepository(many)
    const client = fakeClient()

    await reconcileMicrosoftGraphSubscriptions(fakeEnv(), NOW, runtimeFor(repository, client))

    expect(client.renew).toHaveBeenCalledTimes(10)
  })

  it('creates both Inbox and Junk Email subscriptions for a Graph account that has none', async () => {
    const { repository, rows } = fakeRepository([])
    const client = fakeClient()
    const env = fakeEnv({ missingSubscriptionAccountIds: ['acct-1'] })

    await reconcileMicrosoftGraphSubscriptions(env, NOW, runtimeFor(repository, client))

    expect(client.create).toHaveBeenCalledTimes(2)
    expect(rows().map((row) => row.folderPath).sort()).toEqual(['INBOX', 'Junk Email'])
    expect(rows().every((row) => row.accountId === 'acct-1' && row.status === 'active')).toBe(true)
  })

  it('C-2: an orphaned remote subscription pointed at our endpoint is removed, and a local row missing remotely is dropped and rebuilt', async () => {
    const staleLocal = subscriptionRow({ id: 'row-1', folderPath: 'INBOX', subscriptionId: 'sub-gone' })
    const { repository, rows } = fakeRepository([staleLocal])
    const remoteOrphan: MicrosoftGraphRemoteSubscription = {
      subscriptionId: 'orphan-1',
      resource: 'r',
      notificationUrl: `${BASE_URL}/api/microsoft/graph/notifications`,
      expiresAt: NOW + 100,
    }
    const client = fakeClient({ list: vi.fn(async () => [remoteOrphan]) })
    const env = fakeEnv({ missingSubscriptionAccountIds: ['acct-1'] })

    await reconcileMicrosoftGraphSubscriptions(env, NOW, runtimeFor(repository, client))

    expect(client.remove).toHaveBeenCalledWith('orphan-1')
    expect(rows().some((row) => row.subscriptionId === 'sub-gone')).toBe(false)
    // The deleted row is recreated in the same pass, for both fixed folders.
    expect(rows().map((row) => row.folderPath).sort()).toEqual(['INBOX', 'Junk Email'])
  })

  it('C-2 does not touch a remote subscription that is not ours (different notificationUrl)', async () => {
    const { repository } = fakeRepository([])
    const foreign: MicrosoftGraphRemoteSubscription = {
      subscriptionId: 'someone-elses-app',
      resource: 'r',
      notificationUrl: 'https://not-us.example.com/hook',
      expiresAt: NOW + 100,
    }
    const client = fakeClient({ list: vi.fn(async () => [foreign]) })
    const env = fakeEnv({ missingSubscriptionAccountIds: ['acct-1'] })

    await reconcileMicrosoftGraphSubscriptions(env, NOW, runtimeFor(repository, client))

    expect(client.remove).not.toHaveBeenCalled()
  })

  it('removes remote and local subscriptions for an account that flipped away from Graph', async () => {
    // Not due (`nextAttemptAt` far in the future) so this test isolates the
    // non-Graph cleanup step from the due-scan step.
    const row = subscriptionRow({ id: 'row-1', accountId: 'acct-2', nextAttemptAt: NOW + 999_999 })
    const { repository, rows } = fakeRepository([row])
    const client = fakeClient()
    const env = fakeEnv({ nonGraphAccountIds: ['acct-2'] })
    microsoftAccountForSync.mockResolvedValue(account('acct-2', 'imap'))

    await reconcileMicrosoftGraphSubscriptions(env, NOW, runtimeFor(repository, client))

    expect(client.remove).toHaveBeenCalledWith('graph-sub-1')
    expect(rows()).toHaveLength(0)
  })

  it('still deletes the local rows for a non-Graph account even when no Graph token is obtainable any more', async () => {
    const row = subscriptionRow({ id: 'row-1', accountId: 'acct-2', nextAttemptAt: NOW + 999_999 })
    const { repository, rows } = fakeRepository([row])
    const client = fakeClient()
    const env = fakeEnv({ nonGraphAccountIds: ['acct-2'] })
    microsoftAccountForSync.mockResolvedValue(account('acct-2', 'imap'))
    microsoftAccessToken.mockRejectedValue(new Error('no token'))

    await reconcileMicrosoftGraphSubscriptions(env, NOW, runtimeFor(repository, client))

    expect(client.remove).not.toHaveBeenCalled()
    expect(rows()).toHaveLength(0)
  })

  it('one account failing does not stop the rest of the due-scan pass (per-account isolation)', async () => {
    const failing = subscriptionRow({ id: 'row-1', accountId: 'acct-fail', subscriptionId: 'sub-fail' })
    const healthy = subscriptionRow({ id: 'row-2', accountId: 'acct-ok', subscriptionId: 'sub-ok' })
    const { repository, rows } = fakeRepository([failing, healthy])
    const client = fakeClient()
    microsoftAccountForSync.mockImplementation(async (_env: Env, accountId: string) => (
      accountId === 'acct-fail' ? null : account('acct-ok')
    ))

    await reconcileMicrosoftGraphSubscriptions(fakeEnv(), NOW, runtimeFor(repository, client))

    // The failing account's row is dropped (account gone); the healthy one still renews.
    expect(rows().find((row) => row.accountId === 'acct-ok')).toMatchObject({ status: 'active' })
    expect(rows().some((row) => row.accountId === 'acct-fail')).toBe(false)
  })
})
