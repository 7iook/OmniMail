import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import type { Env } from '../../app/types'
import { WRANGLER_MIGRATION_NAMES } from '../../platform/d1/schema-migrations'
import { MicrosoftGraphSubscriptionStore } from './microsoft-graph-subscription-store'
import { waitForRaceBarrier } from './microsoft-graph-subscription-cas.race-barrier'

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

function applyDiskMigrationsToFile(file: string): DatabaseSync {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = OFF')
  for (const name of WRANGLER_MIGRATION_NAMES) {
    const sql = readFileSync(`migrations/${name}`, 'utf8')
    db.exec(sql)
  }
  db.exec('PRAGMA foreign_keys = ON')
  return db
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

  describe('a genuine two-thread race (Minor #1: the above is sequential, this is not)', () => {
    let dir: string | null = null

    afterEach(async () => {
      // Windows keeps the file handle briefly after a `DatabaseSync`/worker
      // close; retry the cleanup rather than flake the suite on `EBUSY`.
      for (let attempt = 0; dir && attempt < 5; attempt += 1) {
        try {
          rmSync(dir, { recursive: true, force: true })
          dir = null
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
    })

    /**
     * Two *different OS threads* (`worker_threads`, not two logical calls on
     * one connection) hold their own `DatabaseSync` connection to the SAME
     * on-disk file and both attempt `markQueued` for the same row.
     *
     * Minor #1 (re-review): starting the worker first and immediately racing
     * ahead on the main thread does NOT guarantee overlap — worker thread
     * start-up (module load, `DatabaseSync` open) has its own latency, so the
     * main thread's write could complete before the worker even connects,
     * which would just prove the CAS predicate sequentially again. Both sides
     * now block on a shared `SharedArrayBuffer` barrier
     * (`waitForRaceBarrier`) right after opening their DB connection, so
     * neither issues its `UPDATE` until BOTH are ready — the two file-level
     * writes then genuinely overlap and SQLite's own locking (not thread
     * start timing) decides who goes first. Exactly one of them must observe
     * `refresh_state = 'idle'` and win.
     */
    it('of two racing OS threads on the same on-disk file, exactly one wins the CAS', async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'omnimail-graph-cas-'))
      const file = path.join(dir, 'race.sqlite')
      const seedDb = applyDiskMigrationsToFile(file)
      const id = seed(seedDb)
      seedDb.close()

      const barrier = new SharedArrayBuffer(4)
      const workerUrl = new URL('./microsoft-graph-subscription-cas.worker.ts', import.meta.url)
      const worker = new Worker(fileURLToPath(workerUrl), {
        workerData: { file, id, now: NOW, barrier },
        execArgv: [...process.execArgv, '--experimental-strip-types'],
      })
      const workerClaimed = new Promise<boolean>((resolve, reject) => {
        worker.once('message', (message: { claimed: boolean }) => resolve(message.claimed))
        worker.once('error', reject)
      })

      const mainDb = new DatabaseSync(file)
      mainDb.exec('PRAGMA busy_timeout = 5000')
      const mainStore = new MicrosoftGraphSubscriptionStore(realEnv(mainDb))
      // Block here until the worker has ALSO connected and reached its own
      // barrier call — only then does either side issue its `UPDATE`.
      waitForRaceBarrier(new Int32Array(barrier))
      const mainClaimed = await mainStore.markQueued(id, NOW)
      const workerResult = await workerClaimed
      const row = await mainStore.bySubscriptionId('graph-sub-1')
      mainDb.close()
      await worker.terminate()

      expect([mainClaimed, workerResult].filter(Boolean)).toHaveLength(1)
      expect(row?.refreshState).toBe('queued')
    })
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

    const mustResend = await store.releaseQueued(id, NOW + 1)

    expect(mustResend).toBe(false)
    const row = await store.bySubscriptionId('graph-sub-1')
    expect(row?.refreshState).toBe('idle')
    // Idle again: a fresh notification can win the CAS once more.
    expect(await store.markQueued(id, NOW + 2)).toBe(true)
  })

  it('a send failure racing a concurrent notification preserves the pending wakeup (fix #8)', async () => {
    const db = applyDiskMigrations()
    const id = seed(db)
    const store = new MicrosoftGraphSubscriptionStore(realEnv(db))
    await store.markQueued(id, NOW)
    // A second notification arrives while the first caller's send is still
    // in flight and failing: it observes `queued` and only sets pending.
    await store.markPending(id, NOW + 1)

    const mustResend = await store.releaseQueued(id, NOW + 2)

    expect(mustResend).toBe(true)
    const row = await store.bySubscriptionId('graph-sub-1')
    expect(row).toMatchObject({ refreshState: 'queued', refreshPending: false })
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
