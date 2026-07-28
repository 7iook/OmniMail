export type Folder = 'inbox' | 'starred' | 'sent' | 'trash'

export interface AppConfig {
  appName: string
  setupComplete: boolean
  replyEnabled: boolean
  registrationEnabled: boolean
  registrationDomainPolicy: RegistrationDomainPolicy
  registrationProtectionReady: boolean
  turnstileSiteKey: string
  mailRefreshInterval: MailRefreshInterval
  remoteImagesEnabled: boolean
  superAdminEmail: string
  setupRequirements: SetupRequirements
}

export interface SetupRequirements {
  databaseReady: boolean
  storageReady: boolean
  queueReady: boolean
  superAdminReady: boolean
  setupTokenReady: boolean
}

export type DeploymentCheckState = 'ready' | 'missing' | 'warning' | 'manual'

export interface DeploymentCheckItem {
  id: string
  group: 'core' | 'security' | 'mail'
  label: string
  state: DeploymentCheckState
  required: boolean
  detail: string
  action: string
}

export interface DeploymentCheck {
  generatedAt: number
  ready: boolean
  checks: DeploymentCheckItem[]
}

export type RegistrationDomainPolicyMode = 'blocklist' | 'allowlist'

export interface RegistrationDomainPolicy {
  mode: RegistrationDomainPolicyMode
  domains: string[]
}

export type MailRefreshInterval = 0 | 5 | 10 | 30 | 60 | 120

export type UserRole = 'super_admin' | 'admin' | 'user' | 'temporary'

export interface User {
  id: string
  email: string
  displayName: string
  role: UserRole
  mailboxLimit: number
  canCreateMailboxes: boolean
  canReply: boolean
  temporaryExpiresAt: number | null
}

export type AccountStatus = 'active' | 'disabled'

export interface AdminUser extends User {
  status: AccountStatus
  mailboxCount: number
  createdAt: number
  updatedAt: number
}

export interface ManagedUserPolicy {
  role: Exclude<UserRole, 'super_admin'>
  status: AccountStatus
  mailboxLimit: number
  canCreateMailboxes: boolean
  canReply: boolean
}

export interface CreateManagedUser extends ManagedUserPolicy {
  email: string
  displayName: string
  password: string
}

export interface MailCounts {
  unread: number
  starred: number
  sent: number
  trash: number
}

export interface PageInfo {
  hasMore: boolean
  nextCursor: string | null
  limit: number
}

export interface AdminUserTotals {
  total: number
  active: number
  disabled: number
}

export type AuditDays = 1 | 7 | 30 | 90
export type AuditCategory =
  | 'all'
  | 'auth'
  | 'account'
  | 'user'
  | 'mailbox'
  | 'domain'
  | 'invitation'
  | 'message'
  | 'system'

export interface AuditLog {
  id: number
  actor: {
    id: string
    email: string | null
    displayName: string | null
    role: UserRole | null
  } | null
  action: string
  targetId: string | null
  target: {
    id: string | null
    email: string | null
    displayName: string | null
  } | null
  ip: string
  detail: Record<string, unknown>
  createdAt: number
}

export interface AuditSummary {
  total: number
  loginSuccess: number
  loginFailed: number
}

export interface MailStatistics {
  days: 7 | 30 | 90
  generatedAt: number
  summary: {
    totalReceived: number
    periodReceived: number
    todayReceived: number
    uniqueSenders: number
  }
  daily: Array<{ day: number; count: number }>
  sourceDomains: Array<{ domain: string; count: number }>
  topSenders: Array<{ address: string; name: string | null; count: number }>
}

export interface MailboxAddress {
  address: string
  domain: string
  isPrimary: boolean
  isActive: boolean
}

export interface ManagedDomain {
  name: string
  isActive: boolean
  mailboxCount: number
  createdAt: number
  updatedAt: number
}

export type InviteState = 'active' | 'expired' | 'used' | 'revoked' | 'domain_disabled'

export interface TemporaryInvite {
  id: string
  domain: string
  expiresAt: number
  multiUse: boolean
  useCount: number
  addressMode: 'assigned' | 'self_selected'
  assignedAddress: string | null
  accountLifetimeHours: number
  mailboxLimit: number
  canCreateMailboxes: boolean
  canReply: boolean
  createdAt: number
  state: InviteState
}

export interface CreateTemporaryInvite {
  domain: string
  expiresInHours: number
  accountLifetimeHours: number
  multiUse: boolean
  addressMode: 'assigned' | 'self_selected'
  assignedLocalPart: string
  mailboxLimit: number
  canCreateMailboxes: boolean
  canReply: boolean
}

export type MailboxScope =
  | { type: 'all' }
  | { type: 'domain'; value: string }
  | { type: 'mailbox'; value: string }

export interface MessageSummary {
  id: string
  mailboxAddress: string
  direction: 'incoming' | 'outgoing'
  status: 'processing' | 'ready' | 'failed' | 'sent'
  folder: 'inbox' | 'sent' | 'trash'
  senderName: string
  senderAddress: string
  recipients: string[]
  subject: string
  preview: string
  date: number
  attachmentCount: number
  isRead: boolean
  isStarred: boolean
  processingError: string | null
}

export interface Attachment {
  id: string
  filename: string
  contentType: string
  size: number
  contentId: string | null
  disposition: string
}

export interface MessageDetail extends MessageSummary {
  messageId: string | null
  inReplyTo: string | null
  references: string | null
  cc: string[]
  text: string
  html: string
  attachments: Attachment[]
}

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN || '').replace(/\/$/, '')
const REQUEST_TIMEOUT_MS = 15000

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  let response: Response
  try {
    response = await fetch(`${API_ORIGIN}${path}`, {
      ...init,
      headers,
      credentials: 'include',
      signal: init.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    if (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name)) {
      throw new ApiError(t('连接超时，请检查网络后重试。'), 408)
    }
    throw error
  }
  const data = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) {
    throw new ApiError(
      data.error ? t(data.error) : t('请求失败（{status}）', { status: response.status }),
      response.status,
    )
  }
  return data as T
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value)
}

export const api = {
  config: () => request<AppConfig>('/api/config'),
  session: () => request<{ user: User | null }>('/api/session'),
  setup: (input: { displayName: string; password: string; setupToken: string }) => (
    request<{ user: User }>('/api/setup', { method: 'POST', body: jsonBody(input) })
  ),
  login: (email: string, password: string) => (
    request<{ user: User }>('/api/login', {
      method: 'POST',
      body: jsonBody({ email, password }),
    })
  ),
  register: (input: {
    email: string
    displayName: string
    password: string
    turnstileToken: string
  }) => (
    request<{ user: User }>('/api/register', {
      method: 'POST',
      body: jsonBody(input),
    })
  ),
  logout: () => request<{ ok: true }>('/api/logout', { method: 'POST' }),
  deploymentCheck: () => request<DeploymentCheck>('/api/admin/deployment-check'),
  updateRegistrationSetting: (enabled: boolean) => (
    request<{ registrationEnabled: boolean }>('/api/admin/settings/registration', {
      method: 'PATCH',
      body: jsonBody({ enabled }),
    })
  ),
  updateRegistrationDomainPolicy: (policy: RegistrationDomainPolicy) => (
    request<{ registrationDomainPolicy: RegistrationDomainPolicy }>(
      '/api/admin/settings/registration-domains',
      {
        method: 'PATCH',
        body: jsonBody(policy),
      },
    )
  ),
  updateMailRefreshInterval: (interval: MailRefreshInterval) => (
    request<{ mailRefreshInterval: MailRefreshInterval }>('/api/admin/settings/mail-refresh', {
      method: 'PATCH',
      body: jsonBody({ interval }),
    })
  ),
  updateRemoteImagesSetting: (enabled: boolean) => (
    request<{ remoteImagesEnabled: boolean }>('/api/admin/settings/remote-images', {
      method: 'PATCH',
      body: jsonBody({ enabled }),
    })
  ),
  updateAccount: (input: {
    displayName?: string
    currentPassword?: string
    newPassword?: string
  }) => request<{ user: User }>('/api/account', {
    method: 'PATCH',
    body: jsonBody(input),
  }),
  deleteAccount: (currentPassword: string) => request<{ ok: true }>('/api/account', {
    method: 'DELETE',
    body: jsonBody({ currentPassword }),
  }),
  mailStatistics: (days: 7 | 30 | 90) => request<MailStatistics>(
    `/api/admin/statistics?days=${days}`,
  ),
  auditLogs: (input: {
    days: AuditDays
    category: AuditCategory
    query: string
    cursor?: string
  }) => {
    const search = new URLSearchParams({
      days: String(input.days),
      category: input.category,
      limit: '50',
    })
    if (input.query) search.set('q', input.query)
    if (input.cursor) search.set('cursor', input.cursor)
    return request<{
      logs: AuditLog[]
      page: PageInfo
      summary: AuditSummary
    }>(`/api/admin/audit-logs?${search}`)
  },
  adminUsers: (cursor?: string) => {
    const search = new URLSearchParams({ limit: '50' })
    if (cursor) search.set('cursor', cursor)
    return request<{
      users: AdminUser[]
      page: PageInfo
      totals: AdminUserTotals
    }>(`/api/admin/users?${search}`)
  },
  createAdminUser: (input: CreateManagedUser) => (
    request<{ user: AdminUser }>('/api/admin/users', {
      method: 'POST',
      body: jsonBody(input),
    })
  ),
  updateAdminUser: (id: string, input: ManagedUserPolicy) => (
    request<{ user: AdminUser }>(`/api/admin/users/${id}`, {
      method: 'PATCH',
      body: jsonBody(input),
    })
  ),
  domains: () => request<{ domains: ManagedDomain[] }>('/api/domains'),
  createDomain: (name: string) => request<{ domain: ManagedDomain }>('/api/admin/domains', {
    method: 'POST',
    body: jsonBody({ name }),
  }),
  updateDomain: (name: string, isActive: boolean) => (
    request<{ domain: ManagedDomain }>(`/api/admin/domains/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: jsonBody({ isActive }),
    })
  ),
  deleteDomain: (name: string) => request<{ ok: true }>(
    `/api/admin/domains/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  ),
  temporaryInvites: (cursor?: string) => {
    const search = new URLSearchParams({ limit: '30' })
    if (cursor) search.set('cursor', cursor)
    return request<{ invites: TemporaryInvite[]; page: PageInfo }>(
      `/api/admin/invites?${search}`,
    )
  },
  createTemporaryInvite: (input: CreateTemporaryInvite) => (
    request<{ invite: TemporaryInvite; token: string }>('/api/admin/invites', {
      method: 'POST',
      body: jsonBody(input),
    })
  ),
  revokeTemporaryInvite: (id: string) => request<{ ok: true }>(
    `/api/admin/invites/${id}/revoke`,
    { method: 'PATCH' },
  ),
  temporaryInvite: (token: string) => request<{ invite: TemporaryInvite }>(
    `/api/invitations/${encodeURIComponent(token)}`,
  ),
  registerTemporaryInvite: (
    token: string,
    input: {
      displayName: string
      localPart?: string
      password: string
      turnstileToken?: string
    },
  ) => request<{ email: string }>(`/api/invitations/${encodeURIComponent(token)}`, {
    method: 'POST',
    body: jsonBody(input),
  }),
  mailboxes: () => request<{ mailboxes: MailboxAddress[] }>('/api/mailboxes'),
  addMailbox: (address: string) => request<{ mailbox: MailboxAddress }>('/api/mailboxes', {
    method: 'POST',
    body: jsonBody({ address }),
  }),
  updateMailbox: (address: string, isActive: boolean) => (
    request<{ mailbox: MailboxAddress }>(`/api/mailboxes/${encodeURIComponent(address)}`, {
      method: 'PATCH',
      body: jsonBody({ isActive }),
    })
  ),
  messages: (folder: Folder, query: string, scope: MailboxScope, cursor?: string) => {
    const search = new URLSearchParams({ folder, limit: '30' })
    if (query) search.set('q', query)
    if (scope.type === 'domain') search.set('domain', scope.value)
    if (scope.type === 'mailbox') search.set('mailbox', scope.value)
    if (cursor) search.set('cursor', cursor)
    return request<{
      messages: MessageSummary[]
      counts: MailCounts
      page: PageInfo
    }>(`/api/messages?${search}`)
  },
  message: (id: string) => request<{ message: MessageDetail }>(`/api/messages/${id}`),
  updateMessage: (
    id: string,
    input: { isRead?: boolean; isStarred?: boolean; folder?: 'inbox' | 'sent' | 'trash' },
  ) => request<{ ok: true }>(`/api/messages/${id}`, {
    method: 'PATCH',
    body: jsonBody(input),
  }),
  deleteMessage: (id: string) => request<{ ok: true }>(`/api/messages/${id}`, {
    method: 'DELETE',
  }),
  reply: (id: string, text: string, idempotencyKey: string) => (
    request<{ message: { id: string; status: string; providerId?: string } }>(
      `/api/messages/${id}/reply`,
      {
        method: 'POST',
        body: jsonBody({ text, idempotencyKey }),
      },
    )
  ),
  attachmentUrl: (messageId: string, attachmentId: string) => (
    `${API_ORIGIN}/api/messages/${messageId}/attachments/${attachmentId}`
  ),
  remoteImageUrl: (source: string) => (
    `${API_ORIGIN}/api/remote-images?url=${encodeURIComponent(source)}`
  ),
  rawUrl: (messageId: string) => `${API_ORIGIN}/api/messages/${messageId}/raw`,
}
import { t } from './i18n'
