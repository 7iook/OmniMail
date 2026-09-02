import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { Env } from '../../app/types'
import { WRANGLER_MIGRATION_NAMES } from '../../platform/d1/schema-migrations'
import { MicrosoftGraphSubscriptionStore } from './microsoft-graph-subscription-store'
import type { MicrosoftGraphSubscription } from './microsoft-types'

/**
 * Real-SQLite repository tests (follows `microsoft-sync-folder.upsert.test.ts`
 * and `schema-shape.test.ts`): the C-3 state machine is a set of conditional
 * `UPDATE ... WHERE`/`RETURNING` statements whose atomicity a hand-built fake
 * D1 cannot exercise honestly — only running the real SQL against the real
 * schema proves the CAS actually excludes a racing caller.
 */

const ACCOUNT = 'acct_subs'
const T0 = 1_700_000_000

function applyDiskMigrations(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  for (const name of WRANGLER_MIGRATION_NAMES) {
    const sql = readFileSync(`migrations/${name}`, 'utf8')
    try {
      db.exec(sql)
    } catch (error) {
      throw new Error(`migration ${name} failed: ${(error as Error).message}`)
    }
  }
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

function seedAccount(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO users (id, email, display_name, password_hash)
     VALUES ('user_subs', 'owner@example.com', 'Owner', 'hash')`,
  ).run()
  db.prepare(
    `INSERT INTO microsoft_imap_accounts (
       id, user_id, name, provided_email, normalized_email, auth_mode,
       client_id, refresh_token_cipher, created_at, updated_at
     ) VALUES (?, 'user_subs', 'Outlook', 'user@outlook.com', 'user@outlook.com',
       'oauth2', 'client', 'cipher', ?, ?)`,
  ).run(ACCOUNT, T0, T0)
}

/** The slice of `D1Database` the store touches, executed for real against `db`. */
function realEnv(db: DatabaseSync): Env {
  return {
    DB: {
      prepare: (sql: string) => {
        const state = { bindings: [] as unknown[] }
        const api = {
          bind: (...bindings: unknown[]) => { state.bindings = bindings; return api },
          first: async <T>() => (db.prepare(sql).get(...(state.bindings as never[])) as T | undefined) ?? null,
          all: async <T>() => ({ results: db.prepare(sql).all(...(state.bindings as never[])) as T[] }),
          run: async () => {
            const { changes } = db.prepare(sql).run(...(state.bindings as never[]))
            return { meta: { changes } }
          },
        }
        return api
      },
    },
  } as unknown as Env
}

function harness() {
  const db = applyDiskMigrations()
  seedAccount(db)
  const env = realEnv(db)
  return { db, env, store: new MicrosoftGraphSubscriptionStore(env) }
}

function row(overrides: Partial<Omit<MicrosoftGraphSubscription, 'createdAt' | 'updatedAt'>> = {}) {
  return {
    id: 'sub_row_1',
    accountId: ACCOUNT,
    folderPath: 'INBOX',
    subscriptionId: 'remote-sub-1',
    clientStateHash: 'a'.repeat(64),
    expiresAt: T0 + 7 * 24 * 3_600,
    status: 'active' as const,
    failureCount: 0,
    nextAttemptAt: T0 + 6 * 24 * 3_600,
    refreshState: 'idle' as const,
    refreshPending: false,
    refreshStateAt: T0,
    lastNotifiedAt: null,
    lastErrorCode: '',
    ...overrides,
  }
}

describe('Microsoft Graph subscription repository — identity & lookups', () => {
  it('inserts and reads a row back by id, subscription id and account', async () => {
    const { store } = harness()
    await store.insert(row(), T0)

    const bySub = await store.bySubscriptionId('remote-sub-1')
    expect(bySub).toMatchObject({ id: 'sub_row_1', accountId: ACCOUNT, folderPath: 'INBOX' })
    expect(bySub?.refreshPending).toBe(false)

    const forAccount = await store.forAccount(ACCOUNT)
    expect(forAccount).toHaveLength(1)
    expect(forAccount[0].subscriptionId).toBe('remote-sub-1')
  })

  it('cascades the row away when the account row is deleted (FK ON DELETE CASCADE)', async () => {
    const { db, store } = harness()
    await store.insert(row(), T0)
    db.prepare('DELETE FROM microsoft_imap_accounts WHERE id = ?').run(ACCOUNT)
    expect(await store.forAccount(ACCOUNT)).toEqual([])
  })

  it('removes a row directly', async () => {
    const { store } = harness()
    await store.insert(row(), T0)
    await store.remove('sub_row_1')
    expect(await store.bySubscriptionId('remote-sub-1')).toBeNull()
  })

  it('enforces one row per (account, folder)', async () => {
    const { store } = harness()
    await store.insert(row(), T0)
    await expect(store.insert(row({ id: 'sub_row_2', subscriptionId: 'remote-sub-2' }), T0))
      .rejects.toThrow(/UNIQUE constraint failed/)
  })
})

describe('Microsoft Graph subscription repository — 0038 nullable subscription_id (re-review Important #1)', () => {
  it('inserts and reads back a rejected row with subscription_id: null', async () => {
    const { store } = harness()
    await store.insert(row({ subscriptionId: null, status: 'rejected', failureCount: 1 }), T0)

    const forAccount = await store.forAccount(ACCOUNT)
    expect(forAccount).toHaveLength(1)
    expect(forAccount[0].subscriptionId).toBeNull()
    // A null id can never be matched by an incoming notification's lookup.
    expect(await store.bySubscriptionId('')).toBeNull()
  })

  it('the real 0038 CHECK constraint rejects an active row with a null subscription_id', async () => {
    const { store } = harness()
    await expect(store.insert(row({ subscriptionId: null, status: 'active' }), T0))
      .rejects.toThrow(/CHECK constraint failed/)
  })

  it('two rejected rows with null subscription_id do not collide on the partial unique index', async () => {
    const { store } = harness()
    await store.insert(row({ id: 'sub_row_1', folderPath: 'INBOX', subscriptionId: null, status: 'rejected' }), T0)
    await store.insert(row({ id: 'sub_row_2', folderPath: 'Junk Email', subscriptionId: null, status: 'rejected' }), T0)

    expect(await store.forAccount(ACCOUNT)).toHaveLength(2)
  })

  it('update() can move a row from null to a real subscriptionId (rebuild) and back is never needed', async () => {
    const { store } = harness()
    await store.insert(row({ subscriptionId: null, status: 'rejected' }), T0)

    const updated = await store.update('sub_row_1', {
      subscriptionId: 'remote-sub-1', status: 'active', failureCount: 0,
    }, T0 + 1)

    expect(updated).toMatchObject({ subscriptionId: 'remote-sub-1', status: 'active' })
  })
})

describe('Microsoft Graph subscription repository — update() and due()', () => {
  it('patches only the identity/scheduling columns named in the patch', async () => {
    const { store } = harness()
    await store.insert(row(), T0)
    const updated = await store.update('sub_row_1', { status: 'stale', failureCount: 2 }, T0 + 10)
    expect(updated).toMatchObject({ status: 'stale', failureCount: 2, folderPath: 'INBOX' })
  })

  it('returns null for an update on a row that no longer exists', async () => {
    const { store } = harness()
    expect(await store.update('missing', { status: 'stale' }, T0)).toBeNull()
  })

  it('due() returns rows whose next_attempt_at has arrived, oldest first, bounded', async () => {
    const { store } = harness()
    await store.insert(row({ id: 'a', subscriptionId: 'sa', folderPath: 'INBOX', nextAttemptAt: T0 + 30 }), T0)
    await store.insert(row({ id: 'b', subscriptionId: 'sb', folderPath: 'Junk Email', nextAttemptAt: T0 + 10 }), T0)
    await store.insert(row({ id: 'c', subscriptionId: 'sc', folderPath: 'Sent Items', nextAttemptAt: T0 + 9_999 }), T0)

    const due = await store.due(T0 + 100, 10)
    expect(due.map(({ id }) => id)).toEqual(['b', 'a'])
  })

  it('due() respects its limit', async () => {
    const { store } = harness()
    await store.insert(row({ id: 'a', subscriptionId: 'sa', folderPath: 'INBOX', nextAttemptAt: T0 }), T0)
    await store.insert(row({ id: 'b', subscriptionId: 'sb', folderPath: 'Junk Email', nextAttemptAt: T0 }), T0)
    expect(await store.due(T0 + 1, 1)).toHaveLength(1)
  })

  it('expiringSoon() flags active rows within the window regardless of next_attempt_at', async () => {
    const { store } = harness()
    await store.insert(row({
      id: 'a', subscriptionId: 'sa', nextAttemptAt: T0 + 9_999_999, expiresAt: T0 + 3_600,
    }), T0)
    expect((await store.expiringSoon(T0, 24 * 3_600, 10)).map(({ id }) => id)).toEqual(['a'])
    expect(await store.expiringSoon(T0, 60, 10)).toEqual([])
  })
})

describe('Microsoft Graph subscription repository — C-5 scheduling', () => {
  it('markRejected sets status=rejected, increments failure_count, and backs off 24h', async () => {
    const { store } = harness()
    await store.insert(row({ failureCount: 3 }), T0)
    await store.markRejected('sub_row_1', 'graph_subscription_rejected', T0)
    const updated = await store.bySubscriptionId('remote-sub-1')
    expect(updated).toMatchObject({
      status: 'rejected', failureCount: 4, lastErrorCode: 'graph_subscription_rejected',
      nextAttemptAt: T0 + 24 * 3_600,
    })
  })

  it('markTransientFailure backs off 5m → 15m → 1h → 6h as failure_count climbs', async () => {
    const { store } = harness()
    await store.insert(row({ failureCount: 0 }), T0)

    await store.markTransientFailure('sub_row_1', 'graph_subscription_transient', T0)
    expect((await store.bySubscriptionId('remote-sub-1'))?.nextAttemptAt).toBe(T0 + 5 * 60)

    await store.markTransientFailure('sub_row_1', 'graph_subscription_transient', T0)
    expect((await store.bySubscriptionId('remote-sub-1'))?.nextAttemptAt).toBe(T0 + 15 * 60)

    await store.markTransientFailure('sub_row_1', 'graph_subscription_transient', T0)
    expect((await store.bySubscriptionId('remote-sub-1'))?.nextAttemptAt).toBe(T0 + 60 * 60)

    await store.markTransientFailure('sub_row_1', 'graph_subscription_transient', T0)
    expect((await store.bySubscriptionId('remote-sub-1'))?.nextAttemptAt).toBe(T0 + 6 * 60 * 60)
    expect((await store.bySubscriptionId('remote-sub-1'))?.failureCount).toBe(4)

    // Capped: a 5th failure still backs off 6h, not further.
    await store.markTransientFailure('sub_row_1', 'graph_subscription_transient', T0)
    expect((await store.bySubscriptionId('remote-sub-1'))?.nextAttemptAt).toBe(T0 + 6 * 60 * 60)
  })

  it('markActive resets failure_count, sets status=active, and schedules renewal 24h before expiry', async () => {
    const { store } = harness()
    await store.insert(row({ failureCount: 2, status: 'rejected', lastErrorCode: 'graph_subscription_rejected' }), T0)
    const expiresAt = T0 + 7 * 24 * 3_600
    await store.markActive('sub_row_1', expiresAt, T0)
    expect(await store.bySubscriptionId('remote-sub-1')).toMatchObject({
      status: 'active', failureCount: 0, lastErrorCode: '', expiresAt,
      nextAttemptAt: expiresAt - 24 * 3_600,
    })
  })

  it('markStale sets status=stale and makes the row immediately due', async () => {
    const { store } = harness()
    await store.insert(row({ nextAttemptAt: T0 + 999_999 }), T0)
    await store.markStale('sub_row_1', 'graph_subscriptionRemoved', T0 + 50)
    expect(await store.bySubscriptionId('remote-sub-1')).toMatchObject({
      status: 'stale', lastErrorCode: 'graph_subscriptionRemoved', nextAttemptAt: T0 + 50,
    })
  })
})

describe('Microsoft Graph subscription repository — C-3 coalescing state machine', () => {
  it('idle → queued CAS: two racers, exactly one wins', async () => {
    const { store } = harness()
    await store.insert(row({ refreshState: 'idle' }), T0)

    const [first, second] = await Promise.all([
      store.markQueued('sub_row_1', T0),
      store.markQueued('sub_row_1', T0),
    ])

    expect([first, second].filter(Boolean)).toHaveLength(1)
    expect((await store.bySubscriptionId('remote-sub-1'))?.refreshState).toBe('queued')
  })

  it('a notification while queued/running sets pending instead of re-enqueuing', async () => {
    const { store } = harness()
    await store.insert(row({ refreshState: 'running' }), T0)
    await store.markPending('sub_row_1', T0)
    const updated = await store.bySubscriptionId('remote-sub-1')
    expect(updated?.refreshPending).toBe(true)
    expect(updated?.refreshState).toBe('running')
  })

  it('releaseQueued sends the row back to idle when the enqueue failed and nothing is pending', async () => {
    const { store } = harness()
    await store.insert(row({ refreshState: 'queued' }), T0)
    expect(await store.releaseQueued('sub_row_1', T0)).toBe(false)
    expect((await store.bySubscriptionId('remote-sub-1'))?.refreshState).toBe('idle')
    // Not queued any more: a second release is a no-op, not a double-release.
    expect(await store.releaseQueued('sub_row_1', T0)).toBe(false)
  })

  it('releaseQueued preserves a concurrently-set pending flag instead of erasing it (fix #8)', async () => {
    const { store } = harness()
    await store.insert(row({ refreshState: 'queued' }), T0)
    // A second notification races in while the first caller's send is still
    // failing: it sees `queued` and only flags pending, per C-3.
    await store.markPending('sub_row_1', T0 + 1)

    const mustResend = await store.releaseQueued('sub_row_1', T0 + 2)

    expect(mustResend).toBe(true)
    const row1 = await store.bySubscriptionId('remote-sub-1')
    // Still `queued`, not `idle`: erasing it here would leave the pending
    // notification's wakeup with nothing to ever act on it.
    expect(row1?.refreshState).toBe('queued')
    expect(row1?.refreshPending).toBe(false)
  })

  it('requeueForRetry hands a running row back to queued for the redelivery to reclaim (fix #4)', async () => {
    const { store } = harness()
    await store.insert(row({ refreshState: 'running' }), T0)

    expect(await store.requeueForRetry('sub_row_1', T0 + 1)).toBe(true)
    expect((await store.bySubscriptionId('remote-sub-1'))?.refreshState).toBe('queued')

    // The redelivery can now win the queued->running CAS exactly like a
    // fresh claim would.
    expect(await store.markRunning('sub_row_1', T0 + 2)).toBe(true)
  })

  it('requeueForRetry preserves a pending flag set mid-run, unlike finishRunning', async () => {
    const { store } = harness()
    await store.insert(row({ refreshState: 'running' }), T0)
    await store.markPending('sub_row_1', T0 + 1)

    await store.requeueForRetry('sub_row_1', T0 + 2)

    const updated = await store.bySubscriptionId('remote-sub-1')
    expect(updated?.refreshState).toBe('queued')
    expect(updated?.refreshPending).toBe(true)
  })

  it('requeueForRetry is a no-op when the row is not running', async () => {
    const { store } = harness()
    await store.insert(row({ refreshState: 'idle' }), T0)
    expect(await store.requeueForRetry('sub_row_1', T0)).toBe(false)
    expect((await store.bySubscriptionId('remote-sub-1'))?.refreshState).toBe('idle')
  })

  it('queued → running CAS', async () => {
    const { store } = harness()
    await store.insert(row({ refreshState: 'queued' }), T0)
    expect(await store.markRunning('sub_row_1', T0)).toBe(true)
    expect((await store.bySubscriptionId('remote-sub-1'))?.refreshState).toBe('running')
  })

  it('finishRunning re-queues exactly once when a notification arrived mid-run', async () => {
    const { store } = harness()
    await store.insert(row({ refreshState: 'running' }), T0)
    await store.markPending('sub_row_1', T0)

    const outcome = await store.finishRunning('sub_row_1', T0 + 5)
    expect(outcome).toEqual({ requeue: true })
    const afterFirst = await store.bySubscriptionId('remote-sub-1')
    expect(afterFirst?.refreshState).toBe('queued')
    expect(afterFirst?.refreshPending).toBe(false)

    // Running the consumer again and finishing without a new pending flag goes idle.
    await store.markRunning('sub_row_1', T0 + 6)
    const outcome2 = await store.finishRunning('sub_row_1', T0 + 7)
    expect(outcome2).toEqual({ requeue: false })
    expect((await store.bySubscriptionId('remote-sub-1'))?.refreshState).toBe('idle')
  })

  it('finishRunning goes straight to idle when nothing arrived during the run', async () => {
    const { store } = harness()
    await store.insert(row({ refreshState: 'running' }), T0)
    expect(await store.finishRunning('sub_row_1', T0 + 5)).toEqual({ requeue: false })
    expect((await store.bySubscriptionId('remote-sub-1'))?.refreshState).toBe('idle')
  })

  it('stale recovery: a state stuck for >10 minutes is treated as idle for the next CAS', async () => {
    const { store } = harness()
    // "running" but its state_at is 11 minutes in the past: the consumer/queue
    // message that should have finished it is presumed lost.
    await store.insert(row({ refreshState: 'running', refreshStateAt: T0 }), T0)

    const now = T0 + 11 * 60
    expect(await store.markQueued('sub_row_1', now)).toBe(true)
    expect((await store.bySubscriptionId('remote-sub-1'))?.refreshState).toBe('queued')
  })

  it('a state stuck for <10 minutes is NOT treated as idle', async () => {
    const { store } = harness()
    await store.insert(row({ refreshState: 'running', refreshStateAt: T0 }), T0)
    const now = T0 + 9 * 60
    expect(await store.markQueued('sub_row_1', now)).toBe(false)
    expect((await store.bySubscriptionId('remote-sub-1'))?.refreshState).toBe('running')
  })
})
