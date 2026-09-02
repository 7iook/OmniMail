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
  clientFor: (accessToken) => new MicrosoftGraphSubscriptionClient({ accessToken }),
})
