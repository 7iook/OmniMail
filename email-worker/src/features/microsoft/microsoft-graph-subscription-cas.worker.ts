/// <reference types="node" />
import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'

/**
 * The other half of the real-thread CAS race in
 * `microsoft-graph-subscription-cas.test.ts`. Runs on its own OS thread
 * (`worker_threads`, loaded via `--experimental-strip-types` since the real
 * `MicrosoftGraphSubscriptionStore` uses a TS parameter property that
 * strip-only mode cannot load) against the SAME on-disk SQLite file the main
 * thread's `MicrosoftGraphSubscriptionStore` instance is using, so the two
 * attempts genuinely overlap in wall-clock time rather than one completing
 * before the other starts.
 *
 * The `UPDATE` below is deliberately the exact same predicate as
 * `MicrosoftGraphSubscriptionStore.markQueued` — if that SQL ever changes,
 * this must change with it, or the test stops proving anything.
 */

interface WorkerInput {
  file: string
  id: string
  now: number
}

const { file, id, now } = workerData as WorkerInput
const db = new DatabaseSync(file)
// Wait for the main thread's writer rather than failing outright on contention —
// that is the whole point of the overlap (see the test file's docstring).
db.exec('PRAGMA busy_timeout = 5000')

const claimed = db.prepare(
  `UPDATE microsoft_graph_subscriptions
      SET refresh_state = 'queued', refresh_state_at = ?, updated_at = ?
    WHERE id = ? AND (refresh_state = 'idle' OR refresh_state_at < ?)`,
).run(now, now, id, now - 10 * 60).changes > 0

parentPort?.postMessage({ claimed })
