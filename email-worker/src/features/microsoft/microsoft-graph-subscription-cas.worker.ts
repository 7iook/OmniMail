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
 * The `UPDATE` below is deliberately the exact same predicate as
 * `MicrosoftGraphSubscriptionStore.markQueued` — if that SQL ever changes,
 * this must change with it, or the test stops proving anything.
 */

interface WorkerInput {
  file: string
  id: string
  now: number
  barrier: SharedArrayBuffer
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

const { file, id, now, barrier } = workerData as WorkerInput
const db = new DatabaseSync(file)
// Wait for the main thread's writer rather than failing outright on contention —
// that is the whole point of the overlap (see the test file's docstring).
db.exec('PRAGMA busy_timeout = 5000')

waitForRaceBarrier(new Int32Array(barrier))

const claimed = db.prepare(
  `UPDATE microsoft_graph_subscriptions
      SET refresh_state = 'queued', refresh_state_at = ?, updated_at = ?
    WHERE id = ? AND (refresh_state = 'idle' OR refresh_state_at < ?)`,
).run(now, now, id, now - 10 * 60).changes > 0

parentPort?.postMessage({ claimed })
