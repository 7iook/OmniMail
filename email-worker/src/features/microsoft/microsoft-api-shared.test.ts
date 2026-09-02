import { describe, expect, it, vi } from 'vitest'
import { ImapConnectionError } from '../../platform/imap/imap-errors'
import { microsoftResponseError } from './microsoft-api-shared'
import { MicrosoftGraphError } from './microsoft-graph'

async function body(response: Response): Promise<{ code: string; error: string }> {
  return await response.json() as { code: string; error: string }
}

describe('Microsoft failure to HTTP response', () => {
  it('never answers a Graph 401 with our own 401, which would log the user out', async () => {
    const response = microsoftResponseError(new MicrosoftGraphError('graph_credential_rejected', 401, false))
    expect(response.status).toBe(400)
    await expect(body(response)).resolves.toMatchObject({ code: 'graph_credential_rejected' })
  })

  it('keeps the IMAP 401 downgrade the pre-Graph path already had', async () => {
    const response = microsoftResponseError(new ImapConnectionError(401, 'rejected', true), 'oauth2')
    expect(response.status).toBe(400)
    await expect(body(response)).resolves.toMatchObject({ code: 'imap_access_rejected' })
  })

  it('reports a Graph 403 as a permission failure with a re-authorise message', async () => {
    const response = microsoftResponseError(new MicrosoftGraphError('graph_permission_denied', 403, false))
    expect(response.status).toBe(403)
    const json = await body(response)
    expect(json.code).toBe('graph_permission_denied')
    expect(json.error).toContain('权限')
  })

  it('answers throttling with 429 and the Retry-After Microsoft asked for', async () => {
    const response = microsoftResponseError(new MicrosoftGraphError('graph_throttled', 429, true, 45))
    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('45')
    await expect(body(response)).resolves.toMatchObject({ code: 'graph_throttled' })
  })

  it('passes data and timeout statuses through', async () => {
    expect(microsoftResponseError(new MicrosoftGraphError('graph_message_not_found', 404, false)).status).toBe(404)
    expect(microsoftResponseError(new MicrosoftGraphError('graph_timeout', 504, true)).status).toBe(504)
    expect(microsoftResponseError(new ImapConnectionError(504, 'timeout')).status).toBe(504)
    expect(microsoftResponseError(new ImapConnectionError(404, 'gone', true)).status).toBe(404)
  })

  it('maps oversize IMAP responses to 413 as before', async () => {
    const response = microsoftResponseError(new ImapConnectionError(502, '响应超过安全上限', true))
    expect(response.status).toBe(413)
    await expect(body(response)).resolves.toMatchObject({ code: 'response_too_large' })
  })

  it('gives every Graph code a user-facing message rather than the generic fallback', async () => {
    const codes = [
      'graph_throttled', 'graph_credential_rejected', 'graph_permission_denied',
      'graph_message_not_found', 'graph_unavailable', 'graph_connection_failed', 'graph_timeout',
      'graph_listing_truncated', 'graph_invalid_response', 'graph_invalid_next_link',
      'graph_invalid_message_id', 'graph_invalid_folder', 'graph_request_failed',
    ] as const
    for (const code of codes) {
      const json = await body(microsoftResponseError(new MicrosoftGraphError(code, 502, false)))
      expect(json.code).toBe(code)
      expect(json.error).not.toBe('暂时无法连接 Microsoft 邮箱，请稍后重试。')
    }
  })

  it('logs unknown errors with the classified code and answers 500', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const response = microsoftResponseError(new TypeError('boom'))
    logged.mockRestore()
    expect(response.status).toBe(500)
    await expect(body(response)).resolves.toMatchObject({ code: 'request_failed' })
  })
})
