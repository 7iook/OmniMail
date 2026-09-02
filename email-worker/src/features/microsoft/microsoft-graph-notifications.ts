import type { Env } from '../../app/types'
import { sha256 } from '../auth/session/auth'
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
  if (text.length > MAX_NOTIFICATION_BODY_BYTES) return []
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return []
  }
  const value = (body as { value?: unknown })?.value
  if (!Array.isArray(value)) return []
  const items: T[] = []
  for (const raw of value.slice(0, MAX_NOTIFICATION_ITEMS)) {
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
 */
export interface MicrosoftGraphSubscriptionRuntime {
  repositoryFor: (env: Env) => MicrosoftGraphSubscriptionRepository
  clientFor: (accessToken: string) => MicrosoftGraphSubscriptionClient
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
 * C-3's "notification arrived" transition, shared by the notification path and
 * the `missed` lifecycle event (task item 2 treats `missed` as a notification).
 *
 * `markQueued` succeeding means this caller won the idle→queued CAS: send the
 * job. Losing it (state was already queued/running, or the repository's own
 * >10-minute crash recovery decided otherwise) means `markPending` records that
 * a fresher notification arrived without adding a second in-flight job (I-10).
 * A send failure releases the slot rather than leaving it stuck `queued`
 * forever with nothing in the queue to ever call `finishRunning`.
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
  try {
    await env.MAIL_QUEUE.send({
      kind: 'microsoft-folder-refresh',
      accountId: subscription.accountId,
      folderPath: subscription.folderPath,
      reason: 'notification',
    })
  } catch (error) {
    console.error('Unable to enqueue Microsoft folder refresh from a Graph notification', {
      accountId: subscription.accountId,
      folderPath: subscription.folderPath,
      type: error instanceof Error ? error.name : typeof error,
    })
    await repository.releaseQueued(subscription.id, now)
  }
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
