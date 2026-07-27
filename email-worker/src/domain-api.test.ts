import { describe, expect, it } from 'vitest'
import { normalizeDomain, validDomainName } from './domain-api'

describe('domain validation', () => {
  it('normalizes case and a trailing dot', () => {
    expect(normalizeDomain(' Example.COM. ')).toBe('example.com')
  })

  it('accepts regular and local test domains', () => {
    expect(validDomainName('example.com')).toBe(true)
    expect(validDomainName('mail.omni.test')).toBe(true)
  })

  it('rejects email addresses and invalid labels', () => {
    expect(validDomainName('owner@example.com')).toBe(false)
    expect(validDomainName('-mail.example.com')).toBe(false)
    expect(validDomainName('localhost')).toBe(false)
  })
})
