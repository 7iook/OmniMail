import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api-client'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('API request timeouts', () => {
  it('uses the extended timeout for slow attachment and translation operations', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      attachment: {},
      translation: {},
    })))

    await api.uploadDraftAttachment('draft-1', new File(['x'], 'x.txt'))
    await api.translateMessage('message-1', 'en')

    expect(timeout).toHaveBeenCalledWith(60_000)
    expect(timeout).not.toHaveBeenCalledWith(15_000)
  })
})
