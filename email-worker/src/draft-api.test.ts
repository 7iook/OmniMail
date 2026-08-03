import { describe, expect, it, vi } from 'vitest'
import {
  MAX_DRAFT_ATTACHMENT_BYTES,
  normalizeDraftFilename,
  pruneDraftsForLimits,
  sendDraft,
  validateDraftInput,
} from './draft-api'
import type { Env, SessionUser } from './types'

describe('mail draft validation', () => {
  it('allows an incomplete draft while normalizing addresses', () => {
    expect(validateDraftInput({
      mailboxAddress: ' Owner@Example.COM ',
      to: '',
      subject: ' Partial ',
      text: ' Body ',
    })).toEqual({
      value: {
        mailboxAddress: 'owner@example.com',
        to: '',
        subject: 'Partial',
        text: 'Body',
      },
    })
  })

  it('keeps partial recipients but rejects header injection', () => {
    expect(validateDraftInput({
      mailboxAddress: 'owner@example.com',
      to: 'friend@',
      subject: 'Hello',
      text: '',
    })).toMatchObject({ value: { to: 'friend@' } })
    expect(validateDraftInput({
      mailboxAddress: 'owner@example.com',
      to: 'friend@example.com\r\nBcc: hidden@example.com',
      subject: 'Hello\r\nBcc: hidden@example.com',
      text: '',
    })).toEqual({ error: '草稿收件人不能超过 254 个字符或包含换行。' })
  })

  it('sanitizes attachment names and exposes the upload limit', () => {
    expect(normalizeDraftFilename(' report\r\n.pdf ')).toBe('report.pdf')
    expect(MAX_DRAFT_ATTACHMENT_BYTES).toBe(5 * 1024 * 1024)
  })

  it('requeues a failed idempotent draft send after the draft was transferred', async () => {
    const send = vi.fn(async () => undefined)
    const existing = {
      id: 'out-1',
      status: 'failed',
      provider_id: null,
      body_key: 'bodies/out-1.json',
      mailbox_address: 'owner@example.com',
    }
    const statement = {
      bind: vi.fn(function bind() { return this }),
      first: vi.fn(async () => existing),
      run: vi.fn(async () => ({ meta: { changes: 1 } })),
    }
    const env = {
      DB: { prepare: vi.fn(() => statement) },
      MAIL_QUEUE: { send },
      RESEND_DOMAIN_CONFIGS: JSON.stringify({
        'example.com': { apiKey: 're_test' },
      }),
    } as unknown as Env
    const user = {
      id: 'user-1',
      role: 'user',
      canReply: true,
    } as SessionUser
    const response = await sendDraft(
      env,
      user,
      'draft-1',
      new Request('https://mail.example/api/drafts/draft-1/send', {
        method: 'POST',
        body: JSON.stringify({ idempotencyKey: 'request_retry' }),
      }),
      '127.0.0.1',
    )

    expect(response.status).toBe(202)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'outbound',
      messageId: 'out-1',
      userId: 'user-1',
    }))
  })

  it('prunes excess drafts in bounded database batches', async () => {
    const excess = Array.from({ length: 205 }, (_, index) => ({ id: `draft-${index}` }))
    const deleteBatchSizes: number[] = []
    const database = {
      prepare(sql: string) {
        let bindings: unknown[] = []
        return {
          bind(...values: unknown[]) { bindings = values; return this },
          async all() {
            if (sql.includes('ROW_NUMBER()')) return { results: excess }
            if (sql.includes('FROM mail_draft_attachments')) return { results: [] }
            return { results: [] }
          },
          sql,
          get bindings() { return bindings },
        }
      },
      async batch(statements: Array<{ sql: string; bindings: unknown[] }>) {
        const deletion = statements.find((statement) => statement.sql.includes('DELETE FROM mail_drafts'))
        if (deletion) deleteBatchSizes.push(deletion.bindings.length)
        return []
      },
    }
    const env = {
      DB: database,
      MAIL_BUCKET: { delete: vi.fn(async () => undefined) },
    } as unknown as Env

    await pruneDraftsForLimits(env, {
      superAdmin: 8,
      admin: 7,
      user: 5,
      temporary: 3,
    })

    expect(deleteBatchSizes).toEqual([100, 100, 5])
  })
})
