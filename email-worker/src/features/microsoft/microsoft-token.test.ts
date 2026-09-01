import { describe, expect, it, vi } from 'vitest'
import {
  MicrosoftTokenError,
  microsoftTokenEndpoint,
  refreshMicrosoftToken,
  validateMicrosoftAuthority,
} from './microsoft-token'

describe('Microsoft OAuth token refresh', () => {
  it('uses only the fixed Azure Global token endpoint and Outlook IMAP scope', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body))
      expect(body.get('client_id')).toBe('00000000-0000-4000-8000-000000000000')
      expect(body.get('refresh_token')).toBe('refresh-token')
      expect(body.get('grant_type')).toBe('refresh_token')
      expect(body.get('scope')).toBe(
        'https://outlook.office.com/IMAP.AccessAsUser.All offline_access',
      )
      return Response.json({
        token_type: 'Bearer',
        access_token: 'access-token',
        refresh_token: 'rotated-token',
        expires_in: 3600,
        scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access',
      })
    })

    await expect(refreshMicrosoftToken({
      authority: 'consumers',
      clientId: '00000000-0000-4000-8000-000000000000',
      refreshToken: 'refresh-token',
      fetcher,
    })).resolves.toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'rotated-token',
      expiresIn: 3600,
    })
    expect(fetcher).toHaveBeenCalledWith(
      microsoftTokenEndpoint('consumers'),
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('accepts named authorities and tenant UUIDs but rejects URL injection', () => {
    expect(validateMicrosoftAuthority('common')).toBe('common')
    expect(validateMicrosoftAuthority('organizations')).toBe('organizations')
    expect(validateMicrosoftAuthority('00000000-0000-4000-8000-000000000000'))
      .toBe('00000000-0000-4000-8000-000000000000')
    expect(() => validateMicrosoftAuthority('https://evil.example/token')).toThrow('authority')
  })

  it('maps invalid_grant without returning the provider description or token', async () => {
    const fetcher = vi.fn(async () => Response.json({
      error: 'invalid_grant',
      error_description: 'refresh-token must never leave the server log boundary',
    }, { status: 400 }))
    const error = await refreshMicrosoftToken({
      authority: 'common',
      clientId: '00000000-0000-4000-8000-000000000000',
      refreshToken: 'refresh-token',
      fetcher,
    }).catch((caught) => caught)
    expect(error).toBeInstanceOf(MicrosoftTokenError)
    expect(error).toMatchObject({ code: 'invalid_grant', retryable: false })
    expect(String(error)).not.toContain('refresh-token')
  })
})

describe('Microsoft OAuth token scope per transport', () => {
  const graphGranted = [
    'https://graph.microsoft.com/Mail.Read',
    'https://graph.microsoft.com/Mail.ReadWrite',
    'https://graph.microsoft.com/User.Read',
  ].join(' ')

  function tokenResponse(scope: string): () => Promise<Response> {
    return async () => Response.json({
      token_type: 'Bearer',
      access_token: 'graph-access-token',
      refresh_token: 'rotated-token',
      expires_in: 3600,
      scope,
    })
  }

  it('requests the Graph mail scopes and accepts the scopes Microsoft actually grants', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body))
      expect(body.get('scope')).toBe(
        'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite'
        + ' https://graph.microsoft.com/User.Read offline_access',
      )
      // Microsoft echoes the three graph scopes back without offline_access.
      return tokenResponse(graphGranted)()
    })

    await expect(refreshMicrosoftToken({
      authority: 'consumers',
      clientId: '00000000-0000-4000-8000-000000000000',
      refreshToken: 'refresh-token',
      transport: 'graph',
      fetcher,
    })).resolves.toMatchObject({
      accessToken: 'graph-access-token',
      refreshToken: 'rotated-token',
      expiresIn: 3600,
    })
  })

  it('rejects a graph request whose token was granted the IMAP scope only', async () => {
    const error = await refreshMicrosoftToken({
      authority: 'consumers',
      clientId: '00000000-0000-4000-8000-000000000000',
      refreshToken: 'refresh-token',
      transport: 'graph',
      fetcher: vi.fn(tokenResponse('https://outlook.office.com/IMAP.AccessAsUser.All')),
    }).catch((caught) => caught)
    expect(error).toBeInstanceOf(MicrosoftTokenError)
    expect(error).toMatchObject({ code: 'graph_scope_missing', status: 403, retryable: false })
  })

  it('rejects an imap request whose token was granted graph scopes only', async () => {
    const error = await refreshMicrosoftToken({
      authority: 'consumers',
      clientId: '00000000-0000-4000-8000-000000000000',
      refreshToken: 'refresh-token',
      transport: 'imap',
      fetcher: vi.fn(tokenResponse(graphGranted)),
    }).catch((caught) => caught)
    expect(error).toBeInstanceOf(MicrosoftTokenError)
    expect(error).toMatchObject({ code: 'imap_scope_missing', status: 403, retryable: false })
  })

  it('rejects a graph request granted Mail.Read on the Outlook REST resource', async () => {
    const error = await refreshMicrosoftToken({
      authority: 'consumers',
      clientId: '00000000-0000-4000-8000-000000000000',
      refreshToken: 'refresh-token',
      transport: 'graph',
      fetcher: vi.fn(tokenResponse('https://outlook.office.com/Mail.Read')),
    }).catch((caught) => caught)
    expect(error).toMatchObject({ code: 'graph_scope_missing' })
  })

  it('defaults to the imap scope so existing callers keep their contract', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URLSearchParams(String(init?.body)).get('scope')).toBe(
        'https://outlook.office.com/IMAP.AccessAsUser.All offline_access',
      )
      return tokenResponse('https://outlook.office.com/IMAP.AccessAsUser.All')()
    })
    await expect(refreshMicrosoftToken({
      authority: 'common',
      clientId: '00000000-0000-4000-8000-000000000000',
      refreshToken: 'refresh-token',
      fetcher,
    })).resolves.toMatchObject({ accessToken: 'graph-access-token' })
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
