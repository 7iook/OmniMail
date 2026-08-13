import { describe, expect, it } from 'vitest'
import { parseICloudAliases } from './icloud-apple'

describe('iCloud Hide My Email response parsing', () => {
  it('normalizes aliases and sorts active entries first', () => {
    expect(parseICloudAliases({ result: { hmeEmails: [
      { hme: 'OFF@icloud.com', anonymousId: '2', label: 'Old', state: 'inactive' },
      { hme: 'Shop@icloud.com', anonymousId: '1', metaData: { label: 'Shop' } },
    ] } })).toEqual([
      expect.objectContaining({ email: 'shop@icloud.com', label: 'Shop', active: true }),
      expect.objectContaining({ email: 'off@icloud.com', label: 'Old', active: false }),
    ])
  })

  it('ignores malformed entries', () => {
    expect(parseICloudAliases({ result: { hmeEmails: [{ label: 'missing' }] } }))
      .toEqual([])
  })
})
