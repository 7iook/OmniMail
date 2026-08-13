import { describe, expect, it } from 'vitest'
import {
  deviceScopesAllow,
  EXTENSION_DEVICE_SCOPES,
  FULL_DEVICE_SCOPES,
} from './token-scope'

describe('device token scopes', () => {
  function request(path: string, method = 'GET', body?: unknown): Request {
    return new Request(`https://mail.example.com${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  it('keeps full desktop tokens backwards compatible', async () => {
    await expect(deviceScopesAllow(
      FULL_DEVICE_SCOPES,
      request('/api/admin/users'),
    )).resolves.toBe(true)
    await expect(deviceScopesAllow(
      FULL_DEVICE_SCOPES,
      request('/api/messages', 'POST'),
    )).resolves.toBe(true)
  })

  it('allows only the APIs used by OmniMail Float', async () => {
    await expect(deviceScopesAllow(EXTENSION_DEVICE_SCOPES, request('/api/domains'))).resolves.toBe(true)
    await expect(deviceScopesAllow(EXTENSION_DEVICE_SCOPES, request('/api/mailboxes'))).resolves.toBe(true)
    await expect(deviceScopesAllow(EXTENSION_DEVICE_SCOPES, request('/api/mailboxes', 'POST'))).resolves.toBe(true)
    await expect(deviceScopesAllow(EXTENSION_DEVICE_SCOPES, request('/api/messages'))).resolves.toBe(true)
    await expect(deviceScopesAllow(EXTENSION_DEVICE_SCOPES, request('/api/messages/message-1'))).resolves.toBe(true)
    await expect(deviceScopesAllow(
      EXTENSION_DEVICE_SCOPES,
      request('/api/messages/message-1', 'PATCH', { isRead: true }),
    )).resolves.toBe(true)
  })

  it('denies administrative and destructive APIs to extension tokens', async () => {
    await expect(deviceScopesAllow(EXTENSION_DEVICE_SCOPES, request('/api/admin/users'))).resolves.toBe(false)
    await expect(deviceScopesAllow(EXTENSION_DEVICE_SCOPES, request('/api/messages', 'POST'))).resolves.toBe(false)
    await expect(deviceScopesAllow(EXTENSION_DEVICE_SCOPES, request('/api/messages/message-1', 'DELETE'))).resolves.toBe(false)
    await expect(deviceScopesAllow(EXTENSION_DEVICE_SCOPES, request('/api/messages/message-1/raw'))).resolves.toBe(false)
    await expect(deviceScopesAllow(EXTENSION_DEVICE_SCOPES, request('/api/auth/devices'))).resolves.toBe(false)
    await expect(deviceScopesAllow(
      EXTENSION_DEVICE_SCOPES,
      request('/api/messages/message-1', 'PATCH', { folder: 'trash' }),
    )).resolves.toBe(false)
  })
})
