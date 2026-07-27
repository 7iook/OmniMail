import { describe, expect, it } from 'vitest'
import { inviteState, temporaryAddress } from './temporary-invite-api'

const activeInvite = {
  domain_active: 1,
  expires_at: 200,
  max_uses: 1,
  use_count: 0,
  revoked_at: null,
}

describe('temporary invites', () => {
  it('builds a normalized mailbox address from a local part', () => {
    expect(temporaryAddress(' Guest.Name ', 'example.com')).toBe('guest.name@example.com')
    expect(temporaryAddress('bad@name', 'example.com')).toBe('')
    expect(temporaryAddress('.hidden', 'example.com')).toBe('')
    expect(temporaryAddress('two..dots', 'example.com')).toBe('')
  })

  it('distinguishes active, expired, used and revoked links', () => {
    expect(inviteState(activeInvite, 100)).toBe('active')
    expect(inviteState({ ...activeInvite, expires_at: 100 }, 100)).toBe('expired')
    expect(inviteState({ ...activeInvite, use_count: 1 }, 100)).toBe('used')
    expect(inviteState({ ...activeInvite, revoked_at: 50 }, 100)).toBe('revoked')
  })

  it('keeps multi-use links active after prior registrations', () => {
    expect(inviteState({ ...activeInvite, max_uses: 0, use_count: 12 }, 100)).toBe('active')
  })
})
