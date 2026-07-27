import { describe, expect, it } from 'vitest'
import { emailImageSources } from './MessageReader'

describe('email remote image policy', () => {
  it('blocks remote image protocols by default', () => {
    expect(emailImageSources(false)).toBe('data: cid:')
  })

  it('allows HTTPS image requests only when enabled', () => {
    expect(emailImageSources(true)).toBe('data: cid: https:')
  })
})
