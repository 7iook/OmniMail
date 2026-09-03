import { configureMicrosoftGraphSubscriptionRuntime } from './microsoft-graph-notifications'
import { MicrosoftGraphSubscriptionStore } from './microsoft-graph-subscription-store'
import { MicrosoftGraphSubscriptionClient } from './microsoft-graph-subscriptions'

/**
 * Binds the real Graph subscription client and D1 repository into the
 * notification / reconciliation runtime.
 *
 * Imported for its side effect from the Worker entry point so that every
 * handler type (fetch, queue, scheduled) sees the same wiring. Tests replace
 * the runtime through `configureMicrosoftGraphSubscriptionRuntime` directly.
 */
configureMicrosoftGraphSubscriptionRuntime({
  repositoryFor: (env) => new MicrosoftGraphSubscriptionStore(env),
  // `requestBudget` (re-review 2 Important #2a) is only ever supplied by
  // cron reconciliation; forwarded straight through so the real client
  // charges it per actual HTTP attempt.
  clientFor: (accessToken, requestBudget) => (
    new MicrosoftGraphSubscriptionClient({ accessToken, budget: requestBudget })
  ),
})
