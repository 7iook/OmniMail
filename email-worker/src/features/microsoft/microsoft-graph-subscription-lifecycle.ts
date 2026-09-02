/**
 * Graph subscription lifecycle hooks for account import / credential replace /
 * delete (decision card §12, P2-W2). Kept out of `microsoft-account-api.ts`
 * itself so that file's line budget stays untouched beyond the three call
 * sites that invoke these functions.
 *
 * Every exported function here is best-effort: it never throws, matching the
 * existing `try { await enqueueSync(...) } catch { /* cron will retry *\/ }`
 * idiom in `microsoft-account-api.ts`. A subscription that fails to create or
 * delete here is not a reason to fail an import, a credential replace or an
 * account deletion (C-2) — the cron reconciliation pass (P2-W3) is the
 * long-term source of truth for catching up.
 */

import type { Env } from '../../app/types'
import {
  generateMicrosoftGraphClientState,
  microsoftGraphClientStateDigest,
  MicrosoftGraphSubscriptionClient,
  MicrosoftGraphSubscriptionError,
} from './microsoft-graph-subscriptions'
import { MicrosoftGraphSubscriptionStore } from './microsoft-graph-subscription-store'
import { microsoftAccessToken } from './microsoft-token-manager'
import {
  MICROSOFT_GRAPH_SUBSCRIBED_FOLDERS,
  type MicrosoftAccount,
  type MicrosoftGraphSubscription,
} from './microsoft-types'

/** Outlook message subscriptions cap out at 10,080 minutes (7 days). */
const SUBSCRIPTION_LIFETIME_SECONDS = 10_080 * 60
/** Create/renew ask for slightly less than the maximum, so clock skew never gets us rejected. */
const SUBSCRIPTION_SAFETY_MARGIN_SECONDS = 5 * 60
/** Mirrors the store's own renewal lead: due 24h before expiry, so the due-scan needs no second shape. */
const RENEWAL_LEAD_SECONDS = 24 * 60 * 60

function notificationUrl(baseUrl: string): string {
  return `${baseUrl}/api/microsoft/graph/notifications`
}

function lifecycleNotificationUrl(baseUrl: string): string {
  return `${baseUrl}/api/microsoft/graph/lifecycle`
}

/**
 * After a successful import or credential replace whose winning transport is
 * `graph`: create one subscription per {@link MICROSOFT_GRAPH_SUBSCRIBED_FOLDERS}
 * entry (today: inbox, junkemail). Each folder is independent — one failing
 * does not block the other — and the whole function is a no-op, logged once,
 * when the webhook base URL is not configured (S-6: Graph push is an optional
 * capability, not a requirement for the mailbox to work at all).
 */
export async function createMicrosoftGraphSubscriptionsForAccount(
  env: Env,
  account: MicrosoftAccount,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  const baseUrl = env.MICROSOFT_GRAPH_WEBHOOK_BASE_URL?.trim()
  if (!baseUrl) {
    console.log('Microsoft Graph push skipped: MICROSOFT_GRAPH_WEBHOOK_BASE_URL is unset', {
      accountId: account.id,
    })
    return
  }
  let accessToken: string
  try {
    accessToken = await microsoftAccessToken(env, account, { transport: 'graph' })
  } catch (error) {
    console.error('Unable to obtain a Graph token for subscription creation', {
      accountId: account.id,
      type: error instanceof Error ? error.name : typeof error,
    })
    return
  }
  const client = new MicrosoftGraphSubscriptionClient({ accessToken })
  const repository = new MicrosoftGraphSubscriptionStore(env)
  for (const folder of MICROSOFT_GRAPH_SUBSCRIBED_FOLDERS) {
    try {
      const clientState = generateMicrosoftGraphClientState()
      const remote = await client.create({
        wellKnownFolder: folder.wellKnownName,
        notificationUrl: notificationUrl(baseUrl),
        lifecycleNotificationUrl: lifecycleNotificationUrl(baseUrl),
        clientState,
        expiresAt: now + SUBSCRIPTION_LIFETIME_SECONDS - SUBSCRIPTION_SAFETY_MARGIN_SECONDS,
      })
      await repository.insert({
        id: `msgraphsub_${crypto.randomUUID().replaceAll('-', '')}`,
        accountId: account.id,
        folderPath: folder.folderPath,
        subscriptionId: remote.subscriptionId,
        clientStateHash: await microsoftGraphClientStateDigest(clientState),
        expiresAt: remote.expiresAt,
        status: 'active',
        failureCount: 0,
        // Due 24h before expiry: the due-scan cron (`due()`) is then the only
        // query shape P2-W3 needs for renewal, with no separate "expiring" pass.
        nextAttemptAt: Math.max(now, remote.expiresAt - RENEWAL_LEAD_SECONDS),
        refreshState: 'idle',
        refreshPending: false,
        refreshStateAt: now,
        lastNotifiedAt: null,
        lastErrorCode: '',
      }, now)
    } catch (error) {
      console.error('Unable to create a Microsoft Graph subscription', {
        accountId: account.id,
        folderPath: folder.folderPath,
        code: error instanceof MicrosoftGraphSubscriptionError ? error.code : 'unknown',
      })
    }
  }
}

/**
 * Best-effort remote teardown of every subscription row for one account,
 * using credentials that are still valid at call time. Must run BEFORE the
 * caller changes or removes the account's credentials/row (C-2): afterwards
 * there would be no way to mint a Graph token to authenticate the DELETE.
 *
 * `dropLocalRows` controls whether the D1 rows are also removed here:
 *  - credential replace: `true` — the account row survives, so nothing else
 *    will clear these rows; the caller may recreate fresh ones afterwards.
 *  - account delete: `false` — `ON DELETE CASCADE` removes them the moment
 *    the account row itself is deleted, so removing them here would just be
 *    redundant work on a row about to disappear anyway.
 *
 * Never throws: any failure (listing rows, minting a token, the remote DELETE
 * itself) is logged and swallowed, so this never blocks the operation it
 * precedes.
 */
export async function teardownMicrosoftGraphSubscriptions(
  env: Env,
  account: MicrosoftAccount,
  options: { dropLocalRows: boolean },
): Promise<void> {
  const repository = new MicrosoftGraphSubscriptionStore(env)
  let rows: MicrosoftGraphSubscription[]
  try {
    rows = await repository.forAccount(account.id)
  } catch (error) {
    console.error('Unable to list Microsoft Graph subscriptions for teardown', {
      accountId: account.id,
      type: error instanceof Error ? error.name : typeof error,
    })
    return
  }
  if (!rows.length) return

  if (account.authMode === 'oauth2') {
    try {
      const accessToken = await microsoftAccessToken(env, account, { transport: 'graph' })
      const client = new MicrosoftGraphSubscriptionClient({ accessToken })
      for (const row of rows) {
        try {
          await client.remove(row.subscriptionId)
        } catch (error) {
          console.error('Unable to delete a Microsoft Graph subscription remotely', {
            accountId: account.id,
            subscriptionId: row.subscriptionId,
            code: error instanceof MicrosoftGraphSubscriptionError ? error.code : 'unknown',
          })
        }
      }
    } catch (error) {
      console.error('Unable to obtain a Graph token for subscription teardown', {
        accountId: account.id,
        type: error instanceof Error ? error.name : typeof error,
      })
    }
  }

  if (options.dropLocalRows) {
    for (const row of rows) {
      try {
        await repository.remove(row.id)
      } catch { /* best effort */ }
    }
  }
}
