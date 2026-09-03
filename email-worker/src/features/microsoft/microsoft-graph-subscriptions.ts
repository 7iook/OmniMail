/**
 * Microsoft Graph `/subscriptions` client (decision card §12, P2-W2).
 *
 * A satellite file, not an addition to `microsoft-graph.ts`: that file is at its
 * 600-line ceiling (recon §11), and its capability is unrelated anyway — reading
 * mail versus managing change-notification subscriptions. This file therefore
 * carries its own private `request()`, mirroring `microsoft-graph.ts`'s timeout /
 * 429-`Retry-After` wait / never-retry-writes-on-5xx / `@odata.nextLink`
 * origin-check rules rather than importing them (that method is private there).
 *
 * Error classification is a SEPARATE axis from `microsoft-graph.ts`'s
 * `MicrosoftGraphErrorCode` (I-13): a mailbox whose reads are fine but whose
 * tenant forbids subscriptions is still a healthy Graph mailbox. Nothing here
 * feeds the transport-cascade failure classifier, and nothing here ever
 * touches the account's sticky-routing column or its status.
 */

import type {
  MicrosoftGraphRemoteSubscription,
  MicrosoftGraphSubscriptionClient as MicrosoftGraphSubscriptionClientPort,
} from './microsoft-types'

const GRAPH_ORIGIN = 'https://graph.microsoft.com'
const GRAPH_BASE = `${GRAPH_ORIGIN}/v1.0`
const REQUEST_TIMEOUT_MS = 20_000
const MAX_ATTEMPTS = 3
const BACKOFF_BASE_MS = 1_000
const MAX_WAIT_IN_INVOCATION_MS = 60_000
/** Each account holds exactly two subscriptions; any more pages means something is wrong. */
const MAX_LIST_PAGES = 20
/**
 * Graph's own ceiling for an Outlook-message subscription (review3 Minor #4):
 * 10,080 minutes (7 days) from the moment Graph receives the request, not
 * from whatever epoch the caller computed `expiresAt` against. Current
 * callers already stay comfortably under this with margin
 * (`microsoft-graph-subscription-lifecycle.ts` uses 10,075 minutes,
 * `microsoft-graph-reconcile.ts` uses 10,020), so clamping here is
 * defense-in-depth against a future caller's bad arithmetic, not a fix for a
 * currently-bad request.
 */
const MAX_EXPIRATION_SECONDS = 10_080 * 60
/** Graph well-known folder names are lowercase ASCII words (`inbox`, `junkemail`, …). */
const WELL_KNOWN_FOLDER = /^[a-z]+$/

export type MicrosoftGraphSubscriptionErrorCode =
  | 'graph_subscription_rejected'
  | 'graph_subscription_transient'
  /**
   * Re-review 2 Important #2a: the caller-supplied {@link
   * MicrosoftGraphSubscriptionRequestBudget} ran out before the next real
   * HTTP attempt. Distinct from `graph_subscription_transient` on purpose —
   * this is never something Microsoft said, so reconciliation must stop the
   * pass without marking any subscription rejected/backed-off for it.
   */
  | 'graph_subscription_budget_exhausted'

export class MicrosoftGraphSubscriptionError extends Error {
  constructor(
    readonly code: MicrosoftGraphSubscriptionErrorCode,
    readonly status: number,
    readonly retryable: boolean,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`Microsoft Graph subscription request failed (${code}).`)
    this.name = 'MicrosoftGraphSubscriptionError'
  }
}

/** Injected so tests never sleep in real time. */
export type MicrosoftGraphSubscriptionSleeper = (ms: number) => Promise<void>
/** Injected so the review3 Minor #4 expiry clamp is deterministically testable. Epoch seconds. */
export type MicrosoftGraphSubscriptionClock = () => number

/**
 * Structural budget port (re-review 2 Important #2a): checked by shape, not
 * imported, so this generic Graph client stays independent of
 * `microsoft-graph-reconcile-budget.ts`'s reconciliation-specific
 * `ReconcileBudget` — the two never import each other, but a `ReconcileBudget`
 * instance already satisfies this shape and can be handed straight through.
 */
export interface MicrosoftGraphSubscriptionRequestBudget {
  /** True while another real HTTP attempt may still start. */
  hasCapacity(): boolean
  /** Call once per real HTTP attempt about to be made. */
  spend(): void
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isoFromEpoch(seconds: number): string {
  return new Date(seconds * 1_000).toISOString()
}

function epochFromIso(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : 0
}

function toRemoteSubscription(value: unknown): MicrosoftGraphRemoteSubscription {
  const row = record(value)
  return {
    subscriptionId: text(row.id),
    resource: text(row.resource),
    notificationUrl: text(row.notificationUrl),
    expiresAt: epochFromIso(text(row.expirationDateTime)),
  }
}

function validateWellKnownFolder(value: string): string {
  const trimmed = value.trim().toLowerCase()
  if (!WELL_KNOWN_FOLDER.test(trimmed)) {
    // Our own bug (a bad constant), not something Graph said — never retryable.
    throw new MicrosoftGraphSubscriptionError('graph_subscription_rejected', 400, false)
  }
  return trimmed
}

function retryAfterSeconds(response: Response): number | null {
  const seconds = Number(response.headers.get('Retry-After'))
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : null
}

/**
 * 429 and 5xx are transient (a wait or a blip, not a verdict on the mailbox);
 * everything else — including 401/403/404 — is a rejection: Microsoft answered
 * and said no. `remove()` special-cases 404 as success on top of this.
 */
function classify(status: number, seconds: number | null): MicrosoftGraphSubscriptionError {
  if (status === 429) {
    return new MicrosoftGraphSubscriptionError('graph_subscription_transient', 429, true, seconds)
  }
  if (status >= 500) {
    return new MicrosoftGraphSubscriptionError('graph_subscription_transient', status, true, seconds)
  }
  return new MicrosoftGraphSubscriptionError('graph_subscription_rejected', status, false)
}

function transportError(error: unknown): MicrosoftGraphSubscriptionError {
  const timedOut = error instanceof DOMException
    && (error.name === 'TimeoutError' || error.name === 'AbortError')
  return timedOut
    ? new MicrosoftGraphSubscriptionError('graph_subscription_transient', 504, true)
    : new MicrosoftGraphSubscriptionError('graph_subscription_transient', 502, true)
}

type Expected = 'json' | 'void'

interface RequestOptions {
  method?: string
  body?: unknown
  /** Whether non-429 failures (5xx, network, timeout) may be retried. */
  retryable?: boolean
  expect?: Expected
}

export class MicrosoftGraphSubscriptionClient implements MicrosoftGraphSubscriptionClientPort {
  private readonly accessToken: string
  private readonly fetcher: typeof fetch
  private readonly sleeper: MicrosoftGraphSubscriptionSleeper
  private readonly clock: MicrosoftGraphSubscriptionClock
  private readonly budget: MicrosoftGraphSubscriptionRequestBudget | undefined

  constructor({
    accessToken,
    // Wrapped, not stored bare: `this.fetcher(...)` would invoke the platform
    // fetch with `this` = the client, which workerd rejects as an illegal
    // invocation (same pitfall `microsoft-graph.ts` documents).
    fetcher = (input, init) => fetch(input, init),
    sleeper = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms) }),
    clock = () => Math.floor(Date.now() / 1_000),
    budget,
  }: {
    accessToken: string
    fetcher?: typeof fetch
    sleeper?: MicrosoftGraphSubscriptionSleeper
    clock?: MicrosoftGraphSubscriptionClock
    /** Re-review 2 Important #2a: optional, charged once per real HTTP attempt. */
    budget?: MicrosoftGraphSubscriptionRequestBudget
  }) {
    this.accessToken = accessToken
    this.fetcher = fetcher
    this.sleeper = sleeper
    this.clock = clock
    this.budget = budget
  }

  /** review3 Minor #4: never send Graph an expiry beyond its own 10,080-minute ceiling. */
  private clampExpiresAt(expiresAt: number): number {
    return Math.min(expiresAt, this.clock() + MAX_EXPIRATION_SECONDS)
  }

  /** Mirrors `microsoft-graph.ts`'s private `request()` — see that file's comment for why. */
  private async request<T>(url: string, options: RequestOptions = {}): Promise<T> {
    const {
      method = 'GET',
      body,
      retryable = method === 'GET',
      expect = 'json',
    } = options
    let lastError: MicrosoftGraphSubscriptionError | undefined

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        const wait = this.delayMs(attempt, lastError)
        if (wait === null) throw lastError as MicrosoftGraphSubscriptionError
        await this.sleeper(wait)
      }

      // Re-review 2 Important #2a: charged per real attempt (this covers
      // every retry within one page/request AND, via `list()` calling
      // `request()` fresh for each page, every page too) — checked and
      // spent right before the fetch, never after a caught failure, so an
      // exhausted budget stops here with its own clear error rather than
      // ever being recorded as something Microsoft said.
      if (this.budget) {
        if (!this.budget.hasCapacity()) {
          throw new MicrosoftGraphSubscriptionError('graph_subscription_budget_exhausted', 0, true)
        }
        this.budget.spend()
      }

      let response: Response
      try {
        const headers = new Headers({
          Accept: 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
        })
        if (body !== undefined) headers.set('Content-Type', 'application/json')
        response = await this.fetcher(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch (error) {
        lastError = transportError(error)
        if (!retryable) throw lastError
        continue
      }

      if (response.ok) return await this.readBody<T>(response, expect)

      const error = classify(response.status, retryAfterSeconds(response))
      // A 429 is a wait, not a failure: honour it even for writes (mirrors
      // `microsoft-graph.ts`). 5xx/network failures on a write are NOT
      // replayed unless the caller opted in via `retryable`.
      if (!error.retryable || (response.status !== 429 && !retryable)) throw error
      lastError = error
    }

    throw lastError ?? new MicrosoftGraphSubscriptionError('graph_subscription_transient', 502, true)
  }

  private delayMs(
    attempt: number,
    lastError: MicrosoftGraphSubscriptionError | undefined,
  ): number | null {
    const seconds = lastError?.retryAfterSeconds
    if (seconds !== null && seconds !== undefined) {
      const requested = seconds * 1_000
      return requested > MAX_WAIT_IN_INVOCATION_MS ? null : requested
    }
    return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), MAX_WAIT_IN_INVOCATION_MS)
  }

  private async readBody<T>(response: Response, expect: Expected): Promise<T> {
    if (expect === 'void') return undefined as T
    if (response.status === 204) return {} as T
    try {
      const parsed = await response.json<unknown>()
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new MicrosoftGraphSubscriptionError('graph_subscription_rejected', 502, false)
      }
      return parsed as T
    } catch (error) {
      if (error instanceof MicrosoftGraphSubscriptionError) throw error
      throw new MicrosoftGraphSubscriptionError('graph_subscription_rejected', 502, false)
    }
  }

  /** A nextLink is server-supplied data: never send the bearer token off-origin (mirrors I-6/I-3 guard). */
  private verifiedNextLink(next: string): string {
    let parsed: URL
    try {
      parsed = new URL(next)
    } catch {
      throw new MicrosoftGraphSubscriptionError('graph_subscription_rejected', 502, false)
    }
    if (parsed.origin !== GRAPH_ORIGIN) {
      throw new MicrosoftGraphSubscriptionError('graph_subscription_rejected', 502, false)
    }
    return parsed.toString()
  }

  async create(input: {
    wellKnownFolder: string
    notificationUrl: string
    lifecycleNotificationUrl: string
    clientState: string
    expiresAt: number
  }): Promise<MicrosoftGraphRemoteSubscription> {
    const wellKnownFolder = validateWellKnownFolder(input.wellKnownFolder)
    const raw = await this.request<Record<string, unknown>>(`${GRAPH_BASE}/subscriptions`, {
      method: 'POST',
      body: {
        changeType: 'created',
        resource: `me/mailFolders('${wellKnownFolder}')/messages`,
        notificationUrl: input.notificationUrl,
        lifecycleNotificationUrl: input.lifecycleNotificationUrl,
        expirationDateTime: isoFromEpoch(this.clampExpiresAt(input.expiresAt)),
        clientState: input.clientState,
      },
      // A write must not be blindly replayed: duplicating a subscription create
      // is a real orphan risk (card C-2), not merely an idempotent re-send.
      retryable: false,
    })
    return toRemoteSubscription(raw)
  }

  async renew(subscriptionId: string, expiresAt: number): Promise<MicrosoftGraphRemoteSubscription> {
    const raw = await this.request<Record<string, unknown>>(
      `${GRAPH_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}`,
      {
        method: 'PATCH',
        body: { expirationDateTime: isoFromEpoch(this.clampExpiresAt(expiresAt)) },
        retryable: false,
      },
    )
    return toRemoteSubscription(raw)
  }

  /** 404 is success: the goal is "it no longer exists" (frozen port contract). */
  async remove(subscriptionId: string): Promise<void> {
    try {
      await this.request<void>(
        `${GRAPH_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}`,
        { method: 'DELETE', retryable: false, expect: 'void' },
      )
    } catch (error) {
      if (error instanceof MicrosoftGraphSubscriptionError && error.status === 404) return
      throw error
    }
  }

  /**
   * Every subscription this app holds for the signed-in user — the basis of
   * the cron reconciliation pass (card C-2). Follows `@odata.nextLink`; never
   * `$skip` arithmetic (I-6).
   */
  async list(): Promise<MicrosoftGraphRemoteSubscription[]> {
    const items: MicrosoftGraphRemoteSubscription[] = []
    let url: string | null = `${GRAPH_BASE}/subscriptions`
    let pages = 0
    while (url) {
      const page = await this.request<Record<string, unknown>>(url)
      pages += 1
      if (Array.isArray(page.value)) items.push(...page.value.map(toRemoteSubscription))
      const next = page['@odata.nextLink']
      if (typeof next !== 'string' || !next) break
      if (pages >= MAX_LIST_PAGES) {
        throw new MicrosoftGraphSubscriptionError('graph_subscription_transient', 502, true)
      }
      url = this.verifiedNextLink(next)
    }
    return items
  }
}

// ---------------------------------------------------------------------------
// C-1 · clientState: generated before creation, only its digest is persisted.
// ---------------------------------------------------------------------------

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/** 32 random bytes, base64url-encoded. Sent to Graph verbatim; never persisted. */
export function generateMicrosoftGraphClientState(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)))
}

/** SHA-256 hex digest of a clientState value — the only form stored in D1 (C-1). */
export async function microsoftGraphClientStateDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Constant-time string compare, for comparing an inbound digest against the stored one. */
export function timingSafeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left)
  const b = new TextEncoder().encode(right)
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index]
  return difference === 0
}
