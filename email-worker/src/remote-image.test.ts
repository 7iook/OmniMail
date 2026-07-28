import { afterEach, describe, expect, it, vi } from 'vitest'
import { proxyRemoteImage, safeRemoteImageUrl } from './remote-image'

afterEach(() => vi.unstubAllGlobals())

describe('remote image proxy', () => {
  it('allows only Claude official image paths', () => {
    expect(safeRemoteImageUrl('https://claude.ai/images/claude_logo_full.png')?.href).toBe(
      'https://claude.ai/images/claude_logo_full.png',
    )
    expect(safeRemoteImageUrl('https://claude.ai/account')).toBeNull()
    expect(safeRemoteImageUrl('https://example.com/images/logo.png')).toBeNull()
    expect(safeRemoteImageUrl('https://claude.ai.evil.example/images/logo.png')).toBeNull()
  })

  it('rejects credentials, custom ports, and non-HTTPS URLs', () => {
    expect(safeRemoteImageUrl('https://user@claude.ai/images/logo.png')).toBeNull()
    expect(safeRemoteImageUrl('https://claude.ai:8443/images/logo.png')).toBeNull()
    expect(safeRemoteImageUrl('http://claude.ai/images/logo.png')).toBeNull()
  })

  it('returns the image without forwarding the upstream cross-origin restriction', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('image', {
      headers: {
        'Content-Type': 'image/png',
        'Cross-Origin-Resource-Policy': 'same-origin',
      },
    })))

    const response = await proxyRemoteImage(new Request(
      'https://mail.example/api/remote-images?url=https%3A%2F%2Fclaude.ai%2Fimages%2Fclaude_logo_full.png',
    ))

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBeNull()
  })
})
