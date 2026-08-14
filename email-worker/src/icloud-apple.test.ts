import { afterEach, describe, expect, it, vi } from 'vitest'
import { ICloudClient, ICloudRemoteError, parseICloudAliases } from './icloud-apple'

afterEach(() => vi.restoreAllMocks())

function validationResponse(): Response {
  return Response.json({
    webservices: { premiummailsettings: { url: 'https://p71-maildomainws.icloud.com' } },
    dsInfo: { dsid: '123', appleId: 'person@icloud.com' },
  })
}

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

  it('retries a read request after a transient Apple failure', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(validationResponse())
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ result: { hmeEmails: [] } }))

    await expect(new ICloudClient({ session: 'value' }, 'icloud.com').listAliases())
      .resolves.toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('never retries an alias reservation request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(validationResponse())
      .mockResolvedValueOnce(Response.json({
        success: true,
        result: { hme: { hme: 'alias@icloud.com' } },
      }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))

    await expect(new ICloudClient({ session: 'value' }, 'icloud.com').createAlias('Shop'))
      .rejects.toBeInstanceOf(ICloudRemoteError)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('maps request timeouts without exposing transport details', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new DOMException('internal transport details', 'TimeoutError'),
    )

    await expect(new ICloudClient({ session: 'value' }, 'icloud.com').validate())
      .rejects.toMatchObject({ status: 504, message: '连接 iCloud 超时。' })
  })
})
