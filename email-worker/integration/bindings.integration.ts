import { env } from 'cloudflare:workers'
import {
  applyD1Migrations,
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import worker from '../src/index'
import { sha256 } from '../src/auth'
import { EXTENSION_DEVICE_SCOPES } from '../src/token-scope'
import type { Env as OmniMailEnv, MailQueueJob } from '../src/types'

declare global {
  namespace Cloudflare {
    interface Env extends OmniMailEnv {
      TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>
    }
  }
}

beforeAll(async () => {
  await applyD1Migrations(
    env.DB,
    env.TEST_MIGRATIONS.filter(({ name }) => name !== '0020_device_token_scopes.sql'),
  )
  await env.DB.prepare(
    `INSERT INTO users (
      id, email, display_name, password_hash, role, mailbox_limit,
      storage_quota_bytes, can_create_mailboxes, can_reply
    ) VALUES ('worker-user', 'worker@example.com', 'Worker', 'test', 'user', 1, 1024, 1, 0)`,
  ).run()
})

describe('Worker storage bindings', () => {
  it('self-applies the device scope migration and preserves legacy permissions', async () => {
    const before = await env.DB.prepare(
      "SELECT name, dflt_value FROM pragma_table_info('device_sessions') WHERE name = 'scopes'",
    ).first<{ name: string; dflt_value: string }>()
    expect(before).toBeNull()

    const response = await worker.fetch(
      new Request('https://mail.example.com/api/config'),
      env,
      createExecutionContext(),
    )
    expect(response.status).toBe(200)

    const migration = await env.DB.prepare(
      'SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1',
    ).first<{ name: string }>()
    const columns = await env.DB.prepare(
      "SELECT name, dflt_value FROM pragma_table_info('device_sessions') WHERE name = 'scopes'",
    ).first<{ name: string; dflt_value: string }>()

    expect(migration?.name).toBe('0020_device_token_scopes.sql')
    expect(columns).toMatchObject({ name: 'scopes', dflt_value: "'*'" })

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
    const recorded = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM d1_migrations WHERE name = ?',
    ).bind('0020_device_token_scopes.sql').first<{ count: number }>()
    expect(recorded?.count).toBe(1)
  })

  it('uses real D1, R2, and Queue bindings inside workerd', async () => {
    await env.MAIL_BUCKET.put('integration/body.json', JSON.stringify({ text: 'hello' }))
    await env.MAIL_QUEUE.send({ kind: 'index', messageId: 'integration-message' } satisfies MailQueueJob)
    const batch = createMessageBatch<MailQueueJob>('omnimail-mail', [{
      id: 'queue-message',
      timestamp: new Date(),
      attempts: 1,
      body: { kind: 'index', messageId: 'missing-message' },
    }])
    const context = createExecutionContext()
    await worker.queue(batch, env)
    const queueResult = await getQueueResult(batch, context)

    const user = await env.DB.prepare(
      "SELECT email FROM users WHERE id = 'worker-user'",
    ).first<{ email: string }>()
    const object = await env.MAIL_BUCKET.get('integration/body.json')

    expect(user?.email).toBe('worker@example.com')
    await expect(object?.json()).resolves.toEqual({ text: 'hello' })
    expect(queueResult.explicitAcks).toContain('queue-message')
  })

  it('enforces extension scopes at the Worker API boundary', async () => {
    const accessToken = `om_at_${'a'.repeat(43)}`
    const refreshToken = `om_rt_${'b'.repeat(43)}`
    const now = Math.floor(Date.now() / 1000)
    await env.DB.prepare(
      `INSERT INTO device_sessions (
        id, user_id, device_name, access_token_hash, access_expires_at,
        refresh_token_hash, refresh_expires_at, last_used_at, scopes
      ) VALUES (?, ?, 'OmniMail Float', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      'extension-session',
      'worker-user',
      await sha256(accessToken),
      now + 900,
      await sha256(refreshToken),
      now + 3600,
      now,
      EXTENSION_DEVICE_SCOPES,
    ).run()

    const request = (path: string) => new Request(`https://mail.example.com${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const context = createExecutionContext()
    const allowed = await worker.fetch(request('/api/mailboxes'), env, context)
    const denied = await worker.fetch(request('/api/admin/users'), env, context)

    expect(allowed.status).toBe(200)
    expect(denied.status).toBe(403)
    await expect(denied.json()).resolves.toMatchObject({
      error: '当前设备令牌没有执行此操作的权限。',
    })

    const refreshed = await worker.fetch(new Request(
      'https://mail.example.com/api/auth/token/refresh',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      },
    ), env, context)
    await expect(refreshed.json()).resolves.toMatchObject({
      scopes: EXTENSION_DEVICE_SCOPES.split(' '),
    })
    const session = await env.DB.prepare(
      "SELECT scopes FROM device_sessions WHERE id = 'extension-session'",
    ).first<{ scopes: string }>()
    expect(session?.scopes).toBe(EXTENSION_DEVICE_SCOPES)
  })

  it('rate-limits setup and hides the administrator email after completion', async () => {
    const before = await worker.fetch(
      new Request('https://mail.example.com/api/config'),
      env,
      createExecutionContext(),
    )
    await expect(before.json()).resolves.toMatchObject({
      setupComplete: false,
      superAdminEmail: 'owner@example.com',
    })

    const setupRequest = (token: string, ip: string) => new Request(
      'https://mail.example.com/api/setup',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
        body: JSON.stringify({
          displayName: 'Owner',
          password: 'strong-password',
          setupToken: token,
        }),
      },
    )
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rejected = await worker.fetch(
        setupRequest('wrong-token', '192.0.2.1'),
        env,
        createExecutionContext(),
      )
      expect(rejected.status).toBe(403)
    }
    const limited = await worker.fetch(
      setupRequest('wrong-token', '192.0.2.1'),
      env,
      createExecutionContext(),
    )
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)

    const completed = await worker.fetch(
      setupRequest(env.SETUP_TOKEN!, '192.0.2.2'),
      env,
      createExecutionContext(),
    )
    expect(completed.status).toBe(201)
    const after = await worker.fetch(
      new Request('https://mail.example.com/api/config'),
      env,
      createExecutionContext(),
    )
    await expect(after.json()).resolves.toMatchObject({
      setupComplete: true,
      superAdminEmail: '',
    })
  })
})
