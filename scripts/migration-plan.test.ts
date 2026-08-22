import { describe, expect, it } from 'vitest'
import {
  LEGACY_RECOVERY_BOUNDARY,
  needsLegacyBootstrap,
} from './migration-plan.mjs'

describe('remote D1 migration planning', () => {
  it('skips the import-style bootstrap for an up-to-date database', () => {
    expect(needsLegacyBootstrap(new Set([
      LEGACY_RECOVERY_BOUNDARY,
      '0022_consistency_guards.sql',
    ]))).toBe(false)
  })

  it('keeps bootstrap recovery for fresh and legacy databases', () => {
    expect(needsLegacyBootstrap(null)).toBe(true)
    expect(needsLegacyBootstrap(new Set(['0017_multiple_drafts.sql']))).toBe(true)
  })
})
