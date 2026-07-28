import { describe, expect, it } from 'vitest'
import { messageReferenceIds } from './message-thread'

describe('message thread references', () => {
  it('collects unique message IDs from threading headers', () => {
    expect(messageReferenceIds(
      '<root@example.com>',
      '<reply@example.com>',
      '<root@example.com> <parent@example.com>',
    )).toEqual([
      '<root@example.com>',
      '<reply@example.com>',
      '<parent@example.com>',
    ])
  })

  it('handles missing threading headers', () => {
    expect(messageReferenceIds(null, undefined, '')).toEqual([])
  })
})
