import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MICROSOFT_GRAPH_SUBSCRIPTIONS_RECOVERY } from './schema-migration-microsoft-graph-subscriptions'
import { RECOVERABLE_MIGRATIONS, WRANGLER_MIGRATION_NAMES } from './schema-migrations'

/**
 * Executes the migrations for real and asserts the resulting shape.
 *
 * Why this exists: the rest of the D1 suite mocks `batch()`, so it records
 * migration *names* without ever running the SQL. That let a rebuilt table ship
 * alongside six queries against a column it no longer had — the whole suite stayed
 * green because the affected test hand-built its row objects. Anything that only
 * checks names or hand-written fixtures cannot catch that class of defect; only
 * executing the DDL can.
 */

function applyDiskMigrations(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  for (const name of WRANGLER_MIGRATION_NAMES) {
    const sql = readFileSync(`migrations/${name}`, 'utf8')
    try {
      db.exec(sql)
    } catch (error) {
      throw new Error(`migration ${name} failed: ${(error as Error).message}`)
    }
  }
  return db
}

function columns(db: DatabaseSync, table: string): string[] {
  return db.prepare(`SELECT name FROM pragma_table_info('${table}')`)
    .all().map((row) => (row as { name: string }).name).sort()
}

describe('D1 schema shape (real execution, not mocked batches)', () => {
  it('applies every tracked migration in order without error', () => {
    const db = applyDiskMigrations()
    expect(columns(db, 'microsoft_imap_messages').length).toBeGreaterThan(0)
  })

  it('leaves the Microsoft message table addressed by transport, not by IMAP UID', () => {
    const cols = columns(applyDiskMigrations(), 'microsoft_imap_messages')

    expect(cols).toContain('source_transport')
    expect(cols).toContain('remote_id')
    // The column the rebuild removed. Six production queries still read it after
    // 0036 landed; this assertion is what would have caught that.
    expect(cols).not.toContain('imap_uid')
  })

  it('carries the per-transport account columns the token layer selects on', () => {
    const cols = columns(applyDiskMigrations(), 'microsoft_imap_accounts')

    expect(cols).toContain('preferred_transport')
    expect(cols).toContain('graph_access_token_cipher')
    expect(cols).toContain('graph_access_token_expires_at')
    // IMAP's own cache must survive alongside Graph's — the two are not
    // interchangeable, so neither may replace the other.
    expect(cols).toContain('access_token_cipher')
  })

  it('dedupes the same mail across transports at account scope', () => {
    const db = applyDiskMigrations()
    const indexes = db.prepare(
      "SELECT name FROM pragma_index_list('microsoft_imap_messages')",
    ).all().map((row) => (row as { name: string }).name)
    expect(indexes).toContain('idx_microsoft_imap_messages_rfc_identity')

    const keyed = db.prepare(
      "SELECT name FROM pragma_index_info('idx_microsoft_imap_messages_rfc_identity')",
    ).all().map((row) => (row as { name: string | null }).name)
    // folder_path must NOT be part of cross-transport identity: the transports
    // name the same folder differently, so including it lets one mail persist
    // twice, once per transport.
    expect(keyed).toContain('internet_message_id')
    expect(keyed).not.toContain('folder_path')
  })

  it('keys Graph subscriptions by (account, folder) and by remote id, storing only a digest of clientState', () => {
    const db = applyDiskMigrations()
    const cols = columns(db, 'microsoft_graph_subscriptions')

    // Identity group: no plaintext clientState column may exist (card C-1).
    expect(cols).toContain('client_state_hash')
    expect(cols).not.toContain('client_state')
    // Scheduling group (C-5) and coalescing state machine (C-3) are separate columns.
    expect(cols).toEqual(expect.arrayContaining([
      'status', 'failure_count', 'next_attempt_at',
      'refresh_state', 'refresh_pending', 'refresh_state_at',
    ]))

    const uniqueIndexes = db.prepare(
      "SELECT name FROM pragma_index_list('microsoft_graph_subscriptions') WHERE \"unique\" = 1",
    ).all().map((row) => (row as { name: string }).name)
    const uniqueColumnSets = uniqueIndexes.map((index) => db.prepare(
      `SELECT name FROM pragma_index_info('${index}')`,
    ).all().map((row) => (row as { name: string }).name).sort().join(','))
    expect(uniqueColumnSets).toContain('account_id,folder_path')
    expect(uniqueColumnSets).toContain('subscription_id')

    // The runtime twin must produce the same shape as the .sql file: both are
    // hand-kept, and 0036 already showed how easily they can drift.
    const runtime = new DatabaseSync(':memory:')
    runtime.exec('CREATE TABLE microsoft_imap_accounts (id TEXT PRIMARY KEY)')
    for (const statement of MICROSOFT_GRAPH_SUBSCRIPTIONS_RECOVERY.statements) runtime.exec(statement)
    expect(columns(runtime, 'microsoft_graph_subscriptions')).toEqual(cols)
  })

  it('orders runtime recovery the same as the tracked migration list', () => {
    // ensureSchema() treats the LAST tracked migration as proof the whole chain
    // ran, so recovery recording it early would strand everything after it.
    const recovery = RECOVERABLE_MIGRATIONS.map(({ name }) => name)
    const tracked = WRANGLER_MIGRATION_NAMES.filter((name) => recovery.includes(name))
    expect(recovery.filter((name) => tracked.includes(name))).toEqual(tracked)
  })
})
