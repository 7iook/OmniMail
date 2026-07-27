export interface ParseJob {
  messageId: string
}

export interface Env {
  DB: D1Database
  MAIL_BUCKET: R2Bucket
  MAIL_QUEUE: Queue<ParseJob>
  ASSETS: Fetcher
  APP_NAME?: string
  APP_ORIGINS?: string
  SUPER_ADMIN_EMAIL?: string
  COOKIE_SECURE?: string
  SETUP_TOKEN?: string
  RESEND_API_KEY?: string
  RESEND_FROM?: string
  TURNSTILE_SITE_KEY?: string
  TURNSTILE_SECRET_KEY?: string
}

export type UserRole = 'super_admin' | 'admin' | 'user' | 'temporary'

export interface UserRow {
  id: string
  email: string
  display_name: string
  password_hash: string
  role: UserRole
  status: 'active' | 'disabled'
  mailbox_limit: number
  can_create_mailboxes: number
  can_reply: number
  temporary_expires_at: number | null
  deleted_at: number | null
  created_at: number
}

export interface SessionUser {
  id: string
  email: string
  displayName: string
  role: UserRole
  mailboxLimit: number
  canCreateMailboxes: boolean
  canReply: boolean
  temporaryExpiresAt: number | null
}

export interface MessageRow {
  id: string
  mailbox_address: string
  direction: 'incoming' | 'outgoing'
  status: 'processing' | 'ready' | 'failed' | 'sent'
  folder: 'inbox' | 'sent' | 'trash'
  message_id: string | null
  in_reply_to: string | null
  references_header: string | null
  sender_name: string | null
  sender_address: string
  recipients_json: string
  cc_json: string
  subject: string
  preview: string
  received_at: number | null
  sent_at: number | null
  raw_key: string | null
  body_key: string | null
  size: number
  attachment_count: number
  has_html: number
  is_read: number
  is_starred: number
  processing_error: string | null
  created_at: number
  updated_at: number
}

export interface AttachmentRow {
  id: string
  message_id: string
  filename: string
  content_type: string
  size: number
  r2_key: string
  content_id: string | null
  disposition: string
}

export interface StoredBody {
  text: string
  html: string
}
