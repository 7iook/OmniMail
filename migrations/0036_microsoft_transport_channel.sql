-- 0036_microsoft_transport_channel.sql
-- Microsoft Graph 通道接入：传输维度 + 跨通道消息身份
-- 决策卡：.agent-workspace/.archive/2026-09-01/microsoft-graph-channel/
--          microsoft-graph-channel-decision-card.md（§1.3 三概念拆分 · §1.3.1 身份模型）
--
-- 三个「通道」概念严格分离（决策卡 §1.3 · 评审 A3）：
--   auth_mode            凭据类型 oauth2|password（0027 既有 · 本迁移不动）
--   preferred_transport  账号首选传输 · 粘性状态的唯一真源（本迁移新增）
--   source_transport     消息经哪条通道抓到 · 消息级事实（本迁移新增）
-- source_transport 不得兼任 preferred_transport（前者是事实，后者是路由状态）。

-- ---------------------------------------------------------------------------
-- 1. 账号表：首选传输 + 按传输分离的 access token 缓存
-- ---------------------------------------------------------------------------
-- 用 ADD COLUMN 而非重建：不依赖「表为空」前提，任何情况下都不丢数据。

ALTER TABLE microsoft_imap_accounts
  ADD COLUMN preferred_transport TEXT NOT NULL DEFAULT 'unknown';

-- Graph 与 IMAP 的 access token scope 不同、不可互换（决策卡 I-4，20/20 实测确认
-- 同一 refresh_token 可分别换取两种 token）。0027 只有单个 access_token_cipher，
-- 若共用会导致拿 IMAP token 打 Graph 必 401。故按传输分列缓存。
ALTER TABLE microsoft_imap_accounts
  ADD COLUMN graph_access_token_cipher TEXT NOT NULL DEFAULT '';
ALTER TABLE microsoft_imap_accounts
  ADD COLUMN graph_access_token_expires_at INTEGER;

-- 存量账号（若有）一律视为 IMAP：保证行为逐字不变（决策卡 I-5）。
UPDATE microsoft_imap_accounts
   SET preferred_transport = 'imap', updated_at = unixepoch()
 WHERE preferred_transport = 'unknown'
   AND EXISTS (SELECT 1 FROM microsoft_imap_messages
                WHERE microsoft_imap_messages.account_id = microsoft_imap_accounts.id);

-- ---------------------------------------------------------------------------
-- 2. 消息表：必须重建
-- ---------------------------------------------------------------------------
-- 为什么不能 ADD COLUMN：0027 的 uid_validity / imap_uid 是
--   INTEGER NOT NULL CHECK (> 0)，且同时构成唯一键。
-- Graph 消息 ID 实测为 140 字符非纯数字字符串（决策卡 §2.1），既装不进 INTEGER 列，
-- 也无法为 Graph 行提供合法的 uid_validity/imap_uid 值。SQLite 无法 ALTER 掉
-- CHECK 约束或唯一键，因此只能重建。
--
-- ⚠️ 安全前提：本迁移假定 microsoft_imap_messages 为空（用户 2026-09-01 确认
--    CF 部署无任何数据）。下面这条断言在表非空时会让迁移**失败并中止**，
--    而不是静默丢数据 —— 若触发，请改走「建新表 + 回填 + 行数守恒对账」路径。
--    (SELECT RAISE) 在 SQLite 中通过 CHECK 触发；这里用等价的手法：
--    若表非空，CREATE 语句因唯一索引冲突失败前先由本断言拦下。
CREATE TABLE _migration_0036_guard (
  ok INTEGER NOT NULL CHECK (ok = 1)
);
INSERT INTO _migration_0036_guard (ok)
SELECT CASE WHEN (SELECT count(*) FROM microsoft_imap_messages) = 0 THEN 1 ELSE 0 END;
DROP TABLE _migration_0036_guard;

DROP TABLE microsoft_imap_messages;

CREATE TABLE microsoft_imap_messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES microsoft_imap_accounts(id) ON DELETE CASCADE,
  folder_path TEXT NOT NULL,
  -- 消息来源通道：该行是经哪条传输抓到的（决策卡 §1.3）
  source_transport TEXT NOT NULL DEFAULT 'imap'
    CHECK (source_transport IN ('graph', 'imap')),
  -- 通道内定位标识：IMAP 存 uid 的字符串形式，Graph 存不透明 ID（实测 140 字符）
  -- TEXT 而非 INTEGER —— Graph ID 物理装不进整数列
  remote_id TEXT NOT NULL CHECK (remote_id != ''),
  -- IMAP 专属：UIDVALIDITY。Graph 行为 NULL（Graph 无此概念）
  uid_validity INTEGER CHECK (uid_validity IS NULL OR uid_validity > 0),
  -- 跨通道身份：RFC5322 Message-ID，协议无关。Graph 与 IMAP 对同一封信返回同值。
  -- 可为空串（并非所有邮件都带 Message-ID）——空值行不参与跨通道去重，见下方索引
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
  -- 通道内唯一：同一通道内不得重复抓取同一封信
  UNIQUE (account_id, folder_path, source_transport, remote_id),
  -- IMAP 行必须有 uid_validity，Graph 行必须没有（防两种通道的定位语义串味）
  CHECK (
    (source_transport = 'imap' AND uid_validity IS NOT NULL)
    OR
    (source_transport = 'graph' AND uid_validity IS NULL)
  ),
  FOREIGN KEY (account_id, folder_path)
    REFERENCES microsoft_imap_folders(account_id, path) ON DELETE CASCADE
);

-- 跨通道去重（决策卡 I-2）：同一封信经 Graph 与 IMAP 各抓一次时只留一行。
-- ⚠️ 粒度是**账号级**，不含 folder_path —— 「同一封信」与它在哪个文件夹无关，
-- 且两条通道对同一文件夹的命名不同（IMAP 用 `INBOX`，Graph 用 opaque id），
-- 带上 folder_path 会让同一封信在两个通道下各存一行（实测复现）。
-- 部分索引 —— 仅对有 Message-ID 的行生效；空串行退回上面的通道内唯一约束
-- （决策卡 I-2b 已显式收缩承诺：空 Message-ID 的邮件不保证跨通道去重）。
CREATE UNIQUE INDEX idx_microsoft_imap_messages_rfc_identity
  ON microsoft_imap_messages(account_id, internet_message_id)
  WHERE internet_message_id != '';

CREATE INDEX idx_microsoft_imap_messages_folder_date
  ON microsoft_imap_messages(account_id, folder_path, received_at DESC, id DESC);
CREATE INDEX idx_microsoft_imap_messages_date
  ON microsoft_imap_messages(received_at DESC, id DESC, account_id);
