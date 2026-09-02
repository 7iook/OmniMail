export type MicrosoftAuthMode = 'oauth2' | 'password'

/**
 * Which wire protocol a mailbox is reached over.
 *
 * Deliberately distinct from {@link MicrosoftAuthMode} (oauth2 vs password — a
 * credential shape, not a protocol). Keep the two apart: conflating them is what
 * makes the reference implementation's channel state unreadable.
 *
 * `unknown` means "not yet probed" — the cascade tries Graph first for these.
 */
export type MicrosoftTransport = 'graph' | 'imap'
export type MicrosoftPreferredTransport = MicrosoftTransport | 'unknown'
export type MicrosoftAccountStatus =
  | 'pending_validation'
  | 'active'
  | 'syncing'
  | 'credential_error'
  | 'permission_error'
  | 'error'

export interface MicrosoftAccountRow {
  id: string
  user_id: string
  name: string
  provided_email: string
  normalized_email: string
  auth_mode: MicrosoftAuthMode
  /** Sticky routing state: which transport to try first. Sole source of truth. */
  preferred_transport: MicrosoftPreferredTransport
  client_id: string
  authority: string
  refresh_token_cipher: string
  access_token_cipher: string
  access_token_expires_at: number | null
  /** Graph tokens carry different scopes and are NOT interchangeable with IMAP ones. */
  graph_access_token_cipher: string
  graph_access_token_expires_at: number | null
  password_cipher: string
  combination_password_cipher: string
  status: MicrosoftAccountStatus
  last_synced_at: number | null
  next_sync_at: number
  last_error_code: string
  last_error_at: number | null
  sync_lease_id: string | null
  sync_lease_until: number | null
  token_lease_id: string | null
  token_lease_until: number | null
  last_manual_sync_at: number | null
  created_at: number
  updated_at: number
}

export interface MicrosoftAccountSecrets {
  refreshToken: string
  accessToken: string
  password: string
}

export interface MicrosoftAccount extends MicrosoftAccountSecrets {
  id: string
  userId: string
  name: string
  providedEmail: string
  normalizedEmail: string
  authMode: MicrosoftAuthMode
  preferredTransport: MicrosoftPreferredTransport
  clientId: string
  authority: string
  accessTokenExpiresAt: number | null
  graphAccessTokenExpiresAt: number | null
  status: MicrosoftAccountStatus
  lastSyncedAt: number | null
  nextSyncAt: number
  lastErrorCode: string
  lastErrorAt: number | null
  syncLeaseId: string | null
  syncLeaseUntil: number | null
  tokenLeaseId: string | null
  tokenLeaseUntil: number | null
  lastManualSyncAt: number | null
  createdAt: number
  updatedAt: number
}

/** Graph push-subscription health surfaced to the UI (decision card §12.7 Q3). */
export type MicrosoftPushStatus = 'active' | 'degraded' | 'off'

export interface PublicMicrosoftAccount {
  id: string
  name: string
  email: string
  authMode: MicrosoftAuthMode
  clientIdMasked: string
  authority: string
  status: MicrosoftAccountStatus
  /**
   * Which transport this mailbox is actually reached over.
   *
   * Exposed for diagnostics only — the UI deliberately does NOT surface a channel
   * badge (judged a technical-tidiness feature: users can neither pick nor act on
   * it). Kept in the payload so import failures can be reported per transport.
   */
  preferredTransport: MicrosoftPreferredTransport
  lastSyncedAt: number | null
  nextSyncAt: number
  lastErrorCode: string
  lastErrorAt: number | null
  createdAt: number
  hasCredential: true
  /**
   * Additive (card §12.7 Q3). Derived in `MicrosoftAccountStore.list()` from
   * `preferred_transport` / `MICROSOFT_GRAPH_WEBHOOK_BASE_URL` /
   * `microsoft_graph_subscriptions`; see that function for the exact rule.
   */
  pushStatus?: MicrosoftPushStatus
}

export interface MicrosoftFolderRow {
  account_id: string
  path: string
  display_name: string
  flags_json: string
  special_use: string
  uid_validity: number | null
  last_uid: number
  last_listed_at: number
}

export interface MicrosoftFolder {
  path: string
  displayName: string
  flags: string[]
  specialUse: string
  uidValidity: number | null
  lastUid: number
}

export interface MicrosoftMessageMetadata {
  /**
   * Transport-scoped locator. IMAP stores the UID as a string; Graph stores its
   * opaque id (measured at 140 chars, non-numeric — it does not fit an INTEGER
   * column, which is why this is not a `number`).
   *
   * NOT comparable across transports. Use {@link internetMessageId} to decide
   * whether two rows are the same mail.
   */
  remoteId: string
  /** IMAP-only: UIDVALIDITY. `null` for Graph, which has no such concept. */
  uidValidity: number | null
  /** RFC5322 Message-ID — the cross-transport identity. May be empty. */
  internetMessageId: string
  senderName: string
  senderAddress: string
  recipients: string[]
  cc: string[]
  subject: string
  preview: string
  receivedAt: number
  sentAt: number | null
  sizeBytes: number
  flags: string[]
  isRead: boolean
  isStarred: boolean
  hasAttachments: boolean
}

export interface MicrosoftAttachment {
  partId: string
  filename: string
  contentType: string
  size: number
  contentId: string | null
  disposition: string
}

export interface MicrosoftMessageDetail {
  id: string
  from: string
  to: string
  cc: string
  subject: string
  date: string
  body: string
  html: string
  attachments: MicrosoftAttachment[]
}

export interface MicrosoftImportInput {
  name?: unknown
  email?: unknown
  authMode?: unknown
  password?: unknown
  refreshToken?: unknown
  clientId?: unknown
  authority?: unknown
  persistPasswordConfirmed?: unknown
}

export interface ValidMicrosoftImport {
  name: string
  email: string
  authMode: MicrosoftAuthMode
  password: string | null
  refreshToken: string | null
  clientId: string
  authority: string
}

// ---------------------------------------------------------------------------
// Graph change-notification subscriptions (decision card §12 · frozen in P2-W1)
// ---------------------------------------------------------------------------

/** Scheduling state of a subscription (card C-5). `rejected` = permanent refusal, retried daily. */
export type MicrosoftGraphSubscriptionStatus = 'active' | 'stale' | 'rejected'

/** Coalescing state machine for notification-driven refreshes (card C-3). */
export type MicrosoftGraphRefreshState = 'idle' | 'queued' | 'running'

/** Folders that get a subscription. Well-known Graph names; D1 stores the fixed literal paths. */
export const MICROSOFT_GRAPH_SUBSCRIBED_FOLDERS = [
  { wellKnownName: 'inbox', folderPath: 'INBOX' },
  { wellKnownName: 'junkemail', folderPath: 'Junk Email' },
] as const

export interface MicrosoftGraphSubscription {
  id: string
  accountId: string
  folderPath: string
  subscriptionId: string
  /** SHA-256 hex of the clientState sent to Graph; the plaintext is never stored (C-1). */
  clientStateHash: string
  expiresAt: number
  status: MicrosoftGraphSubscriptionStatus
  failureCount: number
  nextAttemptAt: number
  refreshState: MicrosoftGraphRefreshState
  refreshPending: boolean
  refreshStateAt: number
  lastNotifiedAt: number | null
  lastErrorCode: string
  createdAt: number
  updatedAt: number
}

/** What Graph returns for a subscription; the client normalises to this. */
export interface MicrosoftGraphRemoteSubscription {
  subscriptionId: string
  resource: string
  notificationUrl: string
  expiresAt: number
}

/**
 * Talks to Graph's /subscriptions endpoint for one account's access token.
 *
 * Its errors are classified on their own (`subscription_rejected` etc.) and
 * MUST NOT flow into the transport cascade's switch/stickiness decision: a
 * mailbox whose reads are fine but whose tenant forbids subscriptions is still a
 * healthy Graph mailbox (card C-5, S-5).
 */
export interface MicrosoftGraphSubscriptionClient {
  create(input: {
    wellKnownFolder: string
    notificationUrl: string
    lifecycleNotificationUrl: string
    clientState: string
    expiresAt: number
  }): Promise<MicrosoftGraphRemoteSubscription>
  renew(subscriptionId: string, expiresAt: number): Promise<MicrosoftGraphRemoteSubscription>
  /** 404 is success: the goal is "it no longer exists". */
  remove(subscriptionId: string): Promise<void>
  /** All subscriptions this app holds for the signed-in user; the basis of reconciliation (C-2). */
  list(): Promise<MicrosoftGraphRemoteSubscription[]>
}

/**
 * Persistence for `microsoft_graph_subscriptions`. Every state transition is a
 * single conditional UPDATE so two Workers cannot both win (C-3, C-5).
 */
export interface MicrosoftGraphSubscriptionRepository {
  bySubscriptionId(subscriptionId: string): Promise<MicrosoftGraphSubscription | null>
  forAccount(accountId: string): Promise<MicrosoftGraphSubscription[]>
  insert(row: Omit<MicrosoftGraphSubscription, 'createdAt' | 'updatedAt'>, now: number): Promise<void>
  remove(id: string): Promise<void>
  /** Renewal / status changes; returns the updated row or null when it vanished. */
  update(id: string, patch: Partial<Pick<MicrosoftGraphSubscription,
    'subscriptionId' | 'clientStateHash' | 'expiresAt' | 'status' | 'failureCount'
    | 'nextAttemptAt' | 'lastErrorCode'>>, now: number): Promise<MicrosoftGraphSubscription | null>
  /** Rows whose next_attempt_at <= now, oldest first, bounded (C-5 fairness). */
  due(now: number, limit: number): Promise<MicrosoftGraphSubscription[]>
  /** C-3 transitions. Each returns true only if this caller performed the transition. */
  markQueued(id: string, now: number): Promise<boolean>
  markPending(id: string, now: number): Promise<void>
  /**
   * Undoes a failed enqueue. Returns true when a notification raced in and set
   * pending meanwhile — the row then stays queued and the caller must resend.
   */
  releaseQueued(id: string, now: number): Promise<boolean>
  markRunning(id: string, now: number): Promise<boolean>
  /** Ends a run: clears pending and returns whether a follow-up refresh must be enqueued. */
  finishRunning(id: string, now: number): Promise<{ requeue: boolean }>
  /** C-3 retry ownership: running→queued so the platform redelivery can claim it again. */
  requeueForRetry(id: string, now: number): Promise<boolean>
}
