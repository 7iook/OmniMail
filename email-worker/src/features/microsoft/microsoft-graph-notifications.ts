import type { Env } from '../../app/types'
import { sha256 } from '../auth/session/auth'
import type { MicrosoftGraphSubscriptionRequestBudget } from './microsoft-graph-subscriptions'
import type {
  MicrosoftGraphSubscription,
  MicrosoftGraphSubscriptionClient,
  MicrosoftGraphSubscriptionRepository,
} from './microsoft-types'

/**
 * Public endpoints Microsoft Graph calls for change notifications.
 *
 * Two request shapes arrive on the same URL (decision card §12 C-6):
 *   1. Validation handshake — `POST ?validationToken=...` at subscription
 *      creation/renewal. Must echo the token as text/plain within 10 s. No body
 *      is read and no D1 is touched, so this path cannot be used to load the DB.
 *   2. Notifications — JSON `{ value: [...] }`. Must be acknowledged with a 2xx
 *      within 3 s; the work happens via the queue, never inline.
 *
 * Invariant I-8: nothing in a notification body is trusted beyond the ids used
 * to look up our own subscription rows, and every outcome (match, mismatch,
 * unknown id, malformed) answers 202 so a probe learns nothing.
 *
 * P2-W1 ships the handshake and the response contract; P2-W3 fills in the
 * notification/lifecycle processing behind `processNotifications`.
 */

export const MICROSOFT_GRAPH_NOTIFICATION_PATH = '/api/microsoft/graph/notifications'
export const MICROSOFT_GRAPH_LIFECYCLE_PATH = '/api/microsoft/graph/lifecycle'

/** Graph batches notifications; 100 is comfortably above what it sends per POST. */
export const MAX_NOTIFICATION_ITEMS = 100
/** Notification payloads are a few hundred bytes each; anything near this is not Graph. */
export const MAX_NOTIFICATION_BODY_BYTES = 64 * 1024

export interface MicrosoftGraphNotificationItem {
  subscriptionId: string
  clientState: string
  changeType: string
  resource: string
}

export interface MicrosoftGraphLifecycleItem {
  subscriptionId: string
  clientState: string
  lifecycleEvent: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function accepted(): Response {
  return new Response(null, { status: 202 })
}

const NOTIFICATION_IP_WINDOW_SECONDS = 10 * 60
const NOTIFICATION_IP_MAX_ATTEMPTS = 600

/**
 * Rate-limit identity for these two webhook routes only: `CF-Connecting-IP`
 * (set by Cloudflare on every request that reaches a Worker, not forgeable
 * off that ingress) and nothing else. The shared `clientIp()` helper falls
 * back to the client-controlled `x-forwarded-for` header, which would let an
 * attacker pick their own rate-limit bucket (review3 #10) — that fallback is
 * fine for routes reached through the app's own reverse-proxy assumptions,
 * but wrong for a public endpoint Microsoft calls directly. A request
 * genuinely missing the header (should not happen on a deployed Worker) maps
 * to one fixed sentinel bucket instead of bypassing the counter.
 */
export function microsoftGraphWebhookClientIp(headers: Headers): string {
  return headers.get('CF-Connecting-IP') || 'unknown'
}

/**
 * D1 CAS counter, 600 requests / 10 minutes per IP (card C-6 abuse guard).
 *
 * Reuses the `microsoft_imap_validation_limits` idiom
 * (`microsoft-account-api.ts`'s `claimMicrosoftValidationAttempt`) rather than a
 * new table, with a `graph-notify:`-prefixed identity so this counter can never
 * collide with the unrelated per-user/IP validation counter that shares the
 * table. Runs for every non-handshake POST — including malformed or oversized
 * ones — before the body is even parsed, so a flood of garbage still costs the
 * attacker nothing more than this one indexed write per request.
 */
async function claimGraphNotificationAttempt(
  env: Env,
  ip: string,
  now = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const identity = await sha256(`graph-notify:${ip}`)
  const windowStartedAt = Math.floor(now / NOTIFICATION_IP_WINDOW_SECONDS) * NOTIFICATION_IP_WINDOW_SECONDS
  const result = await env.DB.prepare(
    `INSERT INTO microsoft_imap_validation_limits (
       identity_hash, window_started_at, attempt_count, updated_at
     ) VALUES (?, ?, 1, ?)
     ON CONFLICT(identity_hash) DO UPDATE SET
       window_started_at = excluded.window_started_at,
       attempt_count = CASE
         WHEN microsoft_imap_validation_limits.window_started_at = excluded.window_started_at
           THEN microsoft_imap_validation_limits.attempt_count + 1
         ELSE 1
       END,
       updated_at = excluded.updated_at
     WHERE microsoft_imap_validation_limits.window_started_at != excluded.window_started_at
        OR microsoft_imap_validation_limits.attempt_count < ?`,
  ).bind(identity, windowStartedAt, now, NOTIFICATION_IP_MAX_ATTEMPTS).run()
  return Boolean(result.meta.changes)
}

/**
 * Timing-safe compare for two equal-length hex digests.
 *
 * Small and local per P2-W3's brief rather than reaching for a shared helper:
 * the two existing equivalents (`resend-webhook.ts`'s private `timingSafeEqual`,
 * `auth.ts`'s unexported `safeEqual`) are both private to their own modules, and
 * P2-W2 may independently need the same handful of lines for its own repository
 * work — coordinating on a shared export was not worth a cross-package-boundary
 * dependency for four lines of code.
 */
function timingSafeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

/** `sha256(clientState)` compared against the stored digest (C-1), never the plaintext. */
async function matchesClientState(clientState: string, storedHash: string): Promise<boolean> {
  return timingSafeEqualHex(await sha256(clientState), storedHash)
}

/** 32 random bytes, hex-encoded. Sent to Graph as-is; only the digest is ever stored (C-1). */
export function generateMicrosoftGraphClientState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** The one place `clientState` is hashed for storage, so create/renew and verification agree. */
export async function hashMicrosoftGraphClientState(clientState: string): Promise<string> {
  return sha256(clientState)
}

/** Branch 1: the handshake. Echo exactly what was sent, as text, and nothing else. */
export function validationHandshake(request: Request): Response | null {
  const token = new URL(request.url).searchParams.get('validationToken')
  if (token === null) return null
  return new Response(token, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

/**
 * Parses a Graph notification body defensively: size-capped, item-capped, and
 * each item validated on its own so one malformed entry never drops the batch.
 */
export async function parseNotificationItems<T extends { subscriptionId: string; clientState: string }>(
  request: Request,
  pick: (raw: Record<string, unknown>) => T | null,
): Promise<T[]> {
  const length = Number(request.headers.get('content-length') ?? '0')
  if (length > MAX_NOTIFICATION_BODY_BYTES) return []
  let text: string
  try {
    text = await request.text()
  } catch {
    return []
  }
  // Byte length, not `.length` (UTF-16 code units): a chunked/missing-length
  // request with multibyte JSON can stay under 65,536 code units while
  // exceeding 64 KiB on the wire (review3 #9).
  if (new TextEncoder().encode(text).byteLength > MAX_NOTIFICATION_BODY_BYTES) return []
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return []
  }
  const value = (body as { value?: unknown })?.value
  if (!Array.isArray(value)) return []
  // Over the limit: drop the whole batch rather than silently trusting the
  // first 100 — Graph never sends more than this per POST, so anything larger
  // is not a partial-trust case worth acting on (review3 #2).
  if (value.length > MAX_NOTIFICATION_ITEMS) return []
  const items: T[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    if (typeof record.subscriptionId !== 'string' || !UUID.test(record.subscriptionId)) continue
    if (typeof record.clientState !== 'string' || !record.clientState) continue
    const item = pick(record)
    if (item) items.push(item)
  }
  return items
}

export function pickNotificationItem(raw: Record<string, unknown>): MicrosoftGraphNotificationItem | null {
  return {
    subscriptionId: raw.subscriptionId as string,
    clientState: raw.clientState as string,
    changeType: typeof raw.changeType === 'string' ? raw.changeType : '',
    resource: typeof raw.resource === 'string' ? raw.resource : '',
  }
}

export function pickLifecycleItem(raw: Record<string, unknown>): MicrosoftGraphLifecycleItem | null {
  if (typeof raw.lifecycleEvent !== 'string') return null
  return {
    subscriptionId: raw.subscriptionId as string,
    clientState: raw.clientState as string,
    lifecycleEvent: raw.lifecycleEvent,
  }
}

/**
 * Notification processing seam. P2-W1 leaves it a no-op so the deployed
 * handshake can be probed before the rest exists; P2-W3 replaces the body
 * (clientState digest check, C-3 enqueue transition, IP counter).
 */
export type NotificationProcessor = (
  env: Env,
  items: MicrosoftGraphNotificationItem[],
  clientIp: string,
) => Promise<void>

export type LifecycleProcessor = (
  env: Env,
  items: MicrosoftGraphLifecycleItem[],
  clientIp: string,
) => Promise<void>

export async function handleMicrosoftGraphNotification(
  env: Env,
  request: Request,
  clientIp: string,
  defer: (task: Promise<unknown>) => void,
  process: NotificationProcessor,
): Promise<Response> {
  const handshake = validationHandshake(request)
  if (handshake) return handshake
  // Over the limit: still 202 (I-8 never answers a probe differently), but no
  // D1 lookups beyond this counter itself — the batch is never even parsed.
  if (!await claimGraphNotificationAttempt(env, clientIp)) return accepted()
  const items = await parseNotificationItems(request, pickNotificationItem)
  if (items.length) {
    defer(process(env, items, clientIp).catch((error) => {
      console.error('Microsoft Graph notification processing failed', {
        type: error instanceof Error ? error.name : typeof error,
      })
    }))
  }
  return accepted()
}

export async function handleMicrosoftGraphLifecycle(
  env: Env,
  request: Request,
  clientIp: string,
  defer: (task: Promise<unknown>) => void,
  process: LifecycleProcessor,
): Promise<Response> {
  const handshake = validationHandshake(request)
  if (handshake) return handshake
  if (!await claimGraphNotificationAttempt(env, clientIp)) return accepted()
  const items = await parseNotificationItems(request, pickLifecycleItem)
  if (items.length) {
    defer(process(env, items, clientIp).catch((error) => {
      console.error('Microsoft Graph lifecycle processing failed', {
        type: error instanceof Error ? error.name : typeof error,
      })
    }))
  }
  return accepted()
}

/** P2-W1 placeholder processors: accept and drop. Kept for tests and as the
 * pre-configuration fallback shape; production wiring uses the real
 * processors below once a runtime is configured. */
export const dropNotifications: NotificationProcessor = async () => undefined
export const dropLifecycle: LifecycleProcessor = async () => undefined

// ---------------------------------------------------------------------------
// P2-W3: real notification/lifecycle processing (C-1, C-3, C-6, I-8)
// ---------------------------------------------------------------------------

/**
 * What the coordinator supplies once P2-W2's client and repository exist
 * (card C-7, P2-W2's owned files `microsoft-graph-subscriptions.ts` and
 * `microsoft-graph-subscription-store.ts`).
 *
 * `repositoryFor` is per-request, matching every other Microsoft store's shape
 * (it wraps one D1 binding, like `MicrosoftAccountStore`); `clientFor` mints one
 * subscription client per Graph access token, since `MicrosoftGraphSubscriptionClient`
 * is documented as talking "for one account's access token" — there is no single
 * global client to hand over.
 *
 * `clientFor`'s second parameter (re-review 2 Important #2a) is optional and
 * only ever supplied by cron reconciliation (`microsoft-graph-reconcile.ts`
 * is the sole caller with an outbound-call budget to enforce); it lets the
 * real client charge that budget once per actual HTTP attempt (each retry,
 * each `list()` page) rather than once per top-level create/renew/remove/
 * list call.
 */
export interface MicrosoftGraphSubscriptionRuntime {
  repositoryFor: (env: Env) => MicrosoftGraphSubscriptionRepository
  clientFor: (
    accessToken: string,
    requestBudget?: MicrosoftGraphSubscriptionRequestBudget,
  ) => MicrosoftGraphSubscriptionClient
}

let runtime: MicrosoftGraphSubscriptionRuntime | null = null

/**
 * The single injection point. The coordinator calls this once, after P2-W2
 * lands, with something like:
 *
 *   configureMicrosoftGraphSubscriptionRuntime({
 *     repositoryFor: (env) => new MicrosoftGraphSubscriptionStore(env),
 *     clientFor: (accessToken) => new MicrosoftGraphSubscriptionsClient({ accessToken }),
 *   })
 *
 * Until called, `microsoftGraphNotificationProcessor` / `...LifecycleProcessor`
 * log and drop (the deferred task rejects, which the handlers above already
 * catch — the public 202 is unaffected either way), and
 * `reconcileDueMicrosoftGraphSubscriptions` (in `microsoft-graph-reconcile.ts`)
 * no-ops with a log line instead of throwing.
 */
export function configureMicrosoftGraphSubscriptionRuntime(
  value: MicrosoftGraphSubscriptionRuntime | null,
): void {
  runtime = value
}

/** Read access for sibling modules: the queue consumer and cron reconciliation. */
export function microsoftGraphSubscriptionRuntime(): MicrosoftGraphSubscriptionRuntime | null {
  return runtime
}

/**
 * Small cap on the send/`releaseQueued` recovery loop below (re-review
 * Important #2): a pathological repository that always reports "must resend"
 * must not spin forever inside one deferred task.
 */
const ENQUEUE_RECOVERY_MAX_ATTEMPTS = 3

/**
 * Additive repository surface `sendMicrosoftFolderRefreshJob` needs beyond
 * the frozen `MicrosoftGraphSubscriptionRepository` port (re-review 2
 * Important #1): a terminal queued->idle transition for when the recovery
 * loop below gives up its attempt cap with a wakeup still outstanding.
 * Optional so every caller holding a plain `MicrosoftGraphSubscriptionRepository`
 * — including fakes built directly against the frozen interface — still
 * type-checks without it; the concrete `MicrosoftGraphSubscriptionStore`
 * implements it (see that file, and this package's report for the proposed
 * port diff).
 */
type SubscriptionRepositoryWithAbandon = MicrosoftGraphSubscriptionRepository & {
  abandonQueued?(id: string, now: number): Promise<void>
}

/**
 * Sends the queue message for a subscription row that is already sitting in
 * `queued` — either just won via `markQueued`, or left there by
 * `finishRunning`'s own requeue. On failure, `releaseQueued` reports whether a
 * notification raced in and set `refresh_pending` meanwhile (`true`: the row
 * is still `queued` with nothing in flight for it, so this must resend) or
 * went to `idle` (`false`: nothing left to do).
 *
 * Centralised (re-review Important #2) so both the notification processor's
 * initial enqueue ({@link enqueueFolderRefresh}) and the consumer's follow-up
 * send (`microsoft-sync.ts`'s `finishRunning` requeue path) share one place
 * that never leaves a `queued` row stranded with no message — the prior
 * per-caller duplication left the initial-enqueue path ignoring the `true`
 * result entirely.
 *
 * Re-review 2 Important #1: exhausting the attempt cap while the LAST
 * `releaseQueued` still reported `true` used to just log and return, leaving
 * the row `queued` with no queue message and no further sender — stranded
 * until the 10-minute stale-recovery window. That case now forces a terminal
 * `queued->idle` transition (dropping the wakeup itself, deliberately: I-11
 * says the 5-minute cron floor, not another in-process retry, is the
 * backstop) and logs it exactly once.
 */
export async function sendMicrosoftFolderRefreshJob(
  env: Env,
  repository: SubscriptionRepositoryWithAbandon,
  subscriptionId: string,
  accountId: string,
  folderPath: string,
  now: number,
): Promise<void> {
  for (let attempt = 1; attempt <= ENQUEUE_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
    try {
      await env.MAIL_QUEUE.send({ kind: 'microsoft-folder-refresh', accountId, folderPath, reason: 'notification' })
      return
    } catch (error) {
      console.error('Unable to enqueue a Microsoft folder refresh', {
        accountId,
        folderPath,
        attempt,
        type: error instanceof Error ? error.name : typeof error,
      })
      const mustResend = await repository.releaseQueued(subscriptionId, now)
      if (!mustResend) return
      // A notification raced in while the send above was failing: the row is
      // still `queued` and nothing is in flight for it, so resend.
    }
  }
  // The loop only falls through here when the final `releaseQueued` above
  // returned `true` (a `false` would have returned already) — the row is
  // still `queued`, still owed a job, and this was the last attempt.
  await repository.abandonQueued?.(subscriptionId, now)
  console.error(
    'Microsoft folder refresh enqueue recovery exhausted its attempt cap; dropped the pending wakeup',
    { accountId, folderPath },
  )
}

/**
 * C-3's "notification arrived" transition, shared by the notification path and
 * the `missed` lifecycle event (task item 2 treats `missed` as a notification).
 *
 * `markQueued` succeeding means this caller won the idle→queued CAS: send the
 * job. Losing it (state was already queued/running, or the repository's own
 * >10-minute crash recovery decided otherwise) means `markPending` records that
 * a fresher notification arrived without adding a second in-flight job (I-10).
 */
async function enqueueFolderRefresh(
  env: Env,
  repository: MicrosoftGraphSubscriptionRepository,
  subscription: MicrosoftGraphSubscription,
  now: number,
): Promise<void> {
  const queued = await repository.markQueued(subscription.id, now)
  if (!queued) {
    await repository.markPending(subscription.id, now)
    return
  }
  await sendMicrosoftFolderRefreshJob(
    env, repository, subscription.id, subscription.accountId, subscription.folderPath, now,
  )
}

async function processNotificationItem(
  env: Env,
  repository: MicrosoftGraphSubscriptionRepository,
  item: MicrosoftGraphNotificationItem,
  now: number,
): Promise<void> {
  // Unknown subscription id or a clientState mismatch: drop silently, exactly
  // like a malformed item (I-8) — a prober must learn nothing from the response,
  // and there is none here to differ anyway (the whole batch already got 202).
  const subscription = await repository.bySubscriptionId(item.subscriptionId)
  if (!subscription) return
  if (!await matchesClientState(item.clientState, subscription.clientStateHash)) return
  await enqueueFolderRefresh(env, repository, subscription, now)
}

/** Pure item-processing logic, directly testable against a fake repository. */
export async function processMicrosoftGraphNotificationItems(
  env: Env,
  repository: MicrosoftGraphSubscriptionRepository,
  items: MicrosoftGraphNotificationItem[],
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  for (const item of items) {
    await processNotificationItem(env, repository, item, now)
  }
}

export function createMicrosoftGraphNotificationProcessor(
  repositoryFor: (env: Env) => MicrosoftGraphSubscriptionRepository,
): NotificationProcessor {
  return (env, items) => processMicrosoftGraphNotificationItems(env, repositoryFor(env), items)
}

/** Wired into `public-routes.ts`. Logs and drops until the runtime is configured. */
export const microsoftGraphNotificationProcessor: NotificationProcessor = (env, items) => {
  if (!runtime) {
    console.error('Microsoft Graph subscription runtime not configured; dropping notifications', {
      count: items.length,
    })
    return Promise.resolve()
  }
  return processMicrosoftGraphNotificationItems(env, runtime.repositoryFor(env), items)
}

async function processLifecycleItem(
  env: Env,
  repository: MicrosoftGraphSubscriptionRepository,
  item: MicrosoftGraphLifecycleItem,
  now: number,
): Promise<void> {
  const subscription = await repository.bySubscriptionId(item.subscriptionId)
  if (!subscription) return
  if (!await matchesClientState(item.clientState, subscription.clientStateHash)) return
  if (item.lifecycleEvent === 'subscriptionRemoved' || item.lifecycleEvent === 'reauthorizationRequired') {
    // Mark stale rather than removing the row outright: the next cron pass
    // rebuilds it (removes remotely if anything is left, then recreates), and
    // in the meantime the row stays visible for diagnostics (Q3).
    await repository.update(subscription.id, { status: 'stale' }, now)
    return
  }
  if (item.lifecycleEvent === 'missed') {
    // Treated as a notification for this subscription (task item 2): Microsoft
    // is telling us it could not guarantee delivery, so refresh defensively.
    await enqueueFolderRefresh(env, repository, subscription, now)
    return
  }
  // Any other lifecycle event Microsoft might add later: no known safe action.
}

/** Pure item-processing logic, directly testable against a fake repository. */
export async function processMicrosoftGraphLifecycleItems(
  env: Env,
  repository: MicrosoftGraphSubscriptionRepository,
  items: MicrosoftGraphLifecycleItem[],
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  for (const item of items) {
    await processLifecycleItem(env, repository, item, now)
  }
}

export function createMicrosoftGraphLifecycleProcessor(
  repositoryFor: (env: Env) => MicrosoftGraphSubscriptionRepository,
): LifecycleProcessor {
  return (env, items) => processMicrosoftGraphLifecycleItems(env, repositoryFor(env), items)
}

/** Wired into `public-routes.ts`. Logs and drops until the runtime is configured. */
export const microsoftGraphLifecycleProcessor: LifecycleProcessor = (env, items) => {
  if (!runtime) {
    console.error('Microsoft Graph subscription runtime not configured; dropping lifecycle events', {
      count: items.length,
    })
    return Promise.resolve()
  }
  return processMicrosoftGraphLifecycleItems(env, runtime.repositoryFor(env), items)
}
