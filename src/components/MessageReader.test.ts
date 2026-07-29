import { describe, expect, it } from 'vitest'
import {
  EMAIL_FRAME_SANDBOX,
  emailDocumentHeight,
  emailImageSources,
  emailLinkHref,
  normalizeContentId,
  safeEmailHref,
  shouldProxyRemoteImage,
} from './MessageReader'

describe('email remote image policy', () => {
  it('blocks remote image protocols by default', () => {
    expect(emailImageSources(false)).toBe('data: cid:')
  })

  it('allows HTTPS image requests only when enabled', () => {
    expect(emailImageSources(true)).toBe('data: cid: https:')
  })

  it('proxies public HTTPS images through OmniMail', () => {
    expect(shouldProxyRemoteImage('https://claude.ai/images/claude_logo_full.png')).toBe(true)
    expect(shouldProxyRemoteImage('https://emails.resend.com/static/logo-v2.png')).toBe(true)
    expect(shouldProxyRemoteImage('http://example.com/images/logo.png')).toBe(false)
    expect(shouldProxyRemoteImage('https://user@example.com/images/logo.png')).toBe(false)
  })
})

describe('email frame layout', () => {
  it('uses the full document height with a stable minimum', () => {
    expect(emailDocumentHeight({
      body: { offsetHeight: 790, scrollHeight: 820 },
      documentElement: { offsetHeight: 800, scrollHeight: 810 },
    } as unknown as Document)).toBe(820)
    expect(emailDocumentHeight({
      body: { offsetHeight: 100, scrollHeight: 100 },
      documentElement: { offsetHeight: 100, scrollHeight: 100 },
    } as unknown as Document)).toBe(470)
  })
})

describe('email content safety', () => {
  it('keeps scripts disabled so noscript email bodies remain visible', () => {
    expect(EMAIL_FRAME_SANDBOX).toBe('allow-same-origin')
    expect(EMAIL_FRAME_SANDBOX).not.toContain('allow-scripts')
  })

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

  it('reads links from iframe elements without relying on the parent realm', () => {
    const iframeTarget = {
      closest: () => ({ dataset: { omnimailHref: 'https://claude.ai/login' } }),
    } as unknown as EventTarget

    expect(emailLinkHref(iframeTarget)).toBe('https://claude.ai/login')
  })
})
