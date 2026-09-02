-- 0038_microsoft_graph_subscription_identity.sql
-- Microsoft Graph 推送：把「远端订阅身份」与「本地调度记录」分开。
-- 决策卡：.agent-workspace/.archive/2026-09-01/microsoft-graph-channel/
--          microsoft-graph-channel-decision-card.md §12（C-2 / C-5）· 复审 review3 新发现 #1
--
-- 0037 把 subscription_id 定为 NOT NULL UNIQUE，于是「创建被微软拒绝、只需记住 24h 后再试」
-- 的行没有合法表示，实现只能塞一个 `pending:<uuid>` 哨兵串 —— 而哨兵在 rebuild / teardown
-- 路径被当作真 id 发给了 Graph（无效 DELETE）。上游修法：subscription_id 允许 NULL，
-- NULL = 尚无远端身份；唯一性改为部分唯一索引。类型层随之变为 string | null，
-- 编译器会找出每一个必须处理「无远端身份」的读取点。
--
-- SQLite 无法 ALTER 掉 NOT NULL，只能重建。
-- ⚠️ 安全前提：本迁移假定 microsoft_graph_subscriptions 为空（0037 于 2026-09-02 刚建表，
--    线上/本地均 0 行）。表非空时下面的断言会让迁移失败并中止，而不是静默丢数据。
CREATE TABLE _migration_0038_guard (
  ok INTEGER NOT NULL CHECK (ok = 1)
);
INSERT INTO _migration_0038_guard (ok)
SELECT CASE WHEN (SELECT count(*) FROM microsoft_graph_subscriptions) = 0 THEN 1 ELSE 0 END;
DROP TABLE _migration_0038_guard;

DROP INDEX IF EXISTS idx_microsoft_graph_subscriptions_due;
DROP TABLE microsoft_graph_subscriptions;

CREATE TABLE microsoft_graph_subscriptions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES microsoft_imap_accounts(id) ON DELETE CASCADE,
  folder_path TEXT NOT NULL,
  -- NULL = no remote subscription exists for this row (create refused / not yet created).
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
  -- An active row must carry a remote identity; only rejected/stale rows may lack one.
  CHECK (status != 'active' OR subscription_id IS NOT NULL),
  UNIQUE (account_id, folder_path)
);

CREATE UNIQUE INDEX idx_microsoft_graph_subscriptions_remote
  ON microsoft_graph_subscriptions (subscription_id)
  WHERE subscription_id IS NOT NULL;

CREATE INDEX idx_microsoft_graph_subscriptions_due
  ON microsoft_graph_subscriptions (next_attempt_at, expires_at);
