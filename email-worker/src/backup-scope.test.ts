import { describe, expect, it } from 'vitest'
import { backupIdentity, scopedBackupKey } from './backup-scope'

describe('backup instance scope', () => {
  it('prefixes every backup key with the current database identity', async () => {
    const db = {
      prepare: () => ({
        bind() { return this },
        first: async () => ({ value: '0123456789ABCDEF0123456789ABCDEF' }),
      }),
    } as unknown as D1Database
    const identity = await backupIdentity(db)
    expect(scopedBackupKey(identity, 'mail/raw/2026-08/message.eml')).toBe(
      'instances/0123456789abcdef0123456789abcdef/mail/raw/2026-08/message.eml',
    )
  })

  it('rejects a missing or malformed database identity', async () => {
    const db = {
      prepare: () => ({ bind() { return this }, first: async () => null }),
    } as unknown as D1Database
    await expect(backupIdentity(db)).rejects.toThrow('备份身份标识')
  })
})
