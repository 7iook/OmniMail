import { describe, expect, it, vi } from 'vitest'
import {
  baseMailboxAddress,
  consumeEmailQueue,
  mailboxForRecipient,
  queueFailureStatus,
  receiveEmail,
  replySubject,
  textPreview,
  textToHtml,
} from './mail'
import type { Env } from './types'

vi.mock('./schema', () => ({ ensureSchema: vi.fn() }))

describe('mail helpers', () => {
  it('routes unassigned managed-domain mail to the owner only when enabled', async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = []
    const database = (enabled: boolean) => ({
      prepare(sql: string) {
        const entry = { sql, bindings: [] as unknown[] }
        statements.push(entry)
        const statement = {
          bind(...bindings: unknown[]) {
            entry.bindings = bindings
            return statement
          },
          first: async () => sql.includes('FROM users u') && enabled
            ? { id: 'owner-1' }
            : null,
          run: async () => ({ meta: { changes: 1 } }),
        }
        return statement
      },
    })
    const environment = (enabled: boolean) => ({
      DB: database(enabled),
      SUPER_ADMIN_EMAIL: 'owner@example.com',
    }) as unknown as Env

    await expect(
      mailboxForRecipient(environment(false), 'unknown@example.com'),
    ).resolves.toBeNull()
    await expect(
      mailboxForRecipient(environment(true), 'Unknown@Example.com'),
    ).resolves.toEqual({
      address: '__unassigned__@omnimail.invalid',
      userId: 'owner-1',
      deliveredTo: 'unknown@example.com',
    })
    const ownerLookup = statements.find(({ sql }) => sql.includes('FROM users u'))
    expect(ownerLookup?.sql).toContain("s.key = 'unassigned_mail_enabled'")
    expect(ownerLookup?.sql).toContain('FROM domains d')
  })

  it('stores unassigned mail with its original recipient', async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = []
    const db = {
      prepare(sql: string) {
        const entry = { sql, bindings: [] as unknown[] }
        statements.push(entry)
        const statement = {
          bind(...bindings: unknown[]) {
            entry.bindings = bindings
            return statement
          },
          first: async () => sql.includes('FROM users u') ? { id: 'owner-1' } : null,
          run: async () => ({ meta: { changes: 1 } }),
        }
        return statement
      },
    }
    const queue = { send: vi.fn().mockResolvedValue(undefined) }
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    }
    const message = {
      to: 'unknown@example.com',
      from: 'sender@example.net',
      rawSize: 20,
      raw: new Response('Subject: Test\r\n\r\nHello').body,
      headers: new Headers({ subject: 'Test', 'message-id': '<test@example.net>' }),
      setReject: vi.fn(),
    }

    await receiveEmail(message as unknown as ForwardableEmailMessage, {
      DB: db,
      MAIL_QUEUE: queue,
      MAIL_BUCKET: bucket,
      SUPER_ADMIN_EMAIL: 'owner@example.com',
    } as unknown as Env)
    const insert = statements.find(({ sql }) => sql.includes('INSERT OR IGNORE INTO messages'))

    expect(message.setReject).not.toHaveBeenCalled()
    expect(insert?.bindings[1]).toBe('__unassigned__@omnimail.invalid')
    expect(insert?.bindings[4]).toBe('unknown@example.com')
    expect(queue.send).toHaveBeenCalledTimes(1)
  })

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
