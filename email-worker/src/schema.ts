const REQUIRED_MIGRATION = '0018_schema_baseline_and_message_indexes.sql'
const schemaChecks = new WeakMap<D1Database, Promise<void>>()

function migrationError(cause?: unknown): Error {
  const detail = cause instanceof Error ? ` ${cause.message}` : ''
  return new Error(
    `D1 数据库迁移未完成，请在部署前运行 npm run db:migrate。`
      + ` 缺少迁移：${REQUIRED_MIGRATION}。${detail}`,
  )
}

export function ensureSchema(db: D1Database): Promise<void> {
  const current = schemaChecks.get(db)
  if (current) return current

  const check = db.prepare(
    'SELECT 1 AS applied FROM d1_migrations WHERE name = ? LIMIT 1',
  ).bind(REQUIRED_MIGRATION).first<{ applied: number }>()
    .then((row) => {
      if (!row) throw migrationError()
    })
    .catch((error) => {
      schemaChecks.delete(db)
      if (error instanceof Error && error.message.startsWith('D1 数据库迁移未完成')) {
        throw error
      }
      throw migrationError(error)
    })

  schemaChecks.set(db, check)
  return check
}
