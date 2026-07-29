import { describe, expect, it, vi } from 'vitest'
import { getMessageDetail } from './message-detail-api'
import type { Env, MessageRow, SessionUser } from './types'

const user = {
  id: 'user-1',
} as SessionUser

const message = {
  id: 'message-1',
  mailbox_address: 'inbox@example.com',
  direction: 'incoming',
  status: 'ready',
  folder: 'inbox',
  message_id: '<long-message-id@example.com>',
  in_reply_to: null,
  references_header: null,
  sender_name: 'Sender',
  sender_address: 'sender@example.net',
  delivered_to: null,
  recipients_json: '["inbox@example.com"]',
  cc_json: '[]',
  subject: 'Test message',
  preview: 'Preview',
  received_at: 100,
  sent_at: null,
  raw_key: 'raw/message-1.eml',
  body_key: null,
  size: 1024,
  quota_bytes: 1024,
  attachment_count: 0,
  has_html: 0,
  is_read: 0,
  is_starred: 0,
  trashed_at: null,
  purge_after: null,
  processing_error: null,
  processing_attempts: 0,
  last_failed_at: null,
  client_request_id: null,
  provider_id: null,
  delivery_status: null,
  provider_event_at: null,
  created_at: 100,
  updated_at: 100,
} satisfies MessageRow

describe('message details', () => {
  it('returns the message when the optional thread lookup fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const db = {
      prepare(sql: string) {
        const statement = {
          bind: () => statement,
          first: async () => message,
          all: async () => {
            if (sql.includes('FROM attachments')) return { results: [] }
            throw new Error('LIKE or GLOB pattern too complex')
          },
        }
        return statement
      },
    }

    const response = await getMessageDetail(
      { DB: db } as unknown as Env,
      user,
      message.id,
    )
    const result = await response.json() as {
      message: { id: string }
      thread: Array<{ id: string }>
    }

    expect(response.status).toBe(200)
    expect(result.message.id).toBe(message.id)
    expect(result.thread).toEqual([expect.objectContaining({ id: message.id })])
    expect(log).toHaveBeenCalledWith(
      'Unable to load message thread',
      { messageId: message.id },
      expect.any(Error),
    )
    log.mockRestore()
  })
})
