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
