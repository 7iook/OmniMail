import { describe, expect, it } from 'vitest'
import { canCreateMailbox, mailboxDomain } from './mailbox-api'
import type { SessionUser, UserRole } from './types'

function user(role: UserRole, canCreateMailboxes: boolean): SessionUser {
  return {
    id: role,
    email: `${role}@example.com`,
    displayName: role,
    role,
    mailboxLimit: 1,
    canCreateMailboxes,
    canReply: false,
    temporaryExpiresAt: null,
  }
}

describe('mailboxDomain', () => {
  it('groups mailboxes by a normalized domain suffix', () => {
    expect(mailboxDomain('hello@Example.COM')).toBe('example.com')
    expect(mailboxDomain('alerts@sub.example.com')).toBe('sub.example.com')
  })

  it('requires explicit permission for regular and temporary users', () => {
    expect(canCreateMailbox(user('user', false))).toBe(false)
    expect(canCreateMailbox(user('temporary', false))).toBe(false)
    expect(canCreateMailbox(user('user', true))).toBe(true)
    expect(canCreateMailbox(user('temporary', true))).toBe(true)
  })

  it('allows administrators without a separate mailbox permission', () => {
    expect(canCreateMailbox(user('admin', false))).toBe(true)
    expect(canCreateMailbox(user('super_admin', false))).toBe(true)
  })
})
