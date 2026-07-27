import { expireTemporaryAccounts } from './account-api'
import { ensureSchema } from './schema'
import type { Env } from './types'

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
}
