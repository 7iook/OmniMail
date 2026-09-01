export const MICROSOFT_TRANSPORT_CHANNEL_MIGRATION = '0036_microsoft_transport_channel.sql'

/**
 * Adds the transport dimension to the Microsoft mail tables so a Graph API
 * channel can coexist with IMAP.
 *
 * Three concepts stay strictly separate — conflating them is what makes the
 * reference implementation's channel state unreadable:
 *   auth_mode            credential shape (oauth2 | password) — untouched here
 *   preferred_transport   account-level sticky routing, sole source of truth
 *   source_transport      per-message fact: which channel fetched this row
 *
 * The accounts table is extended with ADD COLUMN so it never depends on the
 * table being empty. The messages table must be rebuilt: its uid_validity and
 * imap_uid columns are INTEGER NOT NULL CHECK (> 0) and together form the unique
 * key, and SQLite cannot ALTER those away — while a Graph message id is a
 * ~140-char non-numeric string that fits neither the type nor the constraint.
 * The rebuild is guarded: on a non-empty table the guard's CHECK fails and the
 * migration aborts rather than silently dropping rows.
 */
export const MICROSOFT_TRANSPORT_CHANNEL_RECOVERY = {
  name: MICROSOFT_TRANSPORT_CHANNEL_MIGRATION,
  statements: [
    `ALTER TABLE microsoft_imap_accounts
     ADD COLUMN preferred_transport TEXT NOT NULL DEFAULT 'unknown'`,
    `ALTER TABLE microsoft_imap_accounts
     ADD COLUMN graph_access_token_cipher TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE microsoft_imap_accounts
     ADD COLUMN graph_access_token_expires_at INTEGER`,
    `UPDATE microsoft_imap_accounts
     SET preferred_transport = 'imap', updated_at = unixepoch()
     WHERE preferred_transport = 'unknown'
       AND EXISTS (SELECT 1 FROM microsoft_imap_messages
                    WHERE microsoft_imap_messages.account_id = microsoft_imap_accounts.id)`,
    // Abort rather than silently drop data if the table is not empty.
    // Verified: empty table passes, non-empty fails with "CHECK constraint failed".
    `CREATE TABLE _migration_0036_guard (ok INTEGER NOT NULL CHECK (ok = 1))`,
    `INSERT INTO _migration_0036_guard (ok)
     SELECT CASE WHEN (SELECT count(*) FROM microsoft_imap_messages) = 0 THEN 1 ELSE 0 END`,
    `DROP TABLE _migration_0036_guard`,
    `DROP TABLE microsoft_imap_messages`,
    `CREATE TABLE microsoft_imap_messages (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES microsoft_imap_accounts(id) ON DELETE CASCADE,
      folder_path TEXT NOT NULL,
      source_transport TEXT NOT NULL DEFAULT 'imap'
        CHECK (source_transport IN ('graph', 'imap')),
      remote_id TEXT NOT NULL CHECK (remote_id != ''),
      uid_validity INTEGER CHECK (uid_validity IS NULL OR uid_validity > 0),
      internet_message_id TEXT NOT NULL DEFAULT '',
      sender_name TEXT NOT NULL DEFAULT '',
      sender_address TEXT NOT NULL DEFAULT '',
      recipients_json TEXT NOT NULL DEFAULT '[]',
      cc_json TEXT NOT NULL DEFAULT '[]',
      subject TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      received_at INTEGER NOT NULL,
      sent_at INTEGER,
      size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
      flags_json TEXT NOT NULL DEFAULT '[]',
      is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
      is_starred INTEGER NOT NULL DEFAULT 0 CHECK (is_starred IN (0, 1)),
      has_attachments INTEGER NOT NULL DEFAULT 0 CHECK (has_attachments IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (account_id, folder_path, source_transport, remote_id),
      CHECK (
        (source_transport = 'imap' AND uid_validity IS NOT NULL)
        OR
        (source_transport = 'graph' AND uid_validity IS NULL)
      ),
      FOREIGN KEY (account_id, folder_path)
        REFERENCES microsoft_imap_folders(account_id, path) ON DELETE CASCADE
    )`,
    // Cross-transport dedupe: the same mail fetched over both channels keeps one
    // row. Scoped to the ACCOUNT, deliberately not to the folder — "the same mail"
    // is independent of which folder holds it, and the two transports name the
    // same folder differently (IMAP `INBOX` vs a Graph opaque id), so including
    // folder_path would let one mail persist twice, once per transport.
    // Partial index — rows with an empty Message-ID fall back to the per-transport
    // unique constraint above, a limit that is explicit by design.
    `CREATE UNIQUE INDEX idx_microsoft_imap_messages_rfc_identity
     ON microsoft_imap_messages(account_id, internet_message_id)
     WHERE internet_message_id != ''`,
    `CREATE INDEX idx_microsoft_imap_messages_folder_date
     ON microsoft_imap_messages(account_id, folder_path, received_at DESC, id DESC)`,
    `CREATE INDEX idx_microsoft_imap_messages_date
     ON microsoft_imap_messages(received_at DESC, id DESC, account_id)`,
  ],
}
