import { describe, expect, it } from 'vitest'
import { nextRefreshDelay } from './useAutoRefresh'

describe('adaptive mail refresh', () => {
  it('backs off unchanged polls up to two minutes', () => {
    expect(nextRefreshDelay(30, 30, false)).toBe(60)
    expect(nextRefreshDelay(60, 30, false)).toBe(120)
    expect(nextRefreshDelay(120, 30, false)).toBe(120)
  })

  it('returns to the configured interval after a change', () => {
    expect(nextRefreshDelay(120, 30, true)).toBe(30)
    expect(nextRefreshDelay(120, 30)).toBe(30)
  })
})
