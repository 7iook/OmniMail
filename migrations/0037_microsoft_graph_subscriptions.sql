-- 0037_microsoft_graph_subscriptions.sql
-- Microsoft Graph 推送（change notifications）：订阅表
-- 决策卡：.agent-workspace/.archive/2026-09-01/microsoft-graph-channel/
--          microsoft-graph-channel-decision-card.md §12（C-1 / C-2 / C-3 / C-5）
--
-- 一行 = 一个 (账号, 文件夹) 的 Graph 订阅。本地表是「我们认为的状态」，微软侧才是
-- 资源本身（C-2）：cron 用 GET /subscriptions 双向对账，本表不是唯一现实。
--
-- 三组列各管一件事，不得互相兼任：
--   订阅身份   subscription_id / client_state_hash / expires_at
--   调度状态   status / failure_count / next_attempt_at            （C-5：永久拒绝退避 24h，瞬时指数退避）
--   合并状态机 refresh_state / refresh_pending / refresh_state_at  （C-3：idle→queued→running→idle）
--
-- client_state 只存 SHA-256 摘要（C-1）：通知到达时 timing-safe 比较摘要；不存明文、不用 HMAC。
-- 新建表而非重建，无需 0036 那种空表守卫。

CREATE TABLE IF NOT EXISTS microsoft_graph_subscriptions (
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
);

-- 通知路径按 subscription_id 查（UNIQUE 已隐含索引）；对账按到期/下次尝试时间扫描。
CREATE INDEX IF NOT EXISTS idx_microsoft_graph_subscriptions_due
  ON microsoft_graph_subscriptions (next_attempt_at, expires_at);
