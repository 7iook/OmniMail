import { expireTemporaryAccounts } from './account-api'
import { permanentlyDeleteMessage } from './message-storage'
import { ensureSchema } from './schema'
import { retentionValues, startScheduledBackup } from './storage-policy'
import type { Env } from './types'

async function claimRetentionCleanup(db: D1Database, now: number): Promise<boolean> {
  const result = await db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ('last_retention_cleanup_at', ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at
     WHERE CAST(settings.value AS INTEGER) <= ?`,
  ).bind(String(now), now, now - 6 * 60 * 60).run()
  return Boolean(result.meta.changes)
}

async function purgeMessages(
  env: Env,
  where: string,
  cutoff: number,
): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.raw_key, m.body_key, m.quota_bytes, mb.user_id
       FROM messages m
       JOIN mailboxes mb ON mb.address = m.mailbox_address
      WHERE ${where}
      ORDER BY m.updated_at, m.id
      LIMIT 25`,
  ).bind(cutoff).all<{
    id: string
    raw_key: string | null
    body_key: string | null
    quota_bytes: number
    user_id: string
  }>()
  for (const message of results) {
    await permanentlyDeleteMessage(env, message.user_id, message)
  }
}

async function purgeTemporaryAccountData(
  env: Env,
  cutoff: number,
): Promise<void> {
  const { results: users } = await env.DB.prepare(
    `SELECT id FROM users
      WHERE role = 'temporary' AND deleted_at IS NOT NULL AND deleted_at <= ?
      ORDER BY deleted_at, id
      LIMIT 5`,
  ).bind(cutoff).all<{ id: string }>()
  for (const user of users) {
    while (true) {
      const { results: messages } = await env.DB.prepare(
        `SELECT m.id, m.raw_key, m.body_key, m.quota_bytes
           FROM messages m
           JOIN mailboxes mb ON mb.address = m.mailbox_address
          WHERE mb.user_id = ?
          ORDER BY m.id
          LIMIT 25`,
      ).bind(user.id).all<{
        id: string
        raw_key: string | null
        body_key: string | null
        quota_bytes: number
      }>()
      if (!messages.length) break
      for (const message of messages) {
        await permanentlyDeleteMessage(env, user.id, message)
      }
    }
    await env.DB.prepare(
      `INSERT INTO audit_logs (action, target_id, ip, detail_json)
       VALUES ('account.purge', ?, 'cron', '{"reason":"retention"}')`,
    ).bind(user.id).run()
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run()
  }
}

export async function cleanup(env: Env): Promise<void> {
  await ensureSchema(env.DB)
  const now = Math.floor(Date.now() / 1000)
  await expireTemporaryAccounts(env, now)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM device_sessions WHERE refresh_expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM login_attempts WHERE window_started_at < ?')
      .bind(now - 24 * 60 * 60),
    env.DB.prepare('DELETE FROM registration_attempts WHERE window_started_at < ?')
      .bind(now - 2 * 24 * 60 * 60),
  ])
  await startScheduledBackup(env, now)
  if (!await claimRetentionCleanup(env.DB, now)) return

  const policy = await retentionValues(env.DB)
  await purgeMessages(env, 'm.purge_after IS NOT NULL AND m.purge_after <= ?', now)
  await purgeMessages(
    env,
    "m.status = 'failed' AND m.updated_at <= ?",
    now - policy.failedMessageRetentionDays * 24 * 60 * 60,
  )
  await purgeTemporaryAccountData(
    env,
    now - policy.temporaryDataRetentionDays * 24 * 60 * 60,
  )
  await env.DB.batch([
    env.DB.prepare('DELETE FROM audit_logs WHERE created_at < ?')
      .bind(now - policy.auditRetentionDays * 24 * 60 * 60),
    env.DB.prepare('DELETE FROM backup_runs WHERE started_at < ?')
      .bind(now - 400 * 24 * 60 * 60),
  ])
}
