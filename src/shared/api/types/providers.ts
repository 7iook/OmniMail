export type ICloudHost = 'icloud.com' | 'icloud.com.cn'

export interface ICloudAccount {
  id: string
  name: string
  realEmail: string
  icloudEmail: string
  host: ICloudHost
  status: 'active' | 'pending' | 'error'
  aliasTotal: number
  aliasActive: number
  lastValidated: string
  lastError: string
  createdAt: string
  hasCookies: boolean
  hasAppPassword: boolean
}

export interface ICloudAlias {
  email: string
  anonymousId: string
  label: string
  active: boolean
  createdAt?: string
}

export interface ICloudMessage {
  id: string
  from: string
  to: string
  subject: string
  date: string
  preview: string
  body: string
  html: string
  isRead?: boolean
}

export interface LinuxDoMailAccount {
  id: string
  username: string
  status: 'active' | 'error'
  lastValidated: string
  lastError: string
  createdAt: string
  hasPassword: boolean
}

export interface LinuxDoMailMessage extends ICloudMessage {
  direction?: 'incoming' | 'outgoing'
  status?: 'processing' | 'ready' | 'failed' | 'sent'
  deliveryStatus?: string | null
  processingError?: string
}

export interface GmailAccount {
  id: string
  name: string
  email: string
  status: 'active' | 'syncing' | 'credential_error' | 'error'
  lastSyncedAt: number | null
  nextSyncAt: number
  lastErrorCode: string
  lastErrorAt: number | null
  createdAt: number
  hasAppPassword: true
}

export interface GmailMessageSummary {
  id: string
  account: Pick<GmailAccount, 'id' | 'name' | 'email' | 'status'>
  senderName: string
  senderAddress: string
  recipients: string[]
  cc: string[]
  subject: string
  preview: string
  date: number
  sizeBytes: number
  isRead: boolean
  isStarred: boolean
  hasAttachments: boolean
}

export interface GmailAttachment {
  partId: string
  filename: string
  contentType: string
  size: number
  contentId: string | null
  disposition: string
}

export interface GmailMessageDetail extends Omit<GmailMessageSummary, 'cc' | 'date'> {
  from: string
  to: string
  cc: string
  date: string
  body: string
  html: string
  attachments: GmailAttachment[]
}

