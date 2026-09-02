import { ImapConnectionError } from '../../platform/imap/imap-errors'
import { MicrosoftGraphError } from './microsoft-graph'
import { MicrosoftStoreError } from './microsoft-store'
import { MicrosoftTokenError } from './microsoft-token'
import type { MicrosoftAccountStatus, MicrosoftTransport } from './microsoft-types'

/**
 * Why a transport failed, at the granularity the fallback matrix needs.
 *
 * The existing `microsoftSyncErrorCode` flattens everything to a string code,
 * which loses the HTTP status and the Retry-After seconds — the two facts the
 * cascade has to decide on. This classifies once, for both transports, so there
 * is a single answer to "may I switch channel?" rather than one per call site.
 */
export type MicrosoftFailureCategory =
  /** Credential rejected: the strongest evidence a channel genuinely cannot serve. */
  | 'auth'
  /** Authorised identity, insufficient scope. */
  | 'permission'
  /** Throttled. A wait, not a channel fault. */
  | 'throttled'
  /** Timeout, 5xx, truncated listing: transient, says nothing about the channel. */
  | 'transient'
  /** Our own bug or a contract mismatch. Switching would hide it. */
  | 'contract'
  /** The mail or folder is gone. Nothing to fail over to. */
  | 'data'

export type MicrosoftOperation = 'read' | 'write'

export interface MicrosoftTransportFailure {
  transport: MicrosoftTransport
  category: MicrosoftFailureCategory
  /** Stable code for the UI and for `last_error_code`. */
  code: string
  status: number
  /** Seconds Microsoft asked us to wait; only ever set for `throttled`. */
  retryAfterSeconds: number | null
  /** Whether the cascade may fall through to the other transport. */
  mayTryOtherTransport: boolean
  /** Whether the winner may overwrite `preferred_transport`. */
  mayRewritePreferred: boolean
}

/**
 * One channel's failure as reported to a client (I-7).
 *
 * The cascade-control fields (`mayTryOtherTransport`, `mayRewritePreferred`,
 * `retryAfterSeconds`) are deliberately absent: they describe what the server
 * decided, not what the user can act on.
 */
export interface MicrosoftTransportAttempt {
  transport: MicrosoftTransport
  category: MicrosoftFailureCategory
  code: string
  /** The upstream HTTP-equivalent status of that channel's failure. */
  status: number
}

export function publicMicrosoftTransportAttempts(
  attempts: readonly MicrosoftTransportFailure[],
): MicrosoftTransportAttempt[] {
  return attempts.map(({ transport, category, code, status }) => ({
    transport, category, code, status,
  }))
}

/**
 * Raised when no transport could serve the mailbox.
 *
 * Carries one entry per attempted channel so the import dialog can say which
 * channel failed and why, rather than a single opaque "validation failed" (I-7).
 */
export class MicrosoftTransportUnavailableError extends MicrosoftStoreError {
  constructor(readonly attempts: MicrosoftTransportFailure[]) {
    super(
      exhaustedStatus(attempts),
      'transport_unavailable',
      'Microsoft 邮箱的 Graph 与 IMAP 通道都无法连接。',
    )
  }
}

/**
 * A 401 from Microsoft must not become a 401 from us: the frontend API client
 * treats that as a lost OmniMail session and logs the user out. The pre-Graph
 * IMAP path already downgraded 401 to 400 for the same reason.
 */
function exhaustedStatus(attempts: readonly MicrosoftTransportFailure[]): number {
  const status = attempts.at(-1)?.status ?? 502
  return status === 401 ? 400 : status
}

/**
 * The fallback matrix (decision card §3.5), as data rather than scattered ifs.
 *
 * Reads and writes differ in exactly one place: a 403 on a read is worth trying
 * the other channel for, while a 403 on a write must surface so the user can
 * re-authorise — silently switching would leave them believing a mail was marked
 * read when it was not.
 */
const MATRIX: Record<MicrosoftFailureCategory, Record<MicrosoftOperation, {
  mayTryOtherTransport: boolean
  mayRewritePreferred: boolean
}>> = {
  auth: {
    read: { mayTryOtherTransport: true, mayRewritePreferred: true },
    write: { mayTryOtherTransport: true, mayRewritePreferred: true },
  },
  permission: {
    read: { mayTryOtherTransport: true, mayRewritePreferred: true },
    write: { mayTryOtherTransport: false, mayRewritePreferred: false },
  },
  // Switching channel while throttled would sidestep the throttling and generate
  // extra load, which extends the lockout (I-3). Rewriting stickiness would make
  // the account flap for the length of the throttling window.
  throttled: {
    read: { mayTryOtherTransport: false, mayRewritePreferred: false },
    write: { mayTryOtherTransport: false, mayRewritePreferred: false },
  },
  // A transient fault is not evidence a channel is down; treating it as such
  // would rewrite stickiness on a blip and send the next sync the wrong way.
  transient: {
    read: { mayTryOtherTransport: false, mayRewritePreferred: false },
    write: { mayTryOtherTransport: false, mayRewritePreferred: false },
  },
  contract: {
    read: { mayTryOtherTransport: false, mayRewritePreferred: false },
    write: { mayTryOtherTransport: false, mayRewritePreferred: false },
  },
  data: {
    read: { mayTryOtherTransport: false, mayRewritePreferred: false },
    write: { mayTryOtherTransport: false, mayRewritePreferred: false },
  },
}

/**
 * Graph errors carry their own classification, so this reads `.code` rather than
 * matching on message text.
 */
const GRAPH_CATEGORY: Record<string, MicrosoftFailureCategory> = {
  graph_throttled: 'throttled',
  graph_credential_rejected: 'auth',
  graph_permission_denied: 'permission',
  graph_message_not_found: 'data',
  graph_unavailable: 'transient',
  graph_connection_failed: 'transient',
  graph_timeout: 'transient',
  // Truncated means "this channel could not answer completely" — never "the
  // remote set is this small". It is a transient shortfall, not a dead channel.
  graph_listing_truncated: 'transient',
  graph_invalid_response: 'contract',
  graph_invalid_next_link: 'contract',
  graph_invalid_message_id: 'contract',
  graph_invalid_folder: 'contract',
  graph_request_failed: 'contract',
}

const TOKEN_CATEGORY: Record<string, MicrosoftFailureCategory> = {
  invalid_grant: 'auth',
  invalid_client: 'auth',
  unauthorized_client: 'permission',
  consent_required: 'permission',
  invalid_scope: 'permission',
  imap_scope_missing: 'permission',
  graph_scope_missing: 'permission',
  token_endpoint_unavailable: 'transient',
  invalid_token_response: 'contract',
}

interface ClassifiedFailure {
  category: MicrosoftFailureCategory
  code: string
  status: number
  retryAfterSeconds?: number | null
}

function graphFailure(error: MicrosoftGraphError): ClassifiedFailure {
  return {
    category: GRAPH_CATEGORY[error.code] ?? 'transient',
    code: error.code,
    status: error.status,
    retryAfterSeconds: error.code === 'graph_throttled' ? error.retryAfterSeconds : null,
  }
}

function tokenFailure(error: MicrosoftTokenError): ClassifiedFailure {
  // A retryable token error is a 429/5xx from the token endpoint. It is a wait,
  // not a verdict on the channel, so it never authorises a switch.
  const category = TOKEN_CATEGORY[error.code]
    ?? (error.retryable ? 'transient' : 'auth')
  return { category, code: error.code, status: error.status }
}

function imapFailure(error: ImapConnectionError): ClassifiedFailure {
  // Message matching is kept only where the protocol gives us nothing else, and
  // only for the two cases the existing code already recognised.
  if (/超过.*上限/.test(error.message)) {
    return { category: 'contract', code: 'response_too_large', status: 413 }
  }
  if (/XOAUTH2/.test(error.message)) {
    return { category: 'permission', code: 'xoauth2_unavailable', status: error.status }
  }
  if (error.status === 400 || error.status === 401) {
    return { category: 'auth', code: 'imap_access_rejected', status: error.status }
  }
  if (error.status === 404) {
    return { category: 'data', code: 'remote_message_not_found', status: 404 }
  }
  if (error.status === 504) return { category: 'transient', code: 'timeout', status: 504 }
  return { category: 'transient', code: 'connection_failed', status: error.status }
}

function storeFailure(error: MicrosoftStoreError): ClassifiedFailure {
  if (error.status === 503) return { category: 'transient', code: error.code, status: 503 }
  if (error.status === 429) return { category: 'throttled', code: error.code, status: 429 }
  if (error.status === 404) return { category: 'data', code: error.code, status: 404 }
  // 409/400 here are configuration facts (password auth removed, wrong auth mode)
  // that no other transport can satisfy either.
  return { category: 'contract', code: error.code, status: error.status }
}

/**
 * An exhausted cascade is judged by what its channels said, not by the wrapper.
 *
 * Every attempt was auth or permission class (nothing else lets the cascade move
 * on). If every channel rejected the credential the credential is dead; if any
 * channel said "insufficient scope" the user can still fix it by re-authorising,
 * which is what `permission` communicates.
 */
function exhaustedFailure(error: MicrosoftTransportUnavailableError): MicrosoftTransportFailure {
  const last = error.attempts.at(-1)
  return {
    transport: last?.transport ?? 'graph',
    category: error.attempts.every(({ category }) => category === 'auth') ? 'auth' : 'permission',
    code: error.code,
    status: error.status,
    retryAfterSeconds: null,
    // Both channels have already been tried; there is nothing left to switch to.
    mayTryOtherTransport: false,
    mayRewritePreferred: false,
  }
}

/**
 * Classifies one transport attempt's failure and answers the two cascade
 * questions in one place.
 *
 * This is the sole authority on whether a failure justifies switching channel or
 * rewriting stickiness. Anything unrecognised is treated as `transient`, which is
 * the conservative answer: it neither switches nor rewrites, so an error class we
 * have not seen before cannot cause channel flapping.
 *
 * `transport` is the channel the caller was speaking to when the error surfaced.
 * For an exhausted cascade it is ignored in favour of the attempts it carries.
 */
export function microsoftTransportFailure(
  error: unknown,
  transport: MicrosoftTransport,
  operation: MicrosoftOperation = 'read',
): MicrosoftTransportFailure {
  if (error instanceof MicrosoftTransportUnavailableError) return exhaustedFailure(error)
  const classified: ClassifiedFailure = error instanceof MicrosoftGraphError ? graphFailure(error)
    : error instanceof MicrosoftTokenError ? tokenFailure(error)
      : error instanceof MicrosoftStoreError ? storeFailure(error)
        : error instanceof ImapConnectionError ? imapFailure(error)
          : { category: 'transient', code: 'connection_failed', status: 502 }
  const rules = MATRIX[classified.category][operation]
  return {
    transport,
    category: classified.category,
    code: classified.code,
    status: classified.status,
    retryAfterSeconds: classified.retryAfterSeconds ?? null,
    ...rules,
  }
}

/**
 * Stored credentials that cannot be used at all. Neither is a channel verdict
 * (so they stay `contract`/`transient` for the cascade), but for the account row
 * they mean the same as a rejected credential: nothing works until the user
 * re-enters it, and re-syncing on a schedule cannot help.
 */
const STATUS_BY_CODE: Record<string, MicrosoftAccountStatus> = {
  credential_decryption_failed: 'credential_error',
  credential_key_unavailable: 'credential_error',
}

const STATUS_BY_CATEGORY: Record<MicrosoftFailureCategory, MicrosoftAccountStatus> = {
  auth: 'credential_error',
  permission: 'permission_error',
  throttled: 'error',
  transient: 'error',
  contract: 'error',
  data: 'error',
}

/**
 * The account `status` a failure should leave behind.
 *
 * One mapping for verify, folder refresh and sync, so the same failure can no
 * longer land as `error` on one path and `credential_error` on another — which
 * is what let a dead account keep accepting manual sync requests.
 * `credential_error` and `permission_error` both stop scheduled and manual sync
 * until the credential is replaced.
 */
export function microsoftAccountStatusForFailure(
  failure: Pick<MicrosoftTransportFailure, 'category' | 'code'>,
): MicrosoftAccountStatus {
  return STATUS_BY_CODE[failure.code] ?? STATUS_BY_CATEGORY[failure.category]
}
