import { describe, expect, it, vi } from 'vitest'
import {
  officialExtensionEnabled,
  parseMailRefreshInterval,
  parseOfficialExtensionEnabled,
  parseRandomMailboxPrefix,
  parseRemoteImagesEnabled,
  parseUnassignedMailEnabled,
  updateOfficialExtensionSetting,
  updateRandomMailboxPrefix,
} from './system-settings'
import type { Env, SessionUser } from './types'

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

describe('official browser extension settings', () => {
  it('accepts only boolean values from the owner request', () => {
    expect(parseOfficialExtensionEnabled(true)).toBe(true)
    expect(parseOfficialExtensionEnabled(false)).toBe(false)
    expect(parseOfficialExtensionEnabled('true')).toBeNull()
    expect(parseOfficialExtensionEnabled(undefined)).toBeNull()
  })

  it('defaults to disabled and reads the persisted switch', async () => {
    const database = (value: string | undefined) => ({
      prepare: () => ({
        bind: () => ({ first: async () => value === undefined ? null : { value } }),
      }),
    }) as unknown as D1Database

    await expect(officialExtensionEnabled(database(undefined))).resolves.toBe(false)
    await expect(officialExtensionEnabled(database('0'))).resolves.toBe(false)
    await expect(officialExtensionEnabled(database('1'))).resolves.toBe(true)
  })

  it('allows only the owner to update the switch', async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = []
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...bindings: unknown[]) => {
          statements.push({ sql, bindings })
          return { run: vi.fn(async () => ({ meta: { changes: 1 } })) }
        }),
      })),
    } as unknown as D1Database
    const env = { DB: db } as Env
    const actor = (role: SessionUser['role']) => ({
      id: `${role}-1`, role,
    }) as SessionUser
    const request = () => new Request('https://mail.example.com/api/admin/settings/official-extension', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })

    const denied = await updateOfficialExtensionSetting(
      env, actor('admin'), request(), '127.0.0.1',
    )
    expect(denied.status).toBe(403)
    expect(statements).toHaveLength(0)

    const allowed = await updateOfficialExtensionSetting(
      env, actor('super_admin'), request(), '127.0.0.1',
    )
    expect(allowed.status).toBe(200)
    expect(statements.some(({ bindings }) => (
      bindings[0] === 'official_extension_enabled' && bindings[1] === '1'
    ))).toBe(true)
  })
})

describe('random mailbox prefix settings', () => {
  it('normalizes a short local-part prefix and allows an empty prefix', () => {
    expect(parseRandomMailboxPrefix(' Promo- ')).toBe('promo-')
    expect(parseRandomMailboxPrefix('')).toBe('')
  })

  it('rejects unsupported characters and prefixes longer than 20 characters', () => {
    expect(parseRandomMailboxPrefix('-promo')).toBeNull()
    expect(parseRandomMailboxPrefix('promo address')).toBeNull()
    expect(parseRandomMailboxPrefix('a'.repeat(21))).toBeNull()
    expect(parseRandomMailboxPrefix(undefined)).toBeNull()
  })

  it('persists the normalized prefix for administrators', async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = []
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...bindings: unknown[]) => {
          statements.push({ sql, bindings })
          return { run: vi.fn(async () => ({ meta: { changes: 1 } })) }
        }),
      })),
    } as unknown as D1Database
    const response = await updateRandomMailboxPrefix(
      { DB: db } as Env,
      { id: 'admin-1', role: 'admin' } as SessionUser,
      new Request('https://mail.example.com/api/admin/settings/random-mailbox-prefix', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: ' Alias- ' }),
      }),
      '127.0.0.1',
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ randomMailboxPrefix: 'alias-' })
    expect(statements.some(({ bindings }) => (
      bindings[0] === 'random_mailbox_prefix' && bindings[1] === 'alias-'
    ))).toBe(true)
  })
})
