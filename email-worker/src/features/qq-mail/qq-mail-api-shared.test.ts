import { describe, expect, it } from 'vitest'
import {
  qqMailAuthorizationCodeField,
  qqMailEmailField,
  qqMailNameField,
} from './qq-mail-api-shared'

describe('QQ Mail input validation', () => {
  it('accepts only personal qq.com addresses', () => {
    expect(qqMailEmailField(' 123456789@QQ.COM ')).toBe('123456789@qq.com')
    expect(() => qqMailEmailField('user@foxmail.com')).toThrow('@qq.com')
    expect(() => qqMailEmailField('user@exmail.qq.com')).toThrow('@qq.com')
    expect(() => qqMailEmailField('qq-user')).toThrow('@qq.com')
  })

  it('keeps the authorization code opaque while rejecting control characters and oversized input', () => {
    expect(qqMailAuthorizationCodeField(' authorization-code ')).toBe('authorization-code')
    expect(() => qqMailAuthorizationCodeField('code\r\nLOGIN')).toThrow('授权码')
    expect(() => qqMailAuthorizationCodeField('\0code')).toThrow('授权码')
    expect(() => qqMailAuthorizationCodeField('x'.repeat(129))).toThrow('授权码')
  })

  it('validates account labels', () => {
    expect(qqMailNameField(' Personal QQ ')).toBe('Personal QQ')
    expect(() => qqMailNameField('')).toThrow('1–60')
  })
})
