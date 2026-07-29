import { describe, expect, it, vi } from 'vitest'
import {
  isNewerVersion,
  parseMailRefreshInterval,
  parseRemoteImagesEnabled,
  parseUnassignedMailEnabled,
  systemVersion,
} from './system-settings'
import type { SessionUser } from './types'

const administrator: SessionUser = {
  id: 'admin-1',
  email: 'owner@example.com',
  displayName: 'Owner',
  role: 'super_admin',
  mailboxLimit: 100,
  canCreateMailboxes: true,
  canReply: true,
  temporaryExpiresAt: null,
}

describe('mail refresh settings', () => {
  it('accepts only the supported refresh intervals', () => {
    expect(parseMailRefreshInterval(0)).toBe(0)
    expect(parseMailRefreshInterval(5)).toBe(5)
    expect(parseMailRefreshInterval(30)).toBe(30)
    expect(parseMailRefreshInterval(120)).toBe(120)
  })

  it('rejects unsupported or incorrectly typed intervals', () => {
    expect(parseMailRefreshInterval(15)).toBeNull()
    expect(parseMailRefreshInterval(-1)).toBeNull()
    expect(parseMailRefreshInterval('30')).toBeNull()
    expect(parseMailRefreshInterval(undefined)).toBeNull()
  })
})

describe('remote image settings', () => {
  it('accepts only boolean values from the administrator request', () => {
    expect(parseRemoteImagesEnabled(true)).toBe(true)
    expect(parseRemoteImagesEnabled(false)).toBe(false)
  })

  it('rejects string and missing values', () => {
    expect(parseRemoteImagesEnabled('true')).toBeNull()
    expect(parseRemoteImagesEnabled(1)).toBeNull()
    expect(parseRemoteImagesEnabled(undefined)).toBeNull()
  })
})

describe('unassigned mail settings', () => {
  it('accepts only boolean values from the administrator request', () => {
    expect(parseUnassignedMailEnabled(true)).toBe(true)
    expect(parseUnassignedMailEnabled(false)).toBe(false)
    expect(parseUnassignedMailEnabled('true')).toBeNull()
    expect(parseUnassignedMailEnabled(undefined)).toBeNull()
  })
})

describe('system version', () => {
  it('compares stable release versions', () => {
    expect(isNewerVersion('v0.2.0', '0.1.0')).toBe(true)
    expect(isNewerVersion('0.1.1', 'v0.1.0')).toBe(true)
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false)
    expect(isNewerVersion('not-a-version', '0.1.0')).toBe(false)
  })

  it('returns the installed version and a newer GitHub release', async () => {
    const releaseFetch = vi.fn(async () => Response.json({ tag_name: 'v0.2.0' }))
    const response = await systemVersion(administrator, releaseFetch as typeof fetch)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      updateAvailable: true,
      checkFailed: false,
      releaseUrl: 'https://github.com/mibgb65-cloud/OmniMail/releases/latest',
    })
    const init = releaseFetch.mock.calls[0]?.[1] as RequestInit & {
      cf?: { cacheEverything?: boolean; cacheTtlByStatus?: Record<string, number> }
    }
    expect(init.cf).toEqual({
      cacheEverything: true,
      cacheTtlByStatus: { '200-299': 3600, 404: 300, '500-599': 0 },
    })
  })

  it('keeps the installed version visible when GitHub is unavailable', async () => {
    const releaseFetch = vi.fn(async () => new Response(null, { status: 503 }))
    const response = await systemVersion(administrator, releaseFetch as typeof fetch)
    expect(await response.json()).toMatchObject({
      currentVersion: '0.1.0',
      latestVersion: null,
      updateAvailable: false,
      checkFailed: true,
    })
  })

  it('rejects non-administrator accounts without contacting GitHub', async () => {
    const releaseFetch = vi.fn()
    const response = await systemVersion(
      { ...administrator, role: 'user' },
      releaseFetch as typeof fetch,
    )
    expect(response.status).toBe(403)
    expect(releaseFetch).not.toHaveBeenCalled()
  })
})
