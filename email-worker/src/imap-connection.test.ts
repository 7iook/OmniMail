import { describe, expect, it } from 'vitest'
import { quoteImapValue } from './imap-values'

describe('shared IMAP command values', () => {
  it('quotes backslashes and double quotes', () => {
    expect(quoteImapValue('name\\"value')).toBe('"name\\\\\\"value"')
  })

  it('rejects CRLF and null injection', () => {
    expect(() => quoteImapValue('name\r\nA0001 LOGOUT')).toThrow('无效字符')
    expect(() => quoteImapValue('name\0value')).toThrow('无效字符')
  })
})
