import type { Env } from '../../app/types'

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

/** P2-W1 placeholder processors: accept and drop. P2-W3 supplies the real ones. */
export const dropNotifications: NotificationProcessor = async () => undefined
export const dropLifecycle: LifecycleProcessor = async () => undefined
