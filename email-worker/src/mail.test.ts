import { describe, expect, it, vi } from 'vitest'
import {
  baseMailboxAddress,
  consumeEmailQueue,
  queueFailureStatus,
  replySubject,
  textPreview,
  textToHtml,
} from './mail'

vi.mock('./schema', () => ({ ensureSchema: vi.fn() }))

describe('mail helpers', () => {
  it('resolves plus addressing to the base mailbox', () => {
    expect(baseMailboxAddress('Owner+news@Example.com')).toBe('owner@example.com')
    expect(baseMailboxAddress('owner@example.com')).toBe('owner@example.com')
  })

  it('adds a reply prefix only once', () => {
    expect(replySubject('Hello')).toBe('Re: Hello')
    expect(replySubject('RE: Hello')).toBe('RE: Hello')
    expect(replySubject('  ')).toBe('Re: 无主题')
  })

  it('creates a compact, bounded preview', () => {
    expect(textPreview('hello\n\n  world')).toBe('hello world')
    expect(textPreview('123456', 5)).toBe('1234…')
  })

  it('escapes reply text before creating HTML', () => {
    expect(textToHtml('<script>alert(1)</script>\nnext'))
      .toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;<br>next</p>')
  })

  it('retries exhausted parse failures so Queue can move them to the DLQ', async () => {
    const message = {
      body: { messageId: 'message-1' },
      attempts: 3,
      ack: vi.fn(),
      retry: vi.fn(),
    }
    const db = {
      prepare: (sql: string) => ({
        bind() {
          return this
        },
        first: async () => sql.includes('SELECT * FROM messages')
          ? { status: 'queued', raw_key: null }
          : null,
        run: async () => ({ success: true }),
      }),
    }

    await consumeEmailQueue(
      { messages: [message] } as unknown as MessageBatch<{ messageId: string }>,
      { DB: db } as unknown as Parameters<typeof consumeEmailQueue>[1],
    )

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
    expect(message.ack).not.toHaveBeenCalled()
  })

  it('only exposes a failure after automatic Queue retries are exhausted', () => {
    expect(queueFailureStatus(1)).toBe('processing')
    expect(queueFailureStatus(2)).toBe('processing')
    expect(queueFailureStatus(3)).toBe('failed')
  })
})
