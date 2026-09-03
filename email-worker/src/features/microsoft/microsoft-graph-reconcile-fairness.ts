/**
 * Fairness helpers for `microsoft-graph-reconcile.ts`'s account-selection
 * rotation (re-review Important #3 / re-review 2 Important #2b). Split out
 * of that file for the same reason `microsoft-graph-reconcile-budget.ts`
 * was: keep the main file's own C-2/C-5 orchestration logic under its
 * 600-line ceiling.
 */

import type { Env } from '../../app/types'
import type { MicrosoftGraphSubscriptionRepository } from './microsoft-types'

/**
 * Bumps every one of this account's subscription rows' `updated_at` so the
 * fairness ordering (`MIN(s.updated_at)`) rotates this account to the back
 * of the queue once it has actually been looked at this tick (re-review
 * Important #3). A no-op for an account with zero rows — see {@link
 * markFolderStaleAfterAmbiguousCreate} for how re-review 2 Important #2b
 * closes that gap so a persistently zero-row account cannot stay at the
 * front forever.
 */
export async function touchAccountReconciled(env: Env, accountId: string, now: number): Promise<void> {
  await env.DB.prepare(
    'UPDATE microsoft_graph_subscriptions SET updated_at = ? WHERE account_id = ?',
  ).bind(now, accountId).run()
}

/**
 * Leaves a `stale`, null-id marker row (re-review 2 Important #2b) so an
 * account is never left with zero rows — which the fairness ordering above
 * always sorts first (SQLite sorts `NULL` first), forever. Used both when a
 * `createOne` call fails ambiguously (network blip / 5xx / timeout — result
 * genuinely unknown) and when the reconciliation budget runs out before an
 * account with no existing rows gets as far as a single create attempt.
 *
 * A null id is excluded from every remote-orphan/remove check (0038), so
 * this never risks an invalid DELETE for an id that was never real, and the
 * next `due()` scan's `renewOrRebuildDue` retries it on a real schedule
 * (`nextAttemptAt`, the caller's own C-5 backoff) rather than this same
 * create being re-attempted on every single tick.
 */
export async function markFolderStaleAfterAmbiguousCreate(
  repository: MicrosoftGraphSubscriptionRepository,
  accountId: string,
  folderPath: string,
  clientStateHash: string,
  errorCode: string,
  nextAttemptAt: number,
  now: number,
): Promise<void> {
  await repository.insert({
    id: `microsoft_graph_sub_${crypto.randomUUID().replaceAll('-', '')}`,
    accountId,
    folderPath,
    subscriptionId: null,
    clientStateHash,
    expiresAt: now,
    status: 'stale',
    failureCount: 1,
    nextAttemptAt,
    refreshState: 'idle',
    refreshPending: false,
    refreshStateAt: now,
    lastNotifiedAt: null,
    lastErrorCode: errorCode,
  }, now)
}
