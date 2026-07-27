import { describe, expect, it } from 'vitest'
import {
  baseMailboxAddress,
  replySubject,
  textPreview,
  textToHtml,
} from './mail'

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
})

