import { describe, expect, it, vi } from 'vitest'
import { ensureSchema } from './schema'

function database(result: { applied: number } | null, error?: Error) {
  const first = vi.fn(async () => {
    if (error) throw error
    return result
  })
  const bind = vi.fn(() => ({ first }))
  const prepare = vi.fn(() => ({ bind, first }))
  const batch = vi.fn(async () => [])
  return {
    db: { prepare, batch } as unknown as D1Database,
    prepare,
    bind,
    first,
    batch,
  }
}

describe('D1 migration check', () => {
  it('checks the required Wrangler migration once per binding', async () => {
    const fixture = database({ applied: 1 })
    await ensureSchema(fixture.db)
    await ensureSchema(fixture.db)

    expect(fixture.prepare).toHaveBeenCalledOnce()
    expect(fixture.prepare).toHaveBeenCalledWith(
      'SELECT 1 AS applied FROM d1_migrations WHERE name = ? LIMIT 1',
    )
    expect(fixture.bind).toHaveBeenCalledWith(
      '0020_device_token_scopes.sql',
    )
    expect(fixture.batch).not.toHaveBeenCalled()
  })

  it('applies and records the required migration when it is missing', async () => {
    const fixture = database(null)
    await ensureSchema(fixture.db)

    expect(fixture.batch).toHaveBeenCalledOnce()
    expect(fixture.prepare).toHaveBeenCalledWith(
      "ALTER TABLE device_sessions ADD COLUMN scopes TEXT NOT NULL DEFAULT '*'",
    )
    expect(fixture.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO d1_migrations (name)'),
    )
    expect(fixture.bind).toHaveBeenCalledWith(
      '0020_device_token_scopes.sql',
      '0020_device_token_scopes.sql',
    )
  })

  it('accepts a concurrent migration completed by another isolate', async () => {
    const fixture = database(null)
    fixture.first
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ applied: 1 })
    fixture.batch.mockRejectedValueOnce(new Error('duplicate column name: scopes'))

    await expect(ensureSchema(fixture.db)).resolves.toBeUndefined()
  })

  it('adds context when the migration table cannot be queried', async () => {
    const fixture = database(null, new Error('no such table: d1_migrations'))
    await expect(ensureSchema(fixture.db)).rejects.toThrow(
      'no such table: d1_migrations',
    )
  })
})
