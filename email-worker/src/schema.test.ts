import { describe, expect, it, vi } from 'vitest'
import { ensureSchema } from './schema'

function database(result: { applied: number } | null, error?: Error) {
  const first = vi.fn(async () => {
    if (error) throw error
    return result
  })
  const bind = vi.fn(() => ({ first }))
  const prepare = vi.fn(() => ({ bind }))
  return { db: { prepare } as unknown as D1Database, prepare, bind, first }
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
      '0019_extension_authorization.sql',
    )
  })

  it('fails clearly when migrations were not applied', async () => {
    const fixture = database(null)
    await expect(ensureSchema(fixture.db)).rejects.toThrow(
      'D1 数据库迁移未完成，请在部署前运行 npm run db:migrate。',
    )
  })

  it('adds context when the migration table cannot be queried', async () => {
    const fixture = database(null, new Error('no such table: d1_migrations'))
    await expect(ensureSchema(fixture.db)).rejects.toThrow(
      'no such table: d1_migrations',
    )
  })
})
