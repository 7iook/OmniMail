import { describe, expect, it } from 'vitest'
import { normalizeStatisticsDays } from './statistics-api'

describe('mail statistics range', () => {
  it('accepts supported ranges', () => {
    expect(normalizeStatisticsDays('7')).toBe(7)
    expect(normalizeStatisticsDays('30')).toBe(30)
    expect(normalizeStatisticsDays('90')).toBe(90)
  })

  it('defaults unsupported values to 30 days', () => {
    expect(normalizeStatisticsDays(null)).toBe(30)
    expect(normalizeStatisticsDays('14')).toBe(30)
    expect(normalizeStatisticsDays('invalid')).toBe(30)
  })
})
