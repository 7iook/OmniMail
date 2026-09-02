export const MICROSOFT_GRAPH_SUBSCRIPTIONS_MIGRATION = '0037_microsoft_graph_subscriptions.sql'

/**
 * Graph change-notification subscriptions, one row per (account, folder).
 *
 * Three column groups, each owning one concern (decision card §12 C-1/C-3/C-5):
 *   identity    subscription_id / client_state_hash / expires_at
 *   scheduling  status / failure_count / next_attempt_at
 *   coalescing  refresh_state / refresh_pending / refresh_state_at
 *
 * The local row is what we believe; the subscription itself lives on Microsoft's
 * side and is reconciled with GET /subscriptions (C-2). Only the SHA-256 of the
 * clientState is stored (C-1). Must produce the same shape as the .sql file.
 */
export const MICROSOFT_GRAPH_SUBSCRIPTIONS_RECOVERY = {
  name: MICROSOFT_GRAPH_SUBSCRIPTIONS_MIGRATION,
  statements: [
    `CREATE TABLE IF NOT EXISTS microsoft_graph_subscriptions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES microsoft_imap_accounts(id) ON DELETE CASCADE,
      folder_path TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
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
      UNIQUE (account_id, folder_path),
      UNIQUE (subscription_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_microsoft_graph_subscriptions_due
      ON microsoft_graph_subscriptions (next_attempt_at, expires_at)`,
  ],
} as const
