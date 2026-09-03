/// <reference types="node" />
import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'

/**
 * The other half of the real-thread CAS race in
 * `microsoft-graph-subscription-cas.test.ts`. Runs on its own OS thread
 * (`worker_threads`, loaded via `--experimental-strip-types` since the real
 * `MicrosoftGraphSubscriptionStore` uses a TS parameter property that
 * strip-only mode cannot load) against the SAME on-disk SQLite file the main
 * thread's `MicrosoftGraphSubscriptionStore` instance is using.
 *
 * Minor #1 (re-review): opening the DB connection is itself synchronous but
 * not instant, so without a barrier the main thread's `UPDATE` could finish
 * before this thread even connects — proving the predicate again, not that
 * the two writes overlapped. Both sides now signal "connected, about to
 * write" on a shared `SharedArrayBuffer` and only issue their `UPDATE` once
 * both have signalled, so the two file-level writes genuinely race and
 * SQLite's own locking (not thread-start timing) decides the winner.
 *
 * Minor #2 (re-review 2): the barrier alone still let one post-barrier
 * `UPDATE` finish before the other thread even reached its own — one
 * winner, no proof they overlapped. Both sides now wrap their `UPDATE` in
 * an explicit `BEGIN IMMEDIATE ... COMMIT` and hold it open for `holdMs`
 * after writing, forcing whichever contender loses the write lock to
 * genuinely block on `busy_timeout` while the winner still holds it; both
 * report their own attempt window so the test can assert the windows
 * intersected, not merely that one side won.
 *
 * The `UPDATE` below is deliberately the exact same predicate as
 * `MicrosoftGraphSubscriptionStore.markQueued` — if that SQL ever changes,
 * this must change with it, or the test stops proving anything.
 */

interface WorkerInput {
  file: string
  id: string
  now: number
  barrier: SharedArrayBuffer
  /** Re-review 2 Minor #2: how long the winner holds its transaction open. */
  holdMs: number
}

/**
 * Deliberately duplicated from `microsoft-graph-subscription-cas.race-
 * barrier.ts` (used by the test file's main-thread side) rather than
 * imported: this file runs under `node --experimental-strip-types`, which
 * requires a relative import specifier's exact extension, but this project's
 * `tsconfig.json` (shared, not scoped to this one test helper) rejects a
 * `.ts`-suffixed import unless `allowImportingTsExtensions` is enabled. Both
 * copies must stay identical, or the barrier stops proving overlap.
 */
function waitForRaceBarrier(counter: Int32Array, timeoutMs = 5_000): void {
  const arrived = Atomics.add(counter, 0, 1) + 1
  Atomics.notify(counter, 0)
  if (arrived >= 2) return
  const deadline = Date.now() + timeoutMs
  while (Atomics.load(counter, 0) < 2) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('race barrier timed out waiting for the other party')
    Atomics.wait(counter, 0, Atomics.load(counter, 0), Math.min(remaining, 25))
  }
}

/** Duplicated alongside `waitForRaceBarrier` above — see that function's comment. */
function blockingSleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Re-review 2 Minor #2: attempts the exact same CAS predicate as the main
 * thread's helper in the test file, but holds an explicit transaction open
 * for `holdMs` after a winning `UPDATE` so the other contender is forced to
 * observably block on `busy_timeout` behind it — proving genuine overlap,
 * not just "one winner". Returns wall-clock timestamps around the whole
 * attempt so the test can assert the two attempt windows intersected.
 */
function attemptClaimWithHold(
  database: DatabaseSync,
  rowId: string,
  now: number,
  holdMs: number,
): { claimed: boolean; startedAt: number; endedAt: number } {
  const startedAt = Date.now()
  database.exec('BEGIN IMMEDIATE')
  const claimed = database.prepare(
    `UPDATE microsoft_graph_subscriptions
        SET refresh_state = 'queued', refresh_state_at = ?, updated_at = ?
      WHERE id = ? AND (refresh_state = 'idle' OR refresh_state_at < ?)`,
  ).run(now, now, rowId, now - 10 * 60).changes > 0
  blockingSleepMs(holdMs)
  database.exec('COMMIT')
  return { claimed, startedAt, endedAt: Date.now() }
}

const { file, id, now, barrier, holdMs } = workerData as WorkerInput
const db = new DatabaseSync(file)
// Wait for the main thread's writer rather than failing outright on contention —
// that is the whole point of the overlap (see the test file's docstring).
db.exec('PRAGMA busy_timeout = 5000')

waitForRaceBarrier(new Int32Array(barrier))

const result = attemptClaimWithHold(db, id, now, holdMs)

parentPort?.postMessage(result)
