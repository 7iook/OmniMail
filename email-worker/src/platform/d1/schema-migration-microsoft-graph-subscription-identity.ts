export const MICROSOFT_GRAPH_SUBSCRIPTION_IDENTITY_MIGRATION = '0038_microsoft_graph_subscription_identity.sql'

/**
 * Separates remote subscription identity from the local scheduling record.
 *
 * `subscription_id` becomes nullable: NULL means "no remote subscription exists
 * for this row" (creation refused, or not yet attempted), so a rejected row can
 * carry its 24 h backoff without inventing a sentinel id that other code paths
 * might send to Graph. Uniqueness moves to a partial index; an `active` row must
 * always hold a remote id. Rebuild is guarded by an empty-table assertion, like
 * 0036. Must produce the same shape as the .sql file.
 */
export const MICROSOFT_GRAPH_SUBSCRIPTION_IDENTITY_RECOVERY = {
  name: MICROSOFT_GRAPH_SUBSCRIPTION_IDENTITY_MIGRATION,
  statements: [
    `CREATE TABLE _migration_0038_guard (
      ok INTEGER NOT NULL CHECK (ok = 1)
    )`,
    `INSERT INTO _migration_0038_guard (ok)
     SELECT CASE WHEN (SELECT count(*) FROM microsoft_graph_subscriptions) = 0 THEN 1 ELSE 0 END`,
    `DROP TABLE _migration_0038_guard`,
    `DROP INDEX IF EXISTS idx_microsoft_graph_subscriptions_due`,
    `DROP TABLE microsoft_graph_subscriptions`,
    `CREATE TABLE microsoft_graph_subscriptions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES microsoft_imap_accounts(id) ON DELETE CASCADE,
      folder_path TEXT NOT NULL,
      subscription_id TEXT CHECK (subscription_id IS NULL OR subscription_id != ''),
      client_state_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'stale', 'rejected')),
      failure_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      refresh_state TEXT NOT NULL DEFAULT 'idle'
        CHECK (refresh_state IN ('idle', 'queued', 'running')),
      refresh_pending INTEGER NOT NULL DEFAULT 0 CHECK (refresh_pending IN (0, 1)),
      refresh_state_at INTEGER NOT NULL DEFAULT 0,
      last_notified_at INTEGER,
      last_error_code TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (status != 'active' OR subscription_id IS NOT NULL),
      UNIQUE (account_id, folder_path)
    )`,
    `CREATE UNIQUE INDEX idx_microsoft_graph_subscriptions_remote
      ON microsoft_graph_subscriptions (subscription_id)
      WHERE subscription_id IS NOT NULL`,
    `CREATE INDEX idx_microsoft_graph_subscriptions_due
      ON microsoft_graph_subscriptions (next_attempt_at, expires_at)`,
  ],
} as const
