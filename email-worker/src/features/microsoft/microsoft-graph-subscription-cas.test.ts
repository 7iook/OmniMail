import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { Env } from '../../app/types'
import { WRANGLER_MIGRATION_NAMES } from '../../platform/d1/schema-migrations'
import { MicrosoftGraphSubscriptionStore } from './microsoft-graph-subscription-store'

/**
 * Real-SQLite acceptance test for the C-3 coalescing state machine, against
 * the real `0037_microsoft_graph_subscriptions.sql` DDL and P2-W2's real
 * `MicrosoftGraphSubscriptionStore` (present in this worktree at the time this
 * package was written — the brief only asks for a fake repository "if the real
 * one is absent"). Every other test in this package drives a fake repository
 * against the frozen interface; this one exists specifically to prove the CAS
 * `UPDATE ... WHERE refresh_state = 'idle'` shape actually behaves as C-3
 * describes against the real column definitions (`CHECK` constraints included),
 * following the `microsoft-sync-folder.upsert.test.ts` real-D1-shim pattern.
 */

const ACCOUNT = 'acct_cas'
const NOW = 1_700_000_000

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

function seed(db: DatabaseSync): string {
  db.prepare(
    `INSERT INTO users (id, email, display_name, password_hash)
     VALUES ('user_cas', 'owner@example.com', 'Owner', 'hash')`,
  ).run()
  db.prepare(
    `INSERT INTO microsoft_imap_accounts (
       id, user_id, name, provided_email, normalized_email, auth_mode,
       client_id, refresh_token_cipher, created_at, updated_at
     ) VALUES (?, 'user_cas', 'Outlook', 'user@outlook.com', 'user@outlook.com',
       'oauth2', 'client', 'cipher', ?, ?)`,
  ).run(ACCOUNT, NOW, NOW)
  const id = 'sub_row_1'
  db.prepare(
    `INSERT INTO microsoft_graph_subscriptions (
       id, account_id, folder_path, subscription_id, client_state_hash, expires_at,
       status, failure_count, next_attempt_at, refresh_state, refresh_pending,
       refresh_state_at, last_notified_at, last_error_code, created_at, updated_at
     ) VALUES (?, ?, 'INBOX', 'graph-sub-1', 'hash', ?, 'active', 0, 0, 'idle', 0, 0,
       NULL, '', ?, ?)`,
  ).run(id, ACCOUNT, NOW + 1_000, NOW, NOW)
  return id
}

/** The slice of `D1Database` the store touches, executed for real (mirrors `microsoft-sync-folder.upsert.test.ts`). */
function realEnv(db: DatabaseSync): Env {
  const statement = (sql: string, values: SQLInputValue[]) => ({
    first: async <T>() => (db.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({ results: db.prepare(sql).all(...values) as T[] }),
    run: async () => {
      const { changes } = db.prepare(sql).run(...values)
      return { meta: { changes } }
    },
  })
  return {
    DB: {
      prepare: (sql: string) => ({
        ...statement(sql, []),
        bind: (...values: unknown[]) => statement(sql, values as SQLInputValue[]),
      }),
    },
  } as unknown as Env
}

describe('Microsoft Graph subscription C-3 CAS race (real SQLite, real 0037 DDL, real repository)', () => {
  it('runs the 0037 DDL with foreign keys enforced', () => {
    const db = applyDiskMigrations()
    const pragma = db.prepare('PRAGMA foreign_keys').get() as Record<string, number>
    expect(Object.values(pragma)).toEqual([1])
  })

  it('of two idle->queued attempts on the same row, only the first wins the CAS', async () => {
    const db = applyDiskMigrations()
    const id = seed(db)
    const store = new MicrosoftGraphSubscriptionStore(realEnv(db))

    // `DatabaseSync` executes synchronously under the hood (no real parallel
    // writer), so this is deterministic rather than a true race — but it still
    // proves the `WHERE refresh_state = 'idle'` guard actually rejects a second
    // caller once the first has already flipped the row to `queued`, which is
    // exactly what protects two concurrent Workers from both winning (C-3).
    const first = await store.markQueued(id, NOW)
    const second = await store.markQueued(id, NOW)

    expect(first).toBe(true)
    expect(second).toBe(false)
    const row = await store.bySubscriptionId('graph-sub-1')
    expect(row?.refreshState).toBe('queued')
  })

  it('a notification arriving while running is recorded as pending, then requeues on finish', async () => {
    const db = applyDiskMigrations()
    const id = seed(db)
    const store = new MicrosoftGraphSubscriptionStore(realEnv(db))
    await store.markQueued(id, NOW)
    await store.markRunning(id, NOW + 1)

    await store.markPending(id, NOW + 2)
    const { requeue } = await store.finishRunning(id, NOW + 3)

    expect(requeue).toBe(true)
    const row = await store.bySubscriptionId('graph-sub-1')
    expect(row).toMatchObject({ refreshState: 'queued', refreshPending: false })
  })

  it('finishRunning goes to idle when nothing arrived while running', async () => {
    const db = applyDiskMigrations()
    const id = seed(db)
    const store = new MicrosoftGraphSubscriptionStore(realEnv(db))
    await store.markQueued(id, NOW)
    await store.markRunning(id, NOW + 1)

    const { requeue } = await store.finishRunning(id, NOW + 2)

    expect(requeue).toBe(false)
    const row = await store.bySubscriptionId('graph-sub-1')
    expect(row?.refreshState).toBe('idle')
  })

  it('a send failure releases queued back to idle (releaseQueued), letting the next notification re-enqueue', async () => {
    const db = applyDiskMigrations()
    const id = seed(db)
    const store = new MicrosoftGraphSubscriptionStore(realEnv(db))
    await store.markQueued(id, NOW)

    const released = await store.releaseQueued(id, NOW + 1)

    expect(released).toBe(true)
    const row = await store.bySubscriptionId('graph-sub-1')
    expect(row?.refreshState).toBe('idle')
    // Idle again: a fresh notification can win the CAS once more.
    expect(await store.markQueued(id, NOW + 2)).toBe(true)
  })

  it('a >10-minute-old running row is treated as abandoned and can be re-claimed (crash recovery)', async () => {
    const db = applyDiskMigrations()
    const id = seed(db)
    const store = new MicrosoftGraphSubscriptionStore(realEnv(db))
    await store.markQueued(id, NOW)
    await store.markRunning(id, NOW)

    // 11 minutes later: the consumer that claimed `running` is presumed dead
    // (crashed / its queue message was lost), so a fresh claim must succeed.
    const reclaimed = await store.markRunning(id, NOW + 11 * 60)

    expect(reclaimed).toBe(true)
  })
})
