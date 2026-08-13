const REQUIRED_MIGRATION = '0020_device_token_scopes.sql'
const schemaChecks = new WeakMap<D1Database, Promise<void>>()

function appliedMigration(db: D1Database) {
  return db.prepare(
    'SELECT 1 AS applied FROM d1_migrations WHERE name = ? LIMIT 1',
  ).bind(REQUIRED_MIGRATION).first<{ applied: number }>()
}

function migrationError(cause?: unknown): Error {
  const detail = cause instanceof Error ? ` ${cause.message}` : ''
  return new Error(
    `D1 数据库迁移未完成，请在部署前运行 npm run db:migrate。`
      + ` 缺少迁移：${REQUIRED_MIGRATION}。${detail}`,
  )
}

async function ensureRequiredMigration(db: D1Database): Promise<void> {
  if (await appliedMigration(db)) return

  try {
    await db.batch([
      db.prepare(
        "ALTER TABLE device_sessions ADD COLUMN scopes TEXT NOT NULL DEFAULT '*'",
      ),
      db.prepare(
        `INSERT INTO d1_migrations (name)
         SELECT ? WHERE NOT EXISTS (
           SELECT 1 FROM d1_migrations WHERE name = ?
         )`,
      ).bind(REQUIRED_MIGRATION, REQUIRED_MIGRATION),
    ])
  } catch (error) {
    // Another isolate may have completed the migration after our first check.
    if (await appliedMigration(db)) return
    throw error
  }
}

export function ensureSchema(db: D1Database): Promise<void> {
  const current = schemaChecks.get(db)
  if (current) return current

  const check = ensureRequiredMigration(db).catch((error) => {
    schemaChecks.delete(db)
    if (error instanceof Error && error.message.startsWith('D1 数据库迁移未完成')) {
      throw error
    }
    throw migrationError(error)
  })

  schemaChecks.set(db, check)
  return check
}
