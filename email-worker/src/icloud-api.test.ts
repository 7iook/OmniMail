import { describe, expect, it, vi } from 'vitest'
import {
  createICloudAccount,
  createICloudAlias,
  previewICloudAlias,
  updateICloudAccountName,
} from './icloud-api'
import type { Env, SessionUser } from './types'

const user = {
  id: 'user-1',
  email: 'user@example.com',
  displayName: 'User',
  role: 'user',
  mailboxLimit: 1,
  storageQuotaBytes: 1024,
  storageUsedBytes: 0,
  canCreateMailboxes: false,
  canReply: false,
  canTranslate: false,
  temporaryExpiresAt: null,
} satisfies SessionUser

function request(body: unknown): Request {
  return new Request('https://mail.example.com/api/icloud/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('iCloud account API validation', () => {
  it('rejects malformed inputs before making an Apple request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const response = await createICloudAccount(
      { ICLOUD_CREDENTIALS_KEY: 'key-that-is-at-least-thirty-two-characters' } as Env,
      user,
      request({ name: '', cookies: 'not-a-cookie' }),
      '192.0.2.1',
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: '账号名称需要在 1–80 个字符之间。',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires the dedicated credential encryption key', async () => {
    const response = await createICloudAccount(
      {} as Env,
      user,
      request({ name: 'Personal', cookies: 'session=value' }),
      '192.0.2.1',
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: 'iCloud 功能尚未配置 ICLOUD_CREDENTIALS_KEY。',
    })
  })

  it('rejects an empty account display name before accessing storage', async () => {
    const response = await updateICloudAccountName(
      { ICLOUD_CREDENTIALS_KEY: 'key-that-is-at-least-thirty-two-characters' } as Env,
      user,
      'icloud-1',
      new Request('https://mail.example.com/api/icloud/accounts/icloud-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '   ' }),
      }),
      '192.0.2.1',
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: '账号名称需要在 1–80 个字符之间。',
    })
  })

  it('requires an account when previewing a Hide My Email address', async () => {
    const response = await previewICloudAlias(
      { ICLOUD_CREDENTIALS_KEY: 'key-that-is-at-least-thirty-two-characters' } as Env,
      user,
      request({ accountId: '' }),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: '隐藏邮箱参数无效。' })
  })

  it('requires a matching preview identity when reserving a suggested address', async () => {
    const response = await createICloudAlias(
      { ICLOUD_CREDENTIALS_KEY: 'key-that-is-at-least-thirty-two-characters' } as Env,
      user,
      request({ accountId: 'icloud-1', email: 'preview@icloud.com' }),
      '192.0.2.1',
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: '隐藏邮箱参数无效。' })
  })

  it('stores an invalid-but-parseable Apple session as an account needing attention', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ webservices: {} }),
      { status: 200 },
    ))
    const run = vi.fn(async () => ({ meta: { changes: 1 } }))
    const bind = vi.fn(() => ({ run }))
    const prepare = vi.fn(() => ({ bind }))
    const env = {
      DB: { prepare },
      ICLOUD_CREDENTIALS_KEY: 'key-that-is-at-least-thirty-two-characters',
    } as unknown as Env
    const response = await createICloudAccount(
      env,
      user,
      request({ name: 'Personal', cookies: 'session=value' }),
      '192.0.2.1',
    )
    const result = await response.json() as { account: { status: string; lastError: string } }

    expect(response.status).toBe(201)
    expect(result.account.status).toBe('error')
    expect(result.account.lastError).toContain('Cookie 已过期')
    expect(JSON.stringify(result)).not.toContain('session=value')
    expect(prepare).toHaveBeenCalledTimes(2)
  })
})
