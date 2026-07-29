import { describe, expect, it } from 'vitest'
import { inspectBackupSample, validBackupPrefix } from './backup-browser-api'

describe('backup browser safety', () => {
  it('allows only managed backup namespaces', () => {
    expect(validBackupPrefix('d1/daily/')).toBe(true)
    expect(validBackupPrefix('mail/raw/')).toBe(true)
    expect(validBackupPrefix('private/')).toBe(false)
  })

  it('recognizes a D1 SQL export without applying it', () => {
    const result = inspectBackupSample(
      'd1/daily/2026-07-29/backup.sql',
      'PRAGMA foreign_keys=OFF;\nCREATE TABLE users (id TEXT);',
      1024,
    )
    expect(result.every(({ passed }) => passed)).toBe(true)
  })

  it('rejects malformed raw-mail samples', () => {
    const result = inspectBackupSample(
      'mail/raw/2026-07/message.eml',
      'not an email',
      12,
    )
    expect(result.some(({ passed }) => !passed)).toBe(true)
  })
})
