import { describe, expect, it, vi } from 'vitest'
import { releaseStorage, reserveStorage } from './message-storage'

function database(changes: number) {
  const run = vi.fn().mockResolvedValue({ meta: { changes } })
  const bind = vi.fn(() => ({ run }))
  const prepare = vi.fn(() => ({ bind }))
  return {
    db: { prepare } as unknown as D1Database,
    prepare,
    bind,
    run,
  }
}

describe('message storage quota', () => {
  it('reserves space only when the atomic quota update succeeds', async () => {
    const available = database(1)
    await expect(reserveStorage(available.db, 'user-1', 4096)).resolves.toBe(true)
    expect(available.bind).toHaveBeenCalledWith(4096, 'user-1', 4096)
    expect(String(available.prepare.mock.calls[0][0])).toContain('storage_quota_bytes = 0')

    const full = database(0)
    await expect(reserveStorage(full.db, 'user-1', 4096)).resolves.toBe(false)
  })

  it('never lets released usage fall below zero', async () => {
    const mocked = database(1)
    await releaseStorage(mocked.db, 'user-1', 4096)
    expect(String(mocked.prepare.mock.calls[0][0])).toContain('MAX(0, storage_used_bytes - ?)')
    expect(mocked.bind).toHaveBeenCalledWith(4096, 'user-1')
  })
})
