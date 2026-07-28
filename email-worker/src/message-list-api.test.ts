import { describe, expect, it } from 'vitest'
import { parseSyncVersion } from './message-list-api'

describe('message sync version', () => {
  it('accepts non-negative integer versions', () => {
    expect(parseSyncVersion(null)).toBeNull()
    expect(parseSyncVersion('0')).toBe(0)
    expect(parseSyncVersion('42')).toBe(42)
  })

  it('rejects malformed versions', () => {
    expect(parseSyncVersion('-1')).toBeUndefined()
    expect(parseSyncVersion('1.5')).toBeUndefined()
    expect(parseSyncVersion('latest')).toBeUndefined()
  })
})
