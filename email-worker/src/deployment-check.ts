import { normalizeEmail, validEmail } from './api-helpers'
import type { Env, SessionUser } from './types'

export type DeploymentCheckState = 'ready' | 'missing' | 'warning' | 'manual'

export interface DeploymentCheckItem {
  id: string
  group: 'core' | 'security' | 'mail'
  label: string
  state: DeploymentCheckState
  required: boolean
  detail: string
  action: string
}

export interface SetupRequirements {
  databaseReady: boolean
  storageReady: boolean
  queueReady: boolean
  superAdminReady: boolean
  setupTokenReady: boolean
}

function bindingHasMethod(value: unknown, method: string): boolean {
  return Boolean(
    value
    && typeof value === 'object'
    && method in value
    && typeof (value as Record<string, unknown>)[method] === 'function',
  )
}

export function publicSetupRequirements(env: Env): SetupRequirements {
  const superAdmin = normalizeEmail(env.SUPER_ADMIN_EMAIL || '')
  return {
    databaseReady: bindingHasMethod(env.DB, 'prepare'),
    storageReady: bindingHasMethod(env.MAIL_BUCKET, 'get'),
    queueReady: bindingHasMethod(env.MAIL_QUEUE, 'send'),
    superAdminReady: validEmail(superAdmin),
    setupTokenReady: Boolean(env.SETUP_TOKEN?.trim()),
  }
}

function check(
  input: Omit<DeploymentCheckItem, 'state'> & {
    ready: boolean
    missingState?: Exclude<DeploymentCheckState, 'ready'>
  },
): DeploymentCheckItem {
  const { ready, missingState = 'missing', ...item } = input
  return { ...item, state: ready ? 'ready' : missingState }
}

function isAdministrator(user: SessionUser): boolean {
  return user.role === 'super_admin' || user.role === 'admin'
}

async function databaseState(env: Env): Promise<{
  ready: boolean
  setupComplete: boolean
  domains: number
  mailboxes: number
}> {
  if (!bindingHasMethod(env.DB, 'prepare')) {
    return { ready: false, setupComplete: false, domains: 0, mailboxes: 0 }
  }
  try {
    const row = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM domains) AS domains,
        (SELECT COUNT(*) FROM mailboxes) AS mailboxes,
        (SELECT value FROM settings WHERE key = 'setup_complete') AS setup_complete`,
    ).first<{ domains: number; mailboxes: number; setup_complete: string | null }>()
    return {
      ready: Boolean(row),
      setupComplete: row?.setup_complete === '1',
      domains: Number(row?.domains || 0),
      mailboxes: Number(row?.mailboxes || 0),
    }
  } catch {
    return { ready: false, setupComplete: false, domains: 0, mailboxes: 0 }
  }
}

export async function deploymentCheck(env: Env, user: SessionUser): Promise<Response> {
  if (!isAdministrator(user)) {
    return Response.json({ error: '只有管理员可以运行部署自检。' }, { status: 403 })
  }

  const bindings = publicSetupRequirements(env)
  const database = await databaseState(env)
  const turnstileReady = Boolean(
    env.TURNSTILE_SITE_KEY?.trim() && env.TURNSTILE_SECRET_KEY?.trim(),
  )
  const checks: DeploymentCheckItem[] = [
    check({
      id: 'database', group: 'core', label: 'D1 数据库', ready: database.ready,
      required: true, detail: '数据库绑定可访问，表结构可正常读取。',
      action: '检查 wrangler.jsonc 中名为 DB 的 D1 绑定后重新部署。',
    }),
    check({
      id: 'storage', group: 'core', label: 'R2 邮件存储', ready: bindings.storageReady,
      required: true, detail: 'MAIL_BUCKET 用于保存邮件正文、原文与附件。',
      action: '在 Worker 中创建并绑定名为 MAIL_BUCKET 的 R2 Bucket。',
    }),
    check({
      id: 'queue', group: 'core', label: '邮件解析队列', ready: bindings.queueReady,
      required: true, detail: 'MAIL_QUEUE 用于异步解析收到的邮件。',
      action: '重新执行 Git 部署，确认队列 Producer 和 Consumer 已创建。',
    }),
    check({
      id: 'origins', group: 'core', label: '同源前后端', ready: true,
      required: true, detail: '静态前端与 API 由同一个 Worker 域名提供。',
      action: '额外的跨域客户端来源可以通过 APP_ORIGINS 配置。',
    }),
    check({
      id: 'super-admin', group: 'security', label: '主管理员身份',
      ready: bindings.superAdminReady, required: true,
      detail: 'SUPER_ADMIN_EMAIL 已配置为有效邮箱地址。',
      action: '在 Worker Variables & Secrets 中配置 SUPER_ADMIN_EMAIL。',
    }),
    check({
      id: 'setup', group: 'security', label: '主管理员账户',
      ready: database.setupComplete, required: true,
      detail: '首次初始化已经完成，主管理员账户可用。',
      action: '返回首次运行页面，使用 SETUP_TOKEN 创建主管理员账户。',
    }),
    check({
      id: 'secure-cookie', group: 'security', label: '安全 Cookie',
      ready: env.COOKIE_SECURE !== 'false', required: true,
      detail: '登录 Cookie 仅通过 HTTPS 传输。',
      action: '生产环境删除 COOKIE_SECURE=false，或将其改为 true。',
    }),
    check({
      id: 'setup-token', group: 'security', label: '初始化令牌',
      ready: bindings.setupTokenReady, required: false, missingState: 'warning',
      detail: 'SETUP_TOKEN 已作为 Worker Secret 配置。',
      action: '如果已经完成初始化，可以删除 SETUP_TOKEN；重新初始化前需要再次配置。',
    }),
    check({
      id: 'turnstile', group: 'security', label: 'Turnstile 防护',
      ready: turnstileReady, required: false, missingState: 'warning',
      detail: '公开注册与多人邀请可以使用机器人防护。',
      action: '需要开放注册时，同时配置 TURNSTILE_SITE_KEY 和 TURNSTILE_SECRET_KEY。',
    }),
    check({
      id: 'domains', group: 'mail', label: '收件域名', ready: database.domains > 0,
      required: false, missingState: 'warning',
      detail: `OmniMail 中已管理 ${database.domains} 个收件域名。`,
      action: '在系统设置的域名管理中添加至少一个已托管于 Cloudflare 的域名。',
    }),
    check({
      id: 'mailboxes', group: 'mail', label: '收件地址', ready: database.mailboxes > 0,
      required: false, missingState: 'warning',
      detail: `当前已创建 ${database.mailboxes} 个邮箱地址。`,
      action: '添加域名后，为主管理员或其他用户创建收件地址。',
    }),
    check({
      id: 'resend', group: 'mail', label: 'Resend 回信',
      ready: Boolean(env.RESEND_API_KEY?.trim()), required: false, missingState: 'warning',
      detail: 'RESEND_API_KEY 已配置，具备发送回复的条件。',
      action: '不需要回信可以跳过；需要时将 Resend API Key 配置为 Worker Secret。',
    }),
    {
      id: 'email-routing', group: 'mail', label: 'Email Routing',
      state: 'manual', required: false,
      detail: 'Cloudflare 不会把 Email Routing 状态暴露给当前 Worker，需要人工确认。',
      action: '在 Cloudflare Email Routing 中启用域名，并将 Catch-all 规则指向 OmniMail Worker。',
    },
  ]
  const requiredReady = checks.every((item) => !item.required || item.state === 'ready')
  return Response.json({ generatedAt: Date.now(), ready: requiredReady, checks })
}
