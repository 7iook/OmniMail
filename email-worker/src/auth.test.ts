import { describe, expect, it } from 'vitest'
import {
  applySuperAdminRole,
  activeUser,
  hashPassword,
  secretsEqual,
  validatePassword,
  verifyPassword,
} from './auth'

describe('password security', () => {
  it('hashes and verifies a password without storing the original', async () => {
    const encoded = await hashPassword('a sufficiently long password')
    expect(encoded).toMatch(/^pbkdf2-sha256\$210000\$/)
    expect(encoded).not.toContain('sufficiently')
    await expect(verifyPassword('a sufficiently long password', encoded)).resolves.toBe(true)
    await expect(verifyPassword('the wrong password', encoded)).resolves.toBe(false)
  })

  it('rejects short and excessively long passwords', () => {
    expect(validatePassword('short')).toContain('10')
    expect(validatePassword('x'.repeat(129))).toContain('128')
    expect(validatePassword('long-enough')).toBeNull()
  })

  it('compares setup secrets by digest', async () => {
    await expect(secretsEqual('same-secret', 'same-secret')).resolves.toBe(true)
    await expect(secretsEqual('wrong-secret', 'same-secret')).resolves.toBe(false)
  })

  it('derives the super administrator role from Worker configuration', () => {
    const user = {
      id: 'user-1',
      email: 'Owner@Example.com',
      displayName: 'Owner',
      role: 'user' as const,
      mailboxLimit: 1,
      canCreateMailboxes: false,
      canReply: false,
      temporaryExpiresAt: null,
    }
    expect(applySuperAdminRole(user, 'owner@example.com')).toMatchObject({
      role: 'super_admin',
      canCreateMailboxes: true,
      canReply: true,
    })
    expect(applySuperAdminRole(user, 'other@example.com').role).toBe('user')
  })

  it('rejects expired and deleted temporary users', () => {
    const temporary = {
      role: 'temporary' as const,
      status: 'active' as const,
      temporary_expires_at: 200,
      deleted_at: null,
    }
    expect(activeUser(temporary, 199)).toBe(true)
    expect(activeUser(temporary, 200)).toBe(false)
    expect(activeUser({ ...temporary, deleted_at: 150 }, 199)).toBe(false)
  })
})
