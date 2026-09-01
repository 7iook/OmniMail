/**
 * Thin Microsoft Graph mail client.
 *
 * Shape follows `icloud-apple.ts`'s private `request()`: every timeout, retry and
 * status classification lives in ONE function so no call site can invent its own
 * policy. Two rules this file exists to keep:
 *
 *  - I-3: never retry immediately after a 429. Microsoft keeps accruing usage
 *    while throttling, so an immediate retry extends the lockout. Wait the
 *    `Retry-After` seconds (exponential backoff when the header is absent).
 *  - I-6: paginate by following `@odata.nextLink`. Never compute `$skip`/`$top`
 *    arithmetic — deep `$skip` silently truncates.
 *
 * The access token arrives as a parameter; this file never touches the token layer.
 */

const GRAPH_ORIGIN = 'https://graph.microsoft.com'
const GRAPH_BASE = `${GRAPH_ORIGIN}/v1.0`
const REQUEST_TIMEOUT_MS = 20_000
const MAX_ATTEMPTS = 3
const BACKOFF_BASE_MS = 1_000
/**
 * Ceiling on how long a single invocation will sit waiting.
 *
 * A server-supplied Retry-After longer than this is NOT shortened — waiting less
 * than Microsoft asked for means retrying early, which extends the throttling
 * window because usage keeps accruing while throttled. Instead the request is
 * abandoned and the full retry-after is handed to the caller to reschedule.
 * The cap only truncates our OWN exponential backoff, which we chose ourselves.
 */
const MAX_WAIT_IN_INVOCATION_MS = 60_000
const DEFAULT_PAGE_SIZE = 50
const DEFAULT_MAX_PAGES = 40
/** PidTagMessageSize — the only way Graph exposes a message's size. */
const SIZE_PROPERTY_ID = 'Integer 0x0E08'
const SIZE_EXPAND = `singleValueExtendedProperties($filter=id eq '${SIZE_PROPERTY_ID}')`

/**
 * Fields selected for a list page. `size` is deliberately absent: the v1.0
 * `message` resource has no such property and selecting it rejects the request.
 * Use `includeSize` to pull PidTagMessageSize via `$expand` instead.
 */
export const GRAPH_MESSAGE_LIST_SELECT = [
  'id',
  'internetMessageId',
  'subject',
  'bodyPreview',
  'isRead',
  'hasAttachments',
  'receivedDateTime',
  'sentDateTime',
  'from',
  'sender',
  'toRecipients',
  'ccRecipients',
].join(',')

export const GRAPH_MESSAGE_DETAIL_SELECT = `${GRAPH_MESSAGE_LIST_SELECT},body`

/** Ids only — reconciliation does not need previews or recipients. */
export const GRAPH_MESSAGE_ID_SELECT = 'id,internetMessageId'

/**
 * `contentId` is readable in the response body but is NOT selectable: including
 * it makes Graph reject the whole request. Kept out of `$select` on purpose.
 */
export const GRAPH_ATTACHMENT_SELECT = 'id,name,contentType,size,isInline'

/** `wellKnownName` is beta-only; selecting it on v1.0 rejects the request. */
export const GRAPH_FOLDER_SELECT = 'id,displayName,parentFolderId,totalItemCount,unreadItemCount'

export type MicrosoftGraphErrorCode =
  | 'graph_throttled'
  | 'graph_credential_rejected'
  | 'graph_permission_denied'
  | 'graph_message_not_found'
  | 'graph_unavailable'
  | 'graph_connection_failed'
  | 'graph_timeout'
  | 'graph_request_failed'
  | 'graph_invalid_response'
  | 'graph_invalid_next_link'
  /** A listing hit the page budget; the partial set must not be used as complete. */
  | 'graph_listing_truncated'
  | 'graph_invalid_message_id'
  | 'graph_invalid_folder'

export class MicrosoftGraphError extends Error {
  constructor(
    readonly code: MicrosoftGraphErrorCode,
    readonly status: number,
    readonly retryable: boolean,
    /**
     * Seconds Microsoft asked us to wait. Present for `graph_throttled` so the
     * orchestration layer can feed it straight into scheduling instead of
     * guessing a delay.
     */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`Microsoft Graph request failed (${code}).`)
    this.name = 'MicrosoftGraphError'
  }
}

export interface MicrosoftGraphAddress {
  name: string
  address: string
}

export interface MicrosoftGraphMessage {
  /** Graph's opaque id (measured at 140 chars, non-numeric). Transport-scoped. */
  remoteId: string
  /** RFC5322 Message-ID — the cross-transport identity. May be empty. */
  internetMessageId: string
  subject: string
  preview: string
  isRead: boolean
  hasAttachments: boolean
  receivedAt: number
  sentAt: number | null
  from: MicrosoftGraphAddress | null
  to: MicrosoftGraphAddress[]
  cc: MicrosoftGraphAddress[]
  /** Only populated when `includeSize` was requested; `null` otherwise. */
  sizeBytes: number | null
  body: { contentType: string; content: string } | null
}

export interface MicrosoftGraphFolder {
  id: string
  displayName: string
  parentFolderId?: string
  totalItemCount?: number
  unreadItemCount?: number
}

export interface MicrosoftGraphAttachment {
  id: string
  name: string
  contentType: string
  size: number
  isInline: boolean
  /** Read from the body — never from `$select` (Graph rejects that). */
  contentId: string | null
}

export interface MicrosoftGraphMessagePage {
  messages: MicrosoftGraphMessage[]
  /** True when the page budget stopped us before `@odata.nextLink` ran out. */
  truncated: boolean
}

export interface MicrosoftGraphListOptions {
  pageSize?: number
  maxPages?: number
  includeSize?: boolean
}

/** Injected so tests never sleep in real time. */
export type MicrosoftGraphSleeper = (ms: number) => Promise<void>

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function address(value: unknown): MicrosoftGraphAddress | null {
  const email = record(record(value).emailAddress)
  const mail = text(email.address)
  const name = text(email.name)
  if (!mail && !name) return null
  return { name, address: mail }
}

function addresses(value: unknown): MicrosoftGraphAddress[] {
  if (!Array.isArray(value)) return []
  return value.map(address).filter((item): item is MicrosoftGraphAddress => item !== null)
}

function epochSeconds(value: unknown): number | null {
  const parsed = Date.parse(text(value))
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : null
}

function sizeFromExtendedProperties(value: unknown): number | null {
  if (!Array.isArray(value)) return null
  for (const entry of value) {
    const row = record(entry)
    // Graph echoes the id lowercased and without the leading zero ("Integer 0xe08").
    if (!text(row.id).toLowerCase().replace(/\s+/g, '').includes('0xe08')) continue
    const size = Number(row.value)
    if (Number.isSafeInteger(size) && size >= 0) return size
  }
  return null
}

function toMessage(value: unknown): MicrosoftGraphMessage {
  const row = record(value)
  const body = record(row.body)
  const bodyContent = text(body.content)
  const bodyType = text(body.contentType)
  return {
    remoteId: text(row.id),
    internetMessageId: text(row.internetMessageId),
    subject: text(row.subject),
    preview: text(row.bodyPreview),
    isRead: row.isRead === true,
    hasAttachments: row.hasAttachments === true,
    receivedAt: epochSeconds(row.receivedDateTime) ?? 0,
    sentAt: epochSeconds(row.sentDateTime),
    from: address(row.from) ?? address(row.sender),
    to: addresses(row.toRecipients),
    cc: addresses(row.ccRecipients),
    sizeBytes: sizeFromExtendedProperties(row.singleValueExtendedProperties),
    body: bodyContent || bodyType ? { contentType: bodyType, content: bodyContent } : null,
  }
}

function toFolder(value: unknown): MicrosoftGraphFolder {
  const row = record(value)
  const folder: MicrosoftGraphFolder = {
    id: text(row.id),
    displayName: text(row.displayName),
  }
  if (typeof row.parentFolderId === 'string') folder.parentFolderId = row.parentFolderId
  if (typeof row.totalItemCount === 'number') folder.totalItemCount = row.totalItemCount
  if (typeof row.unreadItemCount === 'number') folder.unreadItemCount = row.unreadItemCount
  return folder
}

function toAttachment(value: unknown): MicrosoftGraphAttachment {
  const row = record(value)
  return {
    id: text(row.id),
    name: text(row.name),
    contentType: text(row.contentType) || 'application/octet-stream',
    size: Number.isSafeInteger(row.size) ? row.size as number : 0,
    isInline: row.isInline === true,
    contentId: typeof row.contentId === 'string' ? row.contentId : null,
  }
}

/** Graph well-known folder names (v1.0). Anything else must look like a folder id. */
const WELL_KNOWN_FOLDERS = new Set([
  'archive', 'clutter', 'conflicts', 'conversationhistory', 'deleteditems', 'drafts',
  'inbox', 'junkemail', 'localfailures', 'msgfolderroot', 'outbox',
  'recoverableitemsdeletions', 'scheduled', 'searchfolders', 'sentitems',
  'serverfailures', 'syncissues',
])

/** Opaque folder ids are base64-ish; `.` and `/` would let a value walk the path. */
const FOLDER_ID = /^[A-Za-z0-9_\-=+]+$/

function folderSegment(folder: string): string {
  const value = folder.trim()
  if (!value) throw new MicrosoftGraphError('graph_invalid_folder', 400, false)
  if (!WELL_KNOWN_FOLDERS.has(value.toLowerCase()) && !FOLDER_ID.test(value)) {
    throw new MicrosoftGraphError('graph_invalid_folder', 400, false)
  }
  return encodeURIComponent(value)
}

function messageSegment(messageId: string): string {
  const value = messageId.trim()
  if (!value) throw new MicrosoftGraphError('graph_invalid_message_id', 400, false)
  return encodeURIComponent(value)
}

function retryAfterSeconds(response: Response): number | null {
  const seconds = Number(response.headers.get('Retry-After'))
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : null
}

function classify(status: number, seconds: number | null): MicrosoftGraphError {
  if (status === 429) return new MicrosoftGraphError('graph_throttled', 429, true, seconds)
  if (status === 401) return new MicrosoftGraphError('graph_credential_rejected', 401, false)
  if (status === 403) return new MicrosoftGraphError('graph_permission_denied', 403, false)
  if (status === 404) return new MicrosoftGraphError('graph_message_not_found', 404, false)
  if (status === 408) return new MicrosoftGraphError('graph_timeout', 504, true)
  if (status >= 500) return new MicrosoftGraphError('graph_unavailable', 502, true, seconds)
  return new MicrosoftGraphError('graph_request_failed', status, false)
}

function transportError(error: unknown): MicrosoftGraphError {
  const timedOut = error instanceof DOMException
    && (error.name === 'TimeoutError' || error.name === 'AbortError')
  // Never surface the raw transport message: it can carry internal host detail.
  return timedOut
    ? new MicrosoftGraphError('graph_timeout', 504, true)
    : new MicrosoftGraphError('graph_connection_failed', 502, true)
}

type Expected = 'json' | 'bytes' | 'void'

interface RequestOptions {
  method?: string
  body?: unknown
  prefer?: string
  /** Whether non-429 failures (5xx, network, timeout) may be retried. */
  retryable?: boolean
  expect?: Expected
}

export class MicrosoftGraphClient {
  private readonly accessToken: string
  private readonly fetcher: typeof fetch
  private readonly sleeper: MicrosoftGraphSleeper

  constructor({
    accessToken,
    fetcher = fetch,
    sleeper = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms) }),
  }: {
    accessToken: string
    fetcher?: typeof fetch
    sleeper?: MicrosoftGraphSleeper
  }) {
    this.accessToken = accessToken
    this.fetcher = fetcher
    this.sleeper = sleeper
  }

  /**
   * The one place that talks to Graph.
   *
   * Timeout, retry budget, 429 wait and status classification all live here. Call
   * sites pass intent (`retryable`, `expect`) and never their own policy — that is
   * what keeps I-3 enforceable at a single point.
   */
  private async request<T>(url: string, options: RequestOptions = {}): Promise<T> {
    const {
      method = 'GET',
      body,
      prefer,
      retryable = method === 'GET',
      expect = 'json',
    } = options
    let lastError: MicrosoftGraphError | undefined

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        // Wait BEFORE the retry. Retrying a throttled request immediately keeps
        // accruing usage against the limit and extends the lockout.
        const wait = this.delayMs(attempt, lastError)
        // Server asked for longer than we may hold: surface it with the full
        // retry-after so scheduling can defer, rather than retrying early.
        if (wait === null) throw lastError as MicrosoftGraphError
        await this.sleeper(wait)
      }

      let response: Response
      try {
        const headers = new Headers({
          Accept: expect === 'bytes' ? '*/*' : 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
        })
        if (prefer) headers.set('Prefer', prefer)
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
      // A 429 is a wait, not a failure: honour it even for writes, which are
      // idempotent here (PATCH isRead). Everything else respects `retryable`.
      if (!error.retryable || (error.code !== 'graph_throttled' && !retryable)) throw error
      lastError = error
    }

    throw lastError ?? new MicrosoftGraphError('graph_request_failed', 502, true)
  }

  /**
   * How long to wait before the next attempt, or `null` when the server's wait is
   * longer than this invocation should hold — the caller must reschedule instead.
   */
  private delayMs(attempt: number, lastError: MicrosoftGraphError | undefined): number | null {
    const seconds = lastError?.retryAfterSeconds
    if (seconds !== null && seconds !== undefined) {
      const requested = seconds * 1_000
      return requested > MAX_WAIT_IN_INVOCATION_MS ? null : requested
    }
    return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), MAX_WAIT_IN_INVOCATION_MS)
  }

  private async readBody<T>(response: Response, expect: Expected): Promise<T> {
    if (expect === 'void') return undefined as T
    if (expect === 'bytes') {
      try {
        return await response.arrayBuffer() as T
      } catch {
        throw new MicrosoftGraphError('graph_invalid_response', 502, false)
      }
    }
    if (response.status === 204) return {} as T
    try {
      const parsed = await response.json<unknown>()
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new MicrosoftGraphError('graph_invalid_response', 502, false)
      }
      return parsed as T
    } catch (error) {
      if (error instanceof MicrosoftGraphError) throw error
      throw new MicrosoftGraphError('graph_invalid_response', 502, false)
    }
  }

  /**
   * Walks `@odata.nextLink` until it is absent.
   *
   * No `$skip`/`$top` arithmetic anywhere: the server's link is used verbatim,
   * which is what keeps deep pages from silently truncating (I-6).
   */
  private async collect<T>(
    firstUrl: string,
    map: (value: unknown) => T,
    maxPages: number,
  ): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = []
    let url: string | null = firstUrl
    let pages = 0

    while (url) {
      const page = await this.request<Record<string, unknown>>(url)
      pages += 1
      if (Array.isArray(page.value)) items.push(...page.value.map(map))
      const next = page['@odata.nextLink']
      if (typeof next !== 'string' || !next) return { items, truncated: false }
      if (pages >= maxPages) return { items, truncated: true }
      url = this.verifiedNextLink(next)
    }
    return { items, truncated: false }
  }

  /** A nextLink is server-supplied data: never send the bearer token off-origin. */
  private verifiedNextLink(next: string): string {
    let parsed: URL
    try {
      parsed = new URL(next)
    } catch {
      throw new MicrosoftGraphError('graph_invalid_next_link', 502, false)
    }
    if (parsed.origin !== GRAPH_ORIGIN) {
      throw new MicrosoftGraphError('graph_invalid_next_link', 502, false)
    }
    return parsed.toString()
  }

  /** Every mail folder in the mailbox, following nextLink across pages. */
  async listFolders(options: { maxPages?: number } = {}): Promise<MicrosoftGraphFolder[]> {
    const url = new URL(`${GRAPH_BASE}/me/mailFolders`)
    url.searchParams.set('$select', GRAPH_FOLDER_SELECT)
    url.searchParams.set('$top', String(DEFAULT_PAGE_SIZE))
    const { items, truncated } = await this.collect(
      url.toString(),
      toFolder,
      options.maxPages ?? DEFAULT_MAX_PAGES,
    )
    // A partial folder list would make the missing folders look absent rather
    // than unfetched, so callers must not silently receive one.
    if (truncated) {
      throw new MicrosoftGraphError('graph_listing_truncated', 502, true)
    }
    return items
  }

  /**
   * One folder's messages, newest first, every page.
   *
   * `folder` is a Graph well-known name (`inbox`, `junkemail`, `deleteditems`, …)
   * or an opaque folder id.
   */
  async listMessages(
    folder: string,
    options: MicrosoftGraphListOptions = {},
  ): Promise<MicrosoftGraphMessagePage> {
    const url = this.messagesUrl(folder, GRAPH_MESSAGE_LIST_SELECT, options)
    const { items, truncated } = await this.collect(
      url,
      toMessage,
      options.maxPages ?? DEFAULT_MAX_PAGES,
    )
    return { messages: items, truncated }
  }

  /**
   * The remote ids currently present in a folder, for deletion reconciliation.
   *
   * Selects ids only — reconciliation compares identity, so pulling previews and
   * recipients would just widen the response and the throttling risk.
   */
  async listMessageIds(
    folder: string,
    options: { pageSize?: number; maxPages?: number } = {},
  ): Promise<string[]> {
    const url = this.messagesUrl(folder, GRAPH_MESSAGE_ID_SELECT, options)
    const { items, truncated } = await this.collect(
      url,
      (value) => text(record(value).id),
      options.maxPages ?? DEFAULT_MAX_PAGES,
    )
    // Deletion reconciliation treats absence from this set as "deleted remotely",
    // so a partial set would delete mail that still exists. Refuse rather than
    // hand back something the caller cannot tell is incomplete.
    if (truncated) {
      throw new MicrosoftGraphError('graph_listing_truncated', 502, true)
    }
    return items.filter(Boolean)
  }

  private messagesUrl(
    folder: string,
    select: string,
    options: MicrosoftGraphListOptions,
  ): string {
    const url = new URL(`${GRAPH_BASE}/me/mailFolders/${folderSegment(folder)}/messages`)
    url.searchParams.set('$select', select)
    url.searchParams.set('$top', String(options.pageSize ?? DEFAULT_PAGE_SIZE))
    url.searchParams.set('$orderby', 'receivedDateTime desc')
    // No $skip: paging is by @odata.nextLink only (I-6).
    if (options.includeSize) url.searchParams.set('$expand', SIZE_EXPAND)
    return url.toString()
  }

  /** One message's parsed content, body in HTML. */
  async getMessageContent(messageId: string): Promise<MicrosoftGraphMessage> {
    const url = new URL(`${GRAPH_BASE}/me/messages/${messageSegment(messageId)}`)
    url.searchParams.set('$select', GRAPH_MESSAGE_DETAIL_SELECT)
    return toMessage(await this.request<Record<string, unknown>>(url.toString(), {
      prefer: "outlook.body-content-type='html'",
    }))
  }

  /** One message's raw MIME, for the parser that already handles IMAP RFC822. */
  async getMessageMime(messageId: string): Promise<ArrayBuffer> {
    return await this.request<ArrayBuffer>(
      `${GRAPH_BASE}/me/messages/${messageSegment(messageId)}/$value`,
      { expect: 'bytes' },
    )
  }

  /**
   * Attachment metadata. `contentId` is read from the body, never `$select`ed.
   *
   * Paged like every other listing: a message with more attachments than one page
   * would otherwise silently lose the rest (I-6).
   */
  async listAttachments(
    messageId: string,
    options: { maxPages?: number } = {},
  ): Promise<MicrosoftGraphAttachment[]> {
    const url = new URL(`${GRAPH_BASE}/me/messages/${messageSegment(messageId)}/attachments`)
    url.searchParams.set('$select', GRAPH_ATTACHMENT_SELECT)
    const { items, truncated } = await this.collect(
      url.toString(),
      toAttachment,
      options.maxPages ?? DEFAULT_MAX_PAGES,
    )
    if (truncated) {
      throw new MicrosoftGraphError('graph_listing_truncated', 502, true)
    }
    return items
  }

  /**
   * Marks one message read.
   *
   * PATCH is not retried on failure — a write must not be replayed blindly — but
   * a 429 is still honoured, since that is a wait rather than a failure and
   * setting `isRead: true` twice has no additional effect.
   */
  async markRead(messageId: string): Promise<void> {
    await this.request<void>(`${GRAPH_BASE}/me/messages/${messageSegment(messageId)}`, {
      method: 'PATCH',
      body: { isRead: true },
      retryable: false,
      expect: 'void',
    })
  }
}
