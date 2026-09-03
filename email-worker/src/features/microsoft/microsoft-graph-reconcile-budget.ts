/**
 * Outbound-call budget for `microsoft-graph-reconcile.ts` (review3 "Suspected/
 * operational risk", re-review Important #3). Split out of that file so the
 * budget mechanics (deadline + call cap + the exception that unwinds a
 * mid-account call sequence) have one place, and so the reconcile file's own
 * line budget has room for the C-2/C-5/fairness logic itself.
 *
 * `nowMs` is injectable so a test can simulate elapsed wall-clock time without
 * a real 20-second sleep.
 */

export const RECONCILE_DEADLINE_MS = 20_000
export const RECONCILE_MAX_OUTBOUND_CALLS = 60

export interface ReconcileBudget {
  /** True while another outbound call may still start. */
  hasCapacity(): boolean
  /** Call once per outbound HTTP call about to be made. */
  spend(): void
}

export function createReconcileBudget(
  nowMs: () => number,
  deadlineMs = RECONCILE_DEADLINE_MS,
  maxCalls = RECONCILE_MAX_OUTBOUND_CALLS,
): ReconcileBudget {
  const deadline = nowMs() + deadlineMs
  let remaining = maxCalls
  return {
    hasCapacity: () => remaining > 0 && nowMs() < deadline,
    spend: () => { remaining -= 1 },
  }
}

/**
 * Thrown by {@link chargedCall} instead of running the wrapped outbound call
 * once the budget is spent. Every catch block downstream of a charged call
 * MUST re-throw this (never treat it as a Graph API failure — it would
 * otherwise mark a healthy subscription `rejected`/backed-off for a reason
 * that has nothing to do with what Microsoft said) so it unwinds to the
 * per-account loop, which is the only place that turns it into "stop this
 * pass; the next cron tick resumes" rather than "this one row/account failed".
 */
export class ReconcileBudgetExhaustedError extends Error {
  constructor() {
    super('Microsoft Graph reconciliation outbound-call budget exhausted for this pass')
    this.name = 'ReconcileBudgetExhaustedError'
  }
}

/**
 * The single outbound-call wrapper (re-review Important #3): every token
 * acquisition, `list()`, `create()`, `renew()`, and `remove()) call is charged
 * exactly once here, rather than once per row/account as before — that older
 * shape could not bind `RECONCILE_MAX_OUTBOUND_CALLS` because one account can
 * cost anywhere from one call (token only, nothing to do) to four (token +
 * list + two creates).
 */
export async function chargedCall<T>(budget: ReconcileBudget, call: () => Promise<T>): Promise<T> {
  if (!budget.hasCapacity()) throw new ReconcileBudgetExhaustedError()
  budget.spend()
  return call()
}

/**
 * Duck-typed match for `MicrosoftGraphSubscriptionClient`'s own budget-
 * exhaustion signal (re-review 2 Important #2a) — checked by shape rather
 * than imported, so this generic call-budget module stays independent of the
 * Graph client's own error taxonomy (mirrors `microsoft-graph-reconcile.ts`'s
 * own duck-typed `isPermanentSubscriptionRejection`).
 */
function isGraphClientBudgetExhausted(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'graph_subscription_budget_exhausted'
}

/**
 * True for either budget-exhaustion signal reconciliation can now see: this
 * module's own {@link ReconcileBudgetExhaustedError} (thrown by
 * `chargedCall`, still used for token acquisition and every top-level
 * create/renew/remove/list call) or the Graph client's own per-attempt
 * budget check (re-review 2 Important #2a, thrown from inside a real
 * `list()`/`create()`/etc. call once the SAME shared budget is spent).
 * Reconciliation treats both identically: stop this pass, never mark a
 * subscription rejected/backed-off for a reason that has nothing to do with
 * what Microsoft said.
 */
export function isBudgetExhausted(error: unknown): boolean {
  return error instanceof ReconcileBudgetExhaustedError || isGraphClientBudgetExhausted(error)
}

/** Guard for every catch block that would otherwise swallow or reclassify this signal. */
export function rethrowIfBudgetExhausted(error: unknown): void {
  if (isBudgetExhausted(error)) throw error
}
