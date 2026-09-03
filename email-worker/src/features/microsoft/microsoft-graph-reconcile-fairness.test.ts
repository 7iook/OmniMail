import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../app/types'
import type { MicrosoftGraphSubscriptionRuntime } from './microsoft-graph-notifications'
import { reconcileMicrosoftGraphSubscriptions } from './microsoft-graph-reconcile'
import { MicrosoftGraphSubscriptionClient } from './microsoft-graph-subscriptions'
import type {
  MicrosoftGraphRemoteSubscription,
  MicrosoftGraphSubscription,
  MicrosoftGraphSubscriptionClient as MicrosoftGraphSubscriptionClientPort,
  MicrosoftGraphSubscriptionRepository,
} from './microsoft-types'

/**
 * Re-review 2 Important #2a/#2b integration tests. Split out of
 * `microsoft-graph-reconcile.test.ts` (`node scripts/check-file-lines.mjs`)
 * rather than sharing its private helpers across files — this duplicates the
 * small subset it needs, matching the CAS race test's own established
 * "duplicate rather than import across a fragile boundary" convention.
 */

const { microsoftAccountForSync } = vi.hoisted(() => ({ microsoftAccountForSync: vi.fn() }))
vi.mock('./microsoft-store', () => ({ microsoftAccountForSync }))

const { microsoftAccessToken } = vi.hoisted(() => ({ microsoftAccessToken: vi.fn() }))
vi.mock('./microsoft-token-manager', () => ({ microsoftAccessToken }))

const BASE_URL = 'https://omni-mail.example.workers.dev'
const NOW = 1_700_000_000

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
    async due() { return [] },
    async markQueued() { throw new Error('not used in reconciliation tests') },
    async markPending() { throw new Error('not used in reconciliation tests') },
    async releaseQueued() { throw new Error('not used in reconciliation tests') },
    async markRunning() { throw new Error('not used in reconciliation tests') },
    async finishRunning() { throw new Error('not used in reconciliation tests') },
  }
  return { repository, rows: () => [...rows.values()] }
}

function fakeClient(
  overrides: Partial<MicrosoftGraphSubscriptionClientPort> = {},
): MicrosoftGraphSubscriptionClientPort {
  return {
    create: vi.fn(async (): Promise<MicrosoftGraphRemoteSubscription> => ({
      subscriptionId: `created-${Math.random().toString(36).slice(2)}`,
      resource: 'r',
      notificationUrl: `${BASE_URL}/api/microsoft/graph/notifications`,
      expiresAt: NOW + 1_000,
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

function fakeEnv(options: { missingSubscriptionAccountIds?: string[] } = {}): Env {
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
              return { results: [] }
            },
            async run() { return { meta: { changes: 1 } } },
          }),
        }
      },
    },
  } as unknown as Env
}

describe('reconcileMicrosoftGraphSubscriptions · re-review 2 Important #2a/#2b', () => {
  beforeEach(() => {
    microsoftAccountForSync.mockReset().mockResolvedValue(account('acct-1'))
    microsoftAccessToken.mockReset().mockResolvedValue('graph-token')
  })

  it('Important #2a: exhaustion mid-list aborts the pass without marking any row', async () => {
    const existing = subscriptionRow({
      id: 'row-1', accountId: 'acct-1', subscriptionId: 'sub-1', nextAttemptAt: NOW + 999_999,
    })
    const { repository, rows } = fakeRepository([existing])
    // Always offers another page: proves the abort happens because the
    // budget ran out mid-list, not because the fake ran out of pages.
    const fetcher = vi.fn(async () => Response.json({
      value: [],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/subscriptions?$skiptoken=next',
    }))
    const runtime: MicrosoftGraphSubscriptionRuntime = {
      repositoryFor: () => repository,
      clientFor: (accessToken, requestBudget) => new MicrosoftGraphSubscriptionClient({
        accessToken, fetcher, budget: requestBudget,
      }),
    }
    const env = fakeEnv({ missingSubscriptionAccountIds: ['acct-1'] })
    // A deterministic clock: real time for the token/outer-list charges and
    // exactly one real page, then jumps past the 20s deadline so the very
    // next per-attempt check (the second page) reports exhausted.
    let calls = 0
    const nowMs = () => {
      calls += 1
      return calls <= 5 ? 1_000_000 : 1_000_000 + 25_000
    }

    await reconcileMicrosoftGraphSubscriptions(env, NOW, runtime, nowMs)

    // Exactly one real page was fetched before the second attempt's own
    // budget check stopped it — proving the boundary is mid-list, not
    // "never even started".
    expect(fetcher).toHaveBeenCalledTimes(1)
    // No repository mutation happened: `reconcileOrphans` never got past its
    // own `client.list()` call, so neither the remote-orphan removal loop
    // nor the local-orphan-delete loop ever ran.
    expect(rows()).toEqual([existing])
  })

  it('Important #2b: ten accounts whose create always fails transiently do not starve a healthy zero-row account', async () => {
    const failingIds = Array.from({ length: 10 }, (_, index) => `acct-fail-${String(index).padStart(2, '0')}`)
    const healthyId = 'acct-healthy'
    const accountIds = [...failingIds, healthyId]
    const { repository, rows } = fakeRepository([])
    microsoftAccountForSync.mockImplementation(async (_env: Env, id: string) => account(id))
    microsoftAccessToken.mockImplementation(async (_env: Env, acct: { id: string }) => acct.id)
    const failingClient = fakeClient({
      create: vi.fn(async (): Promise<MicrosoftGraphRemoteSubscription> => { throw { status: 503 } }),
    })
    const healthyClient = fakeClient()
    const runtime: MicrosoftGraphSubscriptionRuntime = {
      repositoryFor: () => repository,
      // `microsoftAccessToken` above is stubbed to hand back the account id
      // itself as the "access token", so this can route per account without
      // `clientFor` needing to know the account id directly.
      clientFor: (accessToken) => (accessToken === healthyId ? healthyClient : failingClient),
    }

    function fairnessEnv(): Env {
      return {
        ...fakeEnv({}),
        DB: {
          prepare(sql: string) {
            return {
              bind: () => ({
                async all() {
                  if (sql.includes("preferred_transport = 'graph'")) {
                    const marker = (id: string) => {
                      const values = rows().filter((row) => row.accountId === id).map((row) => row.updatedAt)
                      return values.length ? Math.min(...values) : null
                    }
                    const ordered = [...accountIds].sort((a, b) => {
                      const ma = marker(a)
                      const mb = marker(b)
                      if (ma === mb) return a.localeCompare(b)
                      if (ma === null) return -1
                      if (mb === null) return 1
                      return ma - mb
                    })
                    return { results: ordered.slice(0, 10).map((id) => ({ id })) }
                  }
                  return { results: [] }
                },
                async run() { return { meta: { changes: 1 } } },
              }),
            }
          },
        },
      } as unknown as Env
    }

    await reconcileMicrosoftGraphSubscriptions(fairnessEnv(), NOW, runtime)

    // Tick 1: the ten failing accounts fill the batch (all zero-row, tied);
    // each ambiguous create failure leaves a stale marker instead of zero
    // rows, so the healthy account — 11th alphabetically — is left out.
    expect(rows().some((row) => row.accountId === healthyId)).toBe(false)
    expect(new Set(rows().map((row) => row.accountId))).toEqual(new Set(failingIds))

    await reconcileMicrosoftGraphSubscriptions(fairnessEnv(), NOW + 1, runtime)

    // Tick 2: the stale markers give the failing accounts a real
    // `updated_at`, so the still-zero-row healthy account now sorts first
    // and is reconciled for real — within two ticks, not starved forever.
    const healthyRows = rows().filter((row) => row.accountId === healthyId)
    expect(healthyRows).toHaveLength(2)
    expect(healthyRows.every((row) => row.status === 'active' && row.subscriptionId !== null)).toBe(true)
  })
})
