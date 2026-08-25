import { connect } from 'cloudflare:sockets'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env, SessionUser } from '../../app/types'
import { importMicrosoftAccounts, validateMicrosoftPassword } from './microsoft-account-api'

vi.mock('cloudflare:sockets', () => ({ connect: vi.fn() }))

const user = {
  id: 'user-1', email: 'user@example.com', displayName: 'User', role: 'user',
  mailboxLimit: 1, storageQuotaBytes: 1024, storageUsedBytes: 0,
  canCreateMailboxes: false, canReply: false, canTranslate: false,
  temporaryExpiresAt: null,
} satisfies SessionUser

function socketScript(lines: string[]) {
  const writes: Uint8Array[] = []
  return {
    socket: {
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`${lines.join('\r\n')}\r\n`))
        },
      }),
      writable: new WritableStream<Uint8Array>({ write(value) { writes.push(value.slice()) } }),
      opened: Promise.resolve({ remoteAddress: null, localAddress: null }),
      closed: new Promise<void>(() => undefined),
      close: vi.fn(async () => undefined),
    } as unknown as Socket,
    commands: () => new TextDecoder().decode(Uint8Array.from(
      writes.flatMap((value) => [...value]),
    )),
  }
}

describe('Microsoft one-time password validation', () => {
  beforeEach(() => vi.mocked(connect).mockReset())

  it('validates LOGIN without inserting an account or returning the password', async () => {
    const fixture = socketScript([
      '* OK Microsoft ready',
      '* CAPABILITY IMAP4rev1',
      'A0001 OK CAPABILITY',
      'A0002 OK LOGIN completed',
      '* LIST (\\Inbox) "/" "INBOX"',
      'A0003 OK LIST completed',
      '* 1 EXISTS',
      '* OK [UIDVALIDITY 42] valid',
      'A0004 OK EXAMINE completed',
      '* BYE',
      'A0005 OK LOGOUT',
    ])
    vi.mocked(connect).mockReturnValue(fixture.socket)
    const statements: string[] = []
    const env = {
      MICROSOFT_CREDENTIALS_KEY: 'microsoft-key-that-is-longer-than-thirty-two-bytes',
      DB: { prepare(sql: string) {
        statements.push(sql)
        return { bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) }
      } },
    } as unknown as Env
    const response = await validateMicrosoftPassword(env, user, new Request(
      'https://mail.example.com/api/microsoft/accounts/validate-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'user@outlook.com', authMode: 'password', password: 'one-time-secret',
        }),
      },
    ), '192.0.2.1')
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(JSON.parse(body)).toEqual({ ok: true, persisted: false })
    expect(body).not.toContain('one-time-secret')
    expect(statements.some((sql) => /INSERT INTO microsoft_imap_accounts/i.test(sql))).toBe(false)
    expect(fixture.commands()).toContain('LOGIN "user@outlook.com" "one-time-secret"')
  })

  it('encrypts a confirmed password before storing it after successful LOGIN', async () => {
    const fixture = socketScript([
      '* OK Microsoft ready',
      '* CAPABILITY IMAP4rev1',
      'A0001 OK CAPABILITY',
      'A0002 OK LOGIN completed',
      '* LIST (\\Inbox) "/" "INBOX"',
      'A0003 OK LIST completed',
      '* 1 EXISTS',
      '* OK [UIDVALIDITY 42] valid',
      'A0004 OK EXAMINE completed',
      '* BYE',
      'A0005 OK LOGOUT',
    ])
    vi.mocked(connect).mockReturnValue(fixture.socket)
    const calls: Array<{ sql: string; bindings: unknown[] }> = []
    const db = {
      prepare(sql: string) {
        return { bind: (...bindings: unknown[]) => {
          calls.push({ sql, bindings })
          return {
            all: async () => ({ results: [] }),
            run: async () => ({ meta: { changes: 1 } }),
          }
        } }
      },
      batch: async () => [],
    }
    const env = {
      MICROSOFT_CREDENTIALS_KEY: 'microsoft-key-that-is-longer-than-thirty-two-bytes',
      DB: db,
      MAIL_QUEUE: { send: vi.fn(async () => undefined) },
    } as unknown as Env
    const password = 'confirmed-password-secret'
    const response = await importMicrosoftAccounts(env, user, new Request(
      'https://mail.example.com/api/microsoft/accounts/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accounts: [{
          email: 'user@outlook.com', authMode: 'password', password,
          persistPasswordConfirmed: true,
        }] }),
      },
    ), '192.0.2.1')
    const text = await response.text()
    const insert = calls.find(({ sql }) => /INSERT INTO microsoft_imap_accounts/i.test(sql))
    expect(response.status).toBe(201)
    expect(text).not.toContain(password)
    expect(insert?.bindings).not.toContain(password)
    expect(insert?.bindings[11]).toEqual(expect.stringMatching(/^v1\./))
    expect(fixture.commands()).toContain(`LOGIN "user@outlook.com" "${password}"`)
  })
})
