import { describe, expect, it } from 'vitest'
import { emailImageSources, normalizeContentId, safeEmailHref } from './MessageReader'

describe('email remote image policy', () => {
  it('blocks remote image protocols by default', () => {
    expect(emailImageSources(false)).toBe('data: cid:')
  })

  it('allows HTTPS image requests only when enabled', () => {
    expect(emailImageSources(true)).toBe('data: cid: https:')
  })
})

describe('email content safety', () => {
  it('normalizes content IDs used by inline images', () => {
    expect(normalizeContentId('cid:%3Cclaude-logo%40mail%3E')).toBe('claude-logo@mail')
    expect(normalizeContentId('<claude-logo@mail>')).toBe('claude-logo@mail')
  })

  it('allows absolute web links and rejects active or relative URLs', () => {
    expect(safeEmailHref('https://claude.ai/login?token=example')).toBe(
      'https://claude.ai/login?token=example',
    )
    expect(safeEmailHref('javascript:alert(1)')).toBeNull()
    expect(safeEmailHref('/api/logout')).toBeNull()
  })
})
