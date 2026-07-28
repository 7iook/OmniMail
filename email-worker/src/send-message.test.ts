import { describe, expect, it } from 'vitest'
import { validateNewMessage, type NewMessageInput } from './send-message'

const validInput: NewMessageInput = {
  mailboxAddress: ' Owner@Example.COM ',
  to: ' Friend@Example.NET ',
  subject: ' Hello ',
  text: ' Message body ',
  idempotencyKey: 'request_12345678',
}

describe('validateNewMessage', () => {
  it('normalizes addresses and trims user-authored content', () => {
    expect(validateNewMessage(validInput)).toEqual({
      value: {
        mailboxAddress: 'owner@example.com',
        to: 'friend@example.net',
        subject: 'Hello',
        text: 'Message body',
        idempotencyKey: 'request_12345678',
      },
    })
  })

  it.each([
    [{ ...validInput, mailboxAddress: 'invalid' }, '发件邮箱格式无效。'],
    [{ ...validInput, to: 'invalid' }, '请输入有效的收件邮箱地址。'],
    [{ ...validInput, subject: ' ' }, '邮件主题需要在 1–500 个字符之间。'],
    [{ ...validInput, subject: 'Hello\r\nBcc: hidden@example.com' }, '邮件主题需要在 1–500 个字符之间。'],
    [{ ...validInput, subject: 'x'.repeat(501) }, '邮件主题需要在 1–500 个字符之间。'],
    [{ ...validInput, text: ' ' }, '邮件正文需要在 1–50,000 个字符之间。'],
    [{ ...validInput, text: 'x'.repeat(50_001) }, '邮件正文需要在 1–50,000 个字符之间。'],
    [{ ...validInput, idempotencyKey: 'short' }, '无效的请求标识。'],
  ] satisfies Array<[NewMessageInput, string]>)('rejects invalid input', (input, error) => {
    expect(validateNewMessage(input)).toEqual({ error })
  })
})
