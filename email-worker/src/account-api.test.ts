import { describe, expect, it } from 'vitest'
import { validateAccountUpdate } from './account-api'

describe('account update validation', () => {
  it('normalizes a display name update', () => {
    expect(validateAccountUpdate({ displayName: '  Omni Owner  ' })).toEqual({
      value: { displayName: 'Omni Owner' },
    })
  })

  it('requires the current password when changing passwords', () => {
    expect(validateAccountUpdate({ newPassword: 'new-password-123' })).toEqual({
      error: '请输入当前密码。',
    })
  })

  it('rejects empty updates and short new passwords', () => {
    expect(validateAccountUpdate({})).toEqual({
      error: '没有需要保存的账户更改。',
    })
    expect(validateAccountUpdate({
      currentPassword: 'old-password',
      newPassword: 'short',
    })).toEqual({
      error: '密码至少需要 10 个字符。',
    })
  })
})
