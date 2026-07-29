import packageMetadata from '../../package.json'
import { writeAudit } from './audit'
import type { Env, SessionUser } from './types'

export type MailRefreshInterval = 0 | 5 | 10 | 30 | 60 | 120

const REFRESH_SETTING = 'mail_refresh_interval'
const REMOTE_IMAGES_SETTING = 'remote_images_enabled'
const UNASSIGNED_MAIL_SETTING = 'unassigned_mail_enabled'
const DEFAULT_REFRESH_INTERVAL: MailRefreshInterval = 30
const REFRESH_INTERVALS = new Set<MailRefreshInterval>([0, 5, 10, 30, 60, 120])
const CURRENT_VERSION = packageMetadata.version
const LATEST_RELEASE_API = 'https://api.github.com/repos/mibgb65-cloud/OmniMail/releases/latest'
const LATEST_RELEASE_URL = 'https://github.com/mibgb65-cloud/OmniMail/releases/latest'

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function isAdministrator(user: SessionUser): boolean {
  return user.role === 'super_admin' || user.role === 'admin'
}

function stableVersion(value: unknown): { value: string; parts: [number, number, number] } | null {
  if (typeof value !== 'string') return null
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim())
  if (!match) return null
  return {
    value: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`,
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
  }
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = stableVersion(candidate)
  const installed = stableVersion(current)
  if (!next || !installed) return false
  for (let index = 0; index < next.parts.length; index += 1) {
    if (next.parts[index] > installed.parts[index]) return true
    if (next.parts[index] < installed.parts[index]) return false
  }
  return false
}

export async function systemVersion(
  actor: SessionUser,
  releaseFetch: typeof fetch = fetch,
): Promise<Response> {
  if (!isAdministrator(actor)) {
    return json({ error: '只有管理员可以检查系统版本。' }, 403)
  }
  const base = {
    currentVersion: CURRENT_VERSION,
    releaseUrl: LATEST_RELEASE_URL,
    checkedAt: Date.now(),
  }
  try {
    const response = await releaseFetch(LATEST_RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `OmniMail/${CURRENT_VERSION}`,
        'X-GitHub-Api-Version': '2026-03-10',
      },
      signal: AbortSignal.timeout(5_000),
      cf: {
        cacheEverything: true,
        cacheTtlByStatus: { '200-299': 3600, 404: 300, '500-599': 0 },
      },
    })
    if (response.status === 404) {
      return json({
        ...base, latestVersion: null, updateAvailable: false, checkFailed: false,
      })
    }
    if (!response.ok) throw new Error(`GitHub release request failed: ${response.status}`)
    const release = await response.json() as { tag_name?: unknown }
    const latest = stableVersion(release.tag_name)
    if (!latest) throw new Error('GitHub release tag is not a stable version')
    return json({
      ...base,
      latestVersion: latest.value,
      updateAvailable: isNewerVersion(latest.value, CURRENT_VERSION),
      checkFailed: false,
    })
  } catch {
    return json({
      ...base, latestVersion: null, updateAvailable: false, checkFailed: true,
    })
  }
}

export function parseMailRefreshInterval(value: unknown): MailRefreshInterval | null {
  return typeof value === 'number' && REFRESH_INTERVALS.has(value as MailRefreshInterval)
    ? value as MailRefreshInterval
    : null
}

export function parseRemoteImagesEnabled(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

export function parseUnassignedMailEnabled(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

export async function mailRefreshInterval(db: D1Database): Promise<MailRefreshInterval> {
  const setting = await db.prepare(
    'SELECT value FROM settings WHERE key = ?',
  ).bind(REFRESH_SETTING).first<{ value: string }>()
  return parseMailRefreshInterval(Number(setting?.value)) ?? DEFAULT_REFRESH_INTERVAL
}

export async function remoteImagesEnabled(db: D1Database): Promise<boolean> {
  const setting = await db.prepare(
    'SELECT value FROM settings WHERE key = ?',
  ).bind(REMOTE_IMAGES_SETTING).first<{ value: string }>()
  return setting?.value === '1'
}

export async function updateMailRefreshInterval(
  env: Env,
  actor: SessionUser,
  request: Request,
  ip: string,
): Promise<Response> {
  if (!isAdministrator(actor)) {
    return json({ error: '只有管理员可以修改自动刷新设置。' }, 403)
  }
  const body = await request.json<{ interval?: unknown }>()
    .catch(() => ({} as { interval?: unknown }))
  const interval = parseMailRefreshInterval(body.interval)
  if (interval === null) {
    return json({ error: '自动刷新档位无效。' }, 400)
  }
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
  ).bind(REFRESH_SETTING, String(interval)).run()
  await writeAudit(env, actor.id, 'system.mail_refresh.update', null, ip, { interval })
  return json({ mailRefreshInterval: interval })
}

export async function updateRemoteImagesSetting(
  env: Env,
  actor: SessionUser,
  request: Request,
  ip: string,
): Promise<Response> {
  if (!isAdministrator(actor)) {
    return json({ error: '只有管理员可以修改远程图片设置。' }, 403)
  }
  const body = await request.json<{ enabled?: unknown }>()
    .catch(() => ({} as { enabled?: unknown }))
  const enabled = parseRemoteImagesEnabled(body.enabled)
  if (enabled === null) {
    return json({ error: '远程图片设置无效。' }, 400)
  }
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
  ).bind(REMOTE_IMAGES_SETTING, enabled ? '1' : '0').run()
  await writeAudit(env, actor.id, 'system.remote_images.update', null, ip, { enabled })
  return json({ remoteImagesEnabled: enabled })
}

export async function updateUnassignedMailSetting(
  env: Env,
  actor: SessionUser,
  request: Request,
  ip: string,
): Promise<Response> {
  if (!isAdministrator(actor)) {
    return json({ error: '只有管理员可以修改无人收件设置。' }, 403)
  }
  const body = await request.json<{ enabled?: unknown }>()
    .catch(() => ({} as { enabled?: unknown }))
  const enabled = parseUnassignedMailEnabled(body.enabled)
  if (enabled === null) {
    return json({ error: '无人收件设置无效。' }, 400)
  }
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
  ).bind(UNASSIGNED_MAIL_SETTING, enabled ? '1' : '0').run()
  await writeAudit(env, actor.id, 'system.unassigned_mail.update', null, ip, { enabled })
  return json({ unassignedMailEnabled: enabled })
}
