import { afterEach, describe, expect, it, vi } from 'vitest'
import { deliverOutboundMessage, sendOutboundMessage } from './outbound-message'
import type { Env, SessionUser } from './types'

const user: SessionUser = {
  id: 'user-1',
  email: 'owner@example.com',
  displayName: 'Owner',
  role: 'user',
  mailboxLimit: 1,
  storageQuotaBytes: 1024 ** 3,
  storageUsedBytes: 0,
  canCreateMailboxes: false,
  canReply: true,
  temporaryExpiresAt: null,
}

function environment(firstResult: unknown = null) {
  const statements: Array<{ sql: string; bindings: unknown[] }> = []
  const put = vi.fn(async () => undefined)
  const send = vi.fn(async () => undefined)
  const prepare = (sql: string) => {
    const statement = {
      bindings: [] as unknown[],
      bind(...bindings: unknown[]) {
        this.bindings = bindings
        statements.push({ sql, bindings })
        return this
      },
      first: async () => firstResult,
      run: async () => ({ meta: { changes: 1 } }),
    }
    return statement
  }
  return {
    env: {
      DB: { prepare, batch: async () => [] },
      MAIL_BUCKET: { put },
      MAIL_QUEUE: { send },
      RESEND_API_KEY: 're_test',
      RESEND_FROM: 'OmniMail <reply@example.com>',
    } as unknown as Env,
    put,
    send,
    statements,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('outbound delivery', () => {
  it('stores and queues a new outgoing message before returning', async () => {
    const { env, put, send } = environment()
    const response = await sendOutboundMessage(env, user, {
      mailboxAddress: 'owner@example.com',
      recipients: ['friend@example.net'],
      subject: 'Hello',
      text: 'Message body',
      idempotencyKey: 'request_12345678',
      auditAction: 'message.send',
      auditDetail: { recipient: 'friend@example.net' },
    }, '127.0.0.1')

    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ message: { status: 'processing' } })
    expect(put).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'outbound',
      userId: user.id,
      auditAction: 'message.send',
    }))
  })

  it('sends a queued message idempotently and records the provider id', async () => {
    const { env, statements } = environment({
      id: 'out-1',
      status: 'processing',
      mailbox_address: 'owner@example.com',
      sender_name: 'Owner',
      recipients_json: '["friend@example.net"]',
      subject: 'Hello',
      body_key: 'bodies/out-1.json',
      in_reply_to: null,
      references_header: null,
      client_request_id: 'request_12345678',
    })
    env.MAIL_BUCKET.get = vi.fn(async () => new Response(JSON.stringify({
      text: 'Message body',
      html: '<p>Message body</p>',
    })) as unknown as R2ObjectBody)
    const resend = vi.fn(async () => Response.json({ id: 'resend-1' }))
    vi.stubGlobal('fetch', resend)

    await deliverOutboundMessage(env, {
      kind: 'outbound',
      messageId: 'out-1',
      userId: user.id,
      ip: '127.0.0.1',
      auditAction: 'message.send',
      auditDetail: { recipient: 'friend@example.net' },
    })

    expect(resend).toHaveBeenCalledOnce()
    const [url, request] = resend.mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
    expect(request?.headers).toMatchObject({
      'Idempotency-Key': 'omnimail-request_12345678',
      'User-Agent': 'OmniMail/0.1',
    })
    expect(statements.some(({ sql, bindings }) => (
      sql.includes("SET status = 'sent'") && bindings.includes('resend-1')
    ))).toBe(true)
    expect(statements.some(({ sql, bindings }) => (
      sql.includes('INSERT INTO audit_logs') && bindings.includes('message.send')
    ))).toBe(true)
  })
})
