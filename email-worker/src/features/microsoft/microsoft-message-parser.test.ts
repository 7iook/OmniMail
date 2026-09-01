import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  parseMicrosoftGraphMetadata,
  parseMicrosoftMessage,
  parseMicrosoftMetadata,
} from './microsoft-message-parser'
import type { MicrosoftMessageMetadata } from './microsoft-types'

describe('Microsoft MIME parsing', () => {
  it('parses provider-neutral metadata without Gmail extensions', async () => {
    const headers = new TextEncoder().encode([
      'From: Example Sender <sender@example.com>',
      'To: User <user@outlook.com>',
      'Subject: Outlook message',
      'Date: Tue, 25 Aug 2026 10:00:00 +0800',
      'Message-ID: <outlook-message@example.com>',
      'Content-Type: multipart/mixed; boundary="test"',
      '',
      '',
    ].join('\r\n'))
    await expect(parseMicrosoftMetadata(
      '* 1 FETCH (UID 42 FLAGS (\\Seen) INTERNALDATE "25-Aug-2026 02:00:00 +0000" RFC822.SIZE 321 BODYSTRUCTURE ("TEXT" "PLAIN") {250}',
      headers,
    )).resolves.toMatchObject({
      remoteId: '42',
      uidValidity: null,
      internetMessageId: '<outlook-message@example.com>',
      senderAddress: 'sender@example.com',
      subject: 'Outlook message',
      sizeBytes: 321,
      isRead: true,
      hasAttachments: true,
    })
  })

  it('parses full MIME bodies and attachments on demand', async () => {
    const raw = new Uint8Array(await readFile('email-worker/test-fixtures/outlook-thread.eml'))
    const parsed = await parseMicrosoftMessage(raw, '42')
    expect(parsed.message.subject).toBeTruthy()
    expect(parsed.message.body || parsed.message.html).toBeTruthy()
    expect(Array.isArray(parsed.message.attachments)).toBe(true)
  })
})

const graphMessage = {
  id: 'AAMkAGI2THVSAAA=',
  internetMessageId: '<shared-message@example.com>',
  subject: 'Outlook message',
  bodyPreview: 'First lines of the body.',
  isRead: true,
  hasAttachments: true,
  receivedDateTime: '2026-08-25T02:00:00Z',
  sentDateTime: '2026-08-25T01:59:00Z',
  from: { emailAddress: { name: 'Example Sender', address: 'sender@example.com' } },
  toRecipients: [{ emailAddress: { name: 'User', address: 'user@outlook.com' } }],
  ccRecipients: [{ emailAddress: { name: 'Watcher', address: 'watcher@example.com' } }],
}

describe('Microsoft Graph metadata mapping', () => {
  it('maps a Graph message into provider-neutral metadata', () => {
    expect(parseMicrosoftGraphMetadata(graphMessage)).toEqual({
      remoteId: 'AAMkAGI2THVSAAA=',
      uidValidity: null,
      internetMessageId: '<shared-message@example.com>',
      senderName: 'Example Sender',
      senderAddress: 'sender@example.com',
      recipients: ['User <user@outlook.com>'],
      cc: ['Watcher <watcher@example.com>'],
      subject: 'Outlook message',
      preview: 'First lines of the body.',
      receivedAt: 1_787_623_200,
      sentAt: 1_787_623_140,
      sizeBytes: 0,
      flags: [],
      isRead: true,
      isStarred: false,
      hasAttachments: true,
    })
  })

  it('maps uidValidity to null because Graph has no UIDVALIDITY concept', () => {
    expect(parseMicrosoftGraphMetadata(graphMessage).uidValidity).toBeNull()
  })

  it('keeps the opaque Graph id verbatim as the transport-scoped locator', () => {
    const id = `AAMkAG${'i'.repeat(130)}=`
    expect(parseMicrosoftGraphMetadata({ ...graphMessage, id }).remoteId).toBe(id)
  })

  it('rejects a Graph message without an id because the row could never be located again', () => {
    expect(() => parseMicrosoftGraphMetadata({ ...graphMessage, id: '' }))
      .toThrow(/id/i)
  })

  it('keeps the sender display name Graph provides instead of reducing it to a bare address', () => {
    const mapped = parseMicrosoftGraphMetadata(graphMessage)
    expect(mapped.senderName).toBe('Example Sender')
    expect(mapped.senderAddress).toBe('sender@example.com')
  })

  it('falls back to the sender mailbox when Graph reports no from mailbox', () => {
    const mapped = parseMicrosoftGraphMetadata({
      ...graphMessage,
      from: null,
      sender: { emailAddress: { name: 'Shared Mailbox', address: 'shared@example.com' } },
    })
    expect(mapped.senderName).toBe('Shared Mailbox')
    expect(mapped.senderAddress).toBe('shared@example.com')
  })

  it('drops recipients Graph returns without an address, matching the IMAP path', () => {
    const mapped = parseMicrosoftGraphMetadata({
      ...graphMessage,
      toRecipients: [
        { emailAddress: { name: 'Nameless' } },
        { emailAddress: { address: 'plain@example.com' } },
      ],
    })
    expect(mapped.recipients).toEqual(['plain@example.com'])
  })

  it('keeps the read state Graph reports instead of defaulting it to false', () => {
    expect(parseMicrosoftGraphMetadata({ ...graphMessage, isRead: true }).isRead).toBe(true)
    expect(parseMicrosoftGraphMetadata({ ...graphMessage, isRead: false }).isRead).toBe(false)
  })

  it('keeps the attachment indicator Graph reports instead of defaulting it to false', () => {
    expect(parseMicrosoftGraphMetadata({ ...graphMessage, hasAttachments: true }).hasAttachments)
      .toBe(true)
    expect(parseMicrosoftGraphMetadata({ ...graphMessage, hasAttachments: false }).hasAttachments)
      .toBe(false)
  })

  it('maps a followup flag to the starred state IMAP expresses as the \\Flagged flag', () => {
    const starred = parseMicrosoftGraphMetadata({
      ...graphMessage,
      flag: { flagStatus: 'flagged' },
    })
    const notStarred = parseMicrosoftGraphMetadata({
      ...graphMessage,
      flag: { flagStatus: 'notFlagged' },
    })
    expect(starred.isStarred).toBe(true)
    expect(notStarred.isStarred).toBe(false)
  })

  it('emits no IMAP flag tokens for a transport that has none', () => {
    expect(parseMicrosoftGraphMetadata({ ...graphMessage, flag: { flagStatus: 'flagged' } }).flags)
      .toEqual([])
  })

  it('maps an absent Message-ID to an empty string without inventing one', () => {
    const withoutId = parseMicrosoftGraphMetadata({ ...graphMessage, internetMessageId: undefined })
    expect(withoutId.internetMessageId).toBe('')
    expect(parseMicrosoftGraphMetadata({ ...graphMessage, internetMessageId: '   ' })
      .internetMessageId).toBe('')
    // The locator must still work, so an empty identity cannot block the mapping.
    expect(withoutId.remoteId).toBe('AAMkAGI2THVSAAA=')
  })

  it('brackets a bare Message-ID so both transports produce the same dedupe key', () => {
    expect(parseMicrosoftGraphMetadata({
      ...graphMessage,
      internetMessageId: 'shared-message@example.com',
    }).internetMessageId).toBe('<shared-message@example.com>')
  })

  it('reads message size from the extended property Graph exposes for it', () => {
    // The v1.0 message resource has no `size`; size arrives as PidTagMessageSize,
    // whose id Graph echoes back lower-cased and without the leading zero.
    expect(parseMicrosoftGraphMetadata({
      ...graphMessage,
      singleValueExtendedProperties: [{ id: 'Integer 0xe08', value: '100265' }],
    }).sizeBytes).toBe(100_265)
    expect(parseMicrosoftGraphMetadata(graphMessage).sizeBytes).toBe(0)
  })

  it('bounds the Graph body preview to one line so the list row cannot be broken by it', () => {
    const mapped = parseMicrosoftGraphMetadata({
      ...graphMessage,
      bodyPreview: `line one\r\n\tline two${' '.repeat(20)}${'x'.repeat(400)}`,
    })
    expect(mapped.preview.startsWith('line one line two x')).toBe(true)
    expect(mapped.preview).not.toMatch(/[\r\n\t]/)
    expect(mapped.preview.length).toBeLessThanOrEqual(180)
  })

  it('falls back to the sent time when Graph reports no received time', () => {
    const mapped = parseMicrosoftGraphMetadata({ ...graphMessage, receivedDateTime: undefined })
    expect(mapped.receivedAt).toBe(1_787_623_140)
  })
})

describe('Microsoft transport convergence', () => {
  it('yields the same sender, subject, date, read state and identity over either transport', async () => {
    const headers = new TextEncoder().encode([
      'From: Example Sender <sender@example.com>',
      'To: User <user@outlook.com>',
      'Cc: Watcher <watcher@example.com>',
      'Subject: Outlook message',
      'Date: Tue, 25 Aug 2026 10:00:00 +0800',
      'Message-ID: <shared-message@example.com>',
      'Content-Type: text/plain; charset="utf-8"',
      '',
      '',
    ].join('\r\n'))
    const viaImap = await parseMicrosoftMetadata(
      '* 1 FETCH (UID 42 FLAGS (\\Seen) INTERNALDATE "25-Aug-2026 02:00:00 +0000" RFC822.SIZE 321 BODYSTRUCTURE ("TEXT" "PLAIN") {250}',
      headers,
    )
    const viaGraph = parseMicrosoftGraphMetadata({
      ...graphMessage,
      hasAttachments: false,
      // Same instant as the RFC2822 Date header above (10:00 +0800). IMAP reads
      // sentAt from that header, Graph from sentDateTime — for one mail they agree.
      sentDateTime: '2026-08-25T02:00:00Z',
    })

    const converged = ({
      internetMessageId, senderName, senderAddress, recipients, cc,
      subject, receivedAt, sentAt, isRead, isStarred, hasAttachments, uidValidity,
    }: MicrosoftMessageMetadata) => ({
      internetMessageId,
      senderName,
      senderAddress,
      recipients,
      cc,
      subject,
      receivedAt,
      sentAt,
      isRead,
      isStarred,
      hasAttachments,
      uidValidity,
    })

    expect(converged(viaGraph)).toEqual(converged(viaImap))
    // Only the transport-scoped locator may differ: IMAP UID vs opaque Graph id.
    expect(viaImap.remoteId).toBe('42')
    expect(viaGraph.remoteId).toBe('AAMkAGI2THVSAAA=')
  })
})
