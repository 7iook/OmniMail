import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendOutboundMessage } from './outbound-message'
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

function environment() {
  const statements: Array<{ sql: string; bindings: unknown[] }> = []
  const put = vi.fn(async () => undefined)
  const prepare = (sql: string) => {
    const statement = {
      sql,
      bindings: [] as unknown[],
      bind(...bindings: unknown[]) {
        this.bindings = bindings
        statements.push({ sql, bindings })
        return this
      },
      first: async () => null,
      run: async () => ({ meta: { changes: 1 } }),
    }
    return statement
  }
  return {
    env: {
      DB: { prepare },
      MAIL_BUCKET: { put },
      RESEND_API_KEY: 're_test',
      RESEND_FROM: 'OmniMail <reply@example.com>',
    } as unknown as Env,
    put,
    statements,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('sendOutboundMessage', () => {
  it('stores, sends, and audits a new outgoing message', async () => {
    const { env, put, statements } = environment()
    const resend = vi.fn(async () => Response.json({ id: 'resend-1' }))
    vi.stubGlobal('fetch', resend)

    const response = await sendOutboundMessage(env, user, {
      mailboxAddress: 'owner@example.com',
      recipients: ['friend@example.net'],
      subject: 'Hello',
      text: 'Message body',
      idempotencyKey: 'request_12345678',
      auditAction: 'message.send',
      auditDetail: { recipient: 'friend@example.net' },
    }, '127.0.0.1')

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      message: { status: 'sent', providerId: 'resend-1' },
    })
    expect(put).toHaveBeenCalledOnce()
    expect(resend).toHaveBeenCalledOnce()
    const [url, request] = resend.mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
    expect(request?.headers).toMatchObject({
      'Idempotency-Key': 'omnimail-request_12345678',
      'User-Agent': 'OmniMail/0.1',
    })
    expect(JSON.parse(String(request?.body))).toMatchObject({
      from: 'OmniMail <reply@example.com>',
      to: ['friend@example.net'],
      reply_to: 'owner@example.com',
      subject: 'Hello',
      text: 'Message body',
    })
    expect(statements.some(({ sql, bindings }) => (
      sql.includes('INSERT INTO audit_logs') && bindings.includes('message.send')
    ))).toBe(true)
  })
})
