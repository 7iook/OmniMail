import { describe, expect, it } from 'vitest'
import {
  decodeModifiedUtf7,
  parseMicrosoftImapUid,
  parseMicrosoftList,
  parseMicrosoftSearchUids,
} from './microsoft-imap-values'

describe('Microsoft IMAP UID parsing', () => {
  it('accepts a canonical UID', () => {
    expect(parseMicrosoftImapUid('7')).toBe(7)
    expect(parseMicrosoftImapUid('4294967295')).toBe(4_294_967_295)
  })

  it('rejects values Number() would silently accept', () => {
    // Each of these would otherwise address the wrong message or send UID 0.
    for (const value of ['0', '-1', '1e3', '7.0', ' 7', '7 ', '', '07', 'AAMkOpaque']) {
      expect(parseMicrosoftImapUid(value)).toBeNull()
    }
  })

  it('rejects a UID beyond the 32-bit range', () => {
    expect(parseMicrosoftImapUid('4294967296')).toBeNull()
  })
})

describe('Microsoft IMAP parsing', () => {
  it('parses LIST flags, quoted paths, special-use, and modified UTF-7 names', () => {
    expect(parseMicrosoftList([
      '* LIST (\\HasNoChildren \\Inbox) "/" "INBOX"',
      '* LIST (\\HasNoChildren \\Sent) "/" "Sent Items"',
      '* LIST (\\HasNoChildren) "/" "&ZeVnLIqe-"',
      'A0002 OK LIST completed.',
    ])).toEqual([
      expect.objectContaining({ path: 'INBOX', displayName: 'INBOX', specialUse: '\\Inbox' }),
      expect.objectContaining({ path: 'Sent Items', specialUse: '\\Sent' }),
      expect.objectContaining({ path: '&ZeVnLIqe-', displayName: '日本語' }),
    ])
    expect(decodeModifiedUtf7('A&-B')).toBe('A&B')
  })

  it('normalizes and sorts unique positive search UIDs', () => {
    expect(parseMicrosoftSearchUids(['* SEARCH 9 2 9 nope 4', 'A0003 OK']))
      .toEqual([2, 4, 9])
  })

  it('ignores malformed LIST rows instead of treating them as selectable folders', () => {
    expect(parseMicrosoftList([
      '* LIST (\\HasNoChildren) "/" "bad\\r\\nfolder"',
      '* STATUS INBOX (MESSAGES 1)',
    ])).toEqual([])
  })
})
