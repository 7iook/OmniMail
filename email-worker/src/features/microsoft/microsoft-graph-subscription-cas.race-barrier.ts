/**
 * A tiny two-party start barrier over a `SharedArrayBuffer`, shared by the
 * main thread and the worker in `microsoft-graph-subscription-cas.test.ts`
 * (re-review Minor #1). Each party calls this once it is ready to race (DB
 * connection open, about to issue its `UPDATE`); it blocks until BOTH parties
 * have arrived, so neither can finish its write before the other has even
 * started — the previous version had no such barrier, so worker thread
 * start-up latency could let the main thread's write complete first every
 * time, proving the CAS predicate again rather than a genuine overlap.
 *
 * `Atomics.wait` blocks the calling thread without a busy spin; it is used
 * here purely as an interruptible sleep (the loop re-checks the actual
 * counter rather than trusting a single wait to be woken at the right count),
 * so this works whether or not `Atomics.notify` from the other side is timed
 * exactly right.
 */
export function waitForRaceBarrier(counter: Int32Array, timeoutMs = 5_000): void {
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

/**
 * A synchronous, thread-blocking sleep (re-review 2 Minor #2: "observable
 * overlap" evidence): waits on a private, never-signalled `SharedArrayBuffer`
 * cell so the calling thread genuinely blocks for `ms` without yielding to
 * any pending microtask/timer. `DatabaseSync` calls are synchronous too, so
 * an `async`/`setTimeout` delay would not keep the surrounding `BEGIN
 * IMMEDIATE ... COMMIT` transaction open for a deterministic window the way
 * this does — the whole point is to force the loser to observably wait on
 * `busy_timeout` while the winner still holds the write lock.
 */
export function blockingSleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
