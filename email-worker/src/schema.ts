const SCHEMA_SQL = String.raw`
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user'
    CHECK (role IN ('super_admin', 'admin', 'user', 'temporary')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  mailbox_limit INTEGER NOT NULL DEFAULT 1 CHECK (mailbox_limit BETWEEN 0 AND 100),
  can_create_mailboxes INTEGER NOT NULL DEFAULT 0 CHECK (can_create_mailboxes IN (0, 1)),
  can_reply INTEGER NOT NULL DEFAULT 0 CHECK (can_reply IN (0, 1)),
  temporary_expires_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS domains (
  name TEXT PRIMARY KEY COLLATE NOCASE,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_domains_active ON domains(is_active, name);

CREATE TABLE IF NOT EXISTS temporary_invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  domain_name TEXT NOT NULL REFERENCES domains(name) ON DELETE RESTRICT,
  expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses IN (0, 1)),
  use_count INTEGER NOT NULL DEFAULT 0,
  address_mode TEXT NOT NULL DEFAULT 'self_selected'
    CHECK (address_mode IN ('assigned', 'self_selected')),
  assigned_address TEXT COLLATE NOCASE,
  account_lifetime_hours INTEGER NOT NULL DEFAULT 24
    CHECK (account_lifetime_hours BETWEEN 1 AND 720),
  mailbox_limit INTEGER NOT NULL DEFAULT 1 CHECK (mailbox_limit BETWEEN 1 AND 100),
  can_create_mailboxes INTEGER NOT NULL DEFAULT 0 CHECK (can_create_mailboxes IN (0, 1)),
  can_reply INTEGER NOT NULL DEFAULT 0 CHECK (can_reply IN (0, 1)),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_temporary_invites_token ON temporary_invites(token_hash);
CREATE INDEX IF NOT EXISTS idx_temporary_invites_created
  ON temporary_invites(created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS device_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL,
  access_token_hash TEXT NOT NULL UNIQUE,
  access_expires_at INTEGER NOT NULL,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  refresh_expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_device_sessions_user
  ON device_sessions(user_id, revoked_at, last_used_at DESC);

CREATE TABLE IF NOT EXISTS login_attempts (
  key_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mailboxes (
  address TEXT PRIMARY KEY COLLATE NOCASE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_mailboxes_user ON mailboxes(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  mailbox_address TEXT NOT NULL COLLATE NOCASE REFERENCES mailboxes(address) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  status TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'failed', 'sent')),
  folder TEXT NOT NULL CHECK (folder IN ('inbox', 'sent', 'trash')),
  message_id TEXT,
  in_reply_to TEXT,
  references_header TEXT,
  sender_name TEXT,
  sender_address TEXT NOT NULL,
  recipients_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  preview TEXT NOT NULL DEFAULT '',
  received_at INTEGER,
  sent_at INTEGER,
  raw_key TEXT,
  body_key TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  has_html INTEGER NOT NULL DEFAULT 0 CHECK (has_html IN (0, 1)),
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
  is_starred INTEGER NOT NULL DEFAULT 0 CHECK (is_starred IN (0, 1)),
  processing_error TEXT,
  client_request_id TEXT UNIQUE,
  provider_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (mailbox_address, message_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_mailbox_folder_date
  ON messages(mailbox_address, folder, received_at DESC, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_mailbox_starred
  ON messages(mailbox_address, is_starred, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_direction_received
  ON messages(direction, received_at DESC);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  content_id TEXT,
  disposition TEXT NOT NULL DEFAULT 'attachment'
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  ip TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_cursor
  ON audit_logs(created_at DESC, id DESC);
`

let schemaReady: Promise<void> | undefined

async function ensureUserPolicyColumns(db: D1Database): Promise<void> {
  const { results } = await db.prepare('PRAGMA table_info(users)').all<{ name: string }>()
  const columns = new Set(results.map((column) => column.name))
  const statements: D1PreparedStatement[] = []
  let policyChanged = false
  if (!columns.has('mailbox_limit')) {
    policyChanged = true
    statements.push(db.prepare(
      'ALTER TABLE users ADD COLUMN mailbox_limit INTEGER NOT NULL DEFAULT 1',
    ))
  }
  if (!columns.has('can_create_mailboxes')) {
    policyChanged = true
    statements.push(db.prepare(
      'ALTER TABLE users ADD COLUMN can_create_mailboxes INTEGER NOT NULL DEFAULT 0',
    ))
  }
  if (!columns.has('can_reply')) {
    policyChanged = true
    statements.push(db.prepare(
      'ALTER TABLE users ADD COLUMN can_reply INTEGER NOT NULL DEFAULT 0',
    ))
  }
  if (!columns.has('temporary_expires_at')) {
    statements.push(db.prepare('ALTER TABLE users ADD COLUMN temporary_expires_at INTEGER'))
  }
  if (!columns.has('deleted_at')) {
    statements.push(db.prepare('ALTER TABLE users ADD COLUMN deleted_at INTEGER'))
  }
  if (!statements.length) return
  await db.batch(statements)
  if (!policyChanged) return
  await db.prepare(
    `UPDATE users
        SET mailbox_limit = MAX(
              mailbox_limit,
              CASE WHEN role IN ('super_admin', 'admin') THEN 20 ELSE 1 END,
              (SELECT COUNT(*) FROM mailboxes WHERE user_id = users.id)
            ),
            can_create_mailboxes = CASE WHEN role IN ('super_admin', 'admin') THEN 1 ELSE 0 END,
            can_reply = CASE WHEN role IN ('super_admin', 'admin') THEN 1 ELSE 0 END`,
  ).run()
}

async function ensureDomains(db: D1Database): Promise<void> {
  const existed = await db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'domains'",
  ).first<{ present: number }>()
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS domains (
      name TEXT PRIMARY KEY COLLATE NOCASE,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,
  ).run()
  await db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_domains_active ON domains(is_active, name)',
  ).run()
  if (!existed) {
    await db.prepare(
      `INSERT OR IGNORE INTO domains (name, is_active)
       SELECT DISTINCT LOWER(SUBSTR(address, INSTR(address, '@') + 1)), 1
         FROM mailboxes`,
    ).run()
  }
}

async function ensureTemporaryInvites(db: D1Database): Promise<void> {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS temporary_invites (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      domain_name TEXT NOT NULL REFERENCES domains(name) ON DELETE RESTRICT,
      expires_at INTEGER NOT NULL,
      max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses IN (0, 1)),
      use_count INTEGER NOT NULL DEFAULT 0,
      address_mode TEXT NOT NULL DEFAULT 'self_selected'
        CHECK (address_mode IN ('assigned', 'self_selected')),
      assigned_address TEXT COLLATE NOCASE,
      account_lifetime_hours INTEGER NOT NULL DEFAULT 24
        CHECK (account_lifetime_hours BETWEEN 1 AND 720),
      mailbox_limit INTEGER NOT NULL DEFAULT 1 CHECK (mailbox_limit BETWEEN 1 AND 100),
      can_create_mailboxes INTEGER NOT NULL DEFAULT 0 CHECK (can_create_mailboxes IN (0, 1)),
      can_reply INTEGER NOT NULL DEFAULT 0 CHECK (can_reply IN (0, 1)),
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      revoked_at INTEGER
    )`,
  ).run()
  const { results } = await db.prepare(
    'PRAGMA table_info(temporary_invites)',
  ).all<{ name: string }>()
  const columns = new Set(results.map((column) => column.name))
  if (!columns.has('address_mode')) {
    await db.prepare(
      `ALTER TABLE temporary_invites ADD COLUMN address_mode TEXT NOT NULL
       DEFAULT 'self_selected' CHECK (address_mode IN ('assigned', 'self_selected'))`,
    ).run()
  }
  if (!columns.has('assigned_address')) {
    await db.prepare(
      'ALTER TABLE temporary_invites ADD COLUMN assigned_address TEXT COLLATE NOCASE',
    ).run()
  }
  if (!columns.has('account_lifetime_hours')) {
    await db.prepare(
      `ALTER TABLE temporary_invites ADD COLUMN account_lifetime_hours
       INTEGER NOT NULL DEFAULT 24 CHECK (account_lifetime_hours BETWEEN 1 AND 720)`,
    ).run()
  }
  await db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_temporary_invites_token ON temporary_invites(token_hash)',
  ).run()
  await db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_temporary_invites_created ON temporary_invites(created_at DESC)',
  ).run()
}

async function ensureDeviceSessions(db: D1Database): Promise<void> {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS device_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_name TEXT NOT NULL,
      access_token_hash TEXT NOT NULL UNIQUE,
      access_expires_at INTEGER NOT NULL,
      refresh_token_hash TEXT NOT NULL UNIQUE,
      refresh_expires_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL DEFAULT (unixepoch()),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      revoked_at INTEGER
    )`,
  ).run()
  await db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_device_sessions_user
     ON device_sessions(user_id, revoked_at, last_used_at DESC)`,
  ).run()
}

export function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const exists = await db.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'settings'",
      ).first<{ present: number }>()
      if (!exists) {
        const statements = SCHEMA_SQL
          .split(';')
          .map((statement) => statement.trim())
          .filter((statement) => statement && !statement.startsWith('PRAGMA'))
          .map((statement) => db.prepare(statement))
        await db.batch(statements)
      } else {
        await ensureUserPolicyColumns(db)
      }
      await ensureDomains(db)
      await ensureTemporaryInvites(db)
      await ensureDeviceSessions(db)
      await db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_messages_direction_received
         ON messages(direction, received_at DESC)`,
      ).run()
      await db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_audit_cursor
         ON audit_logs(created_at DESC, id DESC)`,
      ).run()
    })().catch((error) => {
      schemaReady = undefined
      throw error
    })
  }
  return schemaReady
}
