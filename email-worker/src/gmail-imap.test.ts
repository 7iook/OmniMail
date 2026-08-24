import { connect } from 'cloudflare:sockets'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GmailImapClient } from './gmail-imap'

vi.mock('cloudflare:sockets', () => ({ connect: vi.fn() }))

function scriptedSocket(replies: Uint8Array) {
  const writes: Uint8Array[] = []
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(replies)
    },
  })
  const writable = new WritableStream<Uint8Array>({
    write(value) { writes.push(value.slice()) },
  })
  return {
    socket: {
      readable,
      writable,
      opened: Promise.resolve({ remoteAddress: null, localAddress: null }),
      closed: new Promise<void>(() => undefined),
      close: vi.fn(async () => undefined),
    } as unknown as Socket,
    commands: () => new TextDecoder().decode(Uint8Array.from(
      writes.flatMap((value) => [...value]),
    )),
  }
}

function responseWithMessage(raw: string): Uint8Array {
  const encoder = new TextEncoder()
  const prefix = encoder.encode([
    '* OK Gmail ready',
    '* CAPABILITY IMAP4rev1 ID X-GM-EXT-1',
    'A0001 OK CAPABILITY',
    'A0002 OK LOGIN',
    '* CAPABILITY IMAP4rev1 ID X-GM-EXT-1',
    'A0003 OK CAPABILITY',
    '* ID ("name" "GImap")',
    'A0004 OK ID',
    '* 1 EXISTS',
    '* OK [UIDVALIDITY 123] UIDs valid',
    'A0005 OK EXAMINE',
    `* 1 FETCH (BODY[] {${encoder.encode(raw).byteLength}}`,
    '',
  ].join('\r\n'))
  const suffix = encoder.encode(' UID 42)\r\nA0006 OK FETCH\r\n* BYE\r\nA0007 OK LOGOUT\r\n')
  const bytes = new Uint8Array(prefix.byteLength + encoder.encode(raw).byteLength + suffix.byteLength)
  bytes.set(prefix)
  bytes.set(encoder.encode(raw), prefix.byteLength)
  bytes.set(suffix, prefix.byteLength + encoder.encode(raw).byteLength)
  return bytes
}

describe('Gmail IMAP read-only command boundary', () => {
  beforeEach(() => vi.mocked(connect).mockReset())

  it('reads bodies when Gmail returns UID after the literal and keeps commands read-only', async () => {
    const raw = [
      'From: Sender <sender@example.com>',
      'To: user@gmail.com',
      'Subject: Read only',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Body',
    ].join('\r\n')
    const fixture = scriptedSocket(responseWithMessage(raw))
    vi.mocked(connect).mockReturnValue(fixture.socket)
    const client = new GmailImapClient('user@gmail.com', 'abcdefghijklmnop')

    await client.open()
    await expect(client.getMessage(42)).resolves.toMatchObject({
      message: { subject: 'Read only', body: 'Body' },
    })
    await client.close()

    const commands = fixture.commands()
    expect(commands).toContain('EXAMINE INBOX')
    expect(commands).toContain('UID FETCH 42 (UID BODY.PEEK[])')
    expect(commands).not.toMatch(/\bSELECT\b|\bSTORE\b|\bMOVE\b|\bEXPUNGE\b|\bAPPEND\b/)
  })
})
