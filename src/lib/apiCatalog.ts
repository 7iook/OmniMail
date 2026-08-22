import { adminAccessEndpoints, adminSettingsEndpoints } from './apiCatalogAdmin'
import { iCloudEndpoints, linuxDoMailEndpoints, adminOperationEndpoints } from './apiCatalogOperations'
import { mailboxEndpoints, messageEndpoints, draftEndpoints } from './apiCatalogMail'
import { systemEndpoints, authEndpoints } from './apiCatalogPublic'
import { localized, type ApiAuth, type ApiEndpoint, type ApiGroupId } from './apiCatalogTypes'

export type { ApiAuth, ApiEndpoint, ApiGroupId, LocalizedText } from './apiCatalogTypes'

export const apiGroups: Array<{
  id: ApiGroupId
  title: ReturnType<typeof localized>
  description: ReturnType<typeof localized>
}> = [
  { id: 'system', title: localized('系统与公开入口', 'System and public entry points'),
    description: localized('健康检查、初始化、注册、邀请落地、代理与 Webhook。', 'Health, setup, registration, invitation, proxy, and webhook endpoints.') },
  { id: 'auth', title: localized('认证与账户', 'Authentication and account'),
    description: localized('网页登录、设备令牌、MFA、扩展授权和账户生命周期。', 'Web login, device tokens, MFA, extension authorization, and account lifecycle.') },
  { id: 'mailboxes', title: localized('域名与邮箱地址', 'Domains and mailboxes'),
    description: localized('读取域名并创建、启停、切换或删除邮箱地址。', 'Read domains and create, enable, switch, or delete mailbox addresses.') },
  { id: 'messages', title: localized('邮件', 'Messages'),
    description: localized('列表、详情、状态、附件、原文、发信、回复和翻译。', 'Lists, details, state, attachments, raw source, sending, replies, and translation.') },
  { id: 'drafts', title: localized('草稿与附件', 'Drafts and attachments'),
    description: localized('服务端草稿的创建、保存、附件和幂等发送。', 'Create, save, attach files to, and idempotently send server drafts.') },
  { id: 'icloud', title: localized('iCloud 隐藏邮箱', 'iCloud Hide My Email'),
    description: localized('iCloud 账号、凭据、隐藏地址和按需收件箱。', 'iCloud accounts, credentials, aliases, and on-demand inbox access.') },
  { id: 'linuxdoMail', title: localized('Linux DO 邮箱', 'Linux DO Mail'),
    description: localized('加密连接 Linux DO Mail，并按需只读访问 INBOX。', 'Connect Linux DO Mail with encrypted credentials and read INBOX on demand.') },
  { id: 'adminOperations', title: localized('管理员：运营与邮件', 'Admin: operations and mail'),
    description: localized('统计、审计、失败邮件、全站邮件和安全清理。', 'Statistics, audit, failed mail, site-wide mail, and controlled cleanup.') },
  { id: 'adminAccess', title: localized('管理员：用户与访问', 'Admin: users and access'),
    description: localized('邀请、用户、用户限速和收件域名管理。', 'Invitations, users, user rate limits, and receiving-domain management.') },
  { id: 'adminSettings', title: localized('管理员：设置、备份与版本', 'Admin: settings, backups, and version'),
    description: localized('全局策略、存储、备份浏览和系统更新。', 'Global policies, storage, backup browsing, and system updates.') },
]

export const apiEndpoints: ApiEndpoint[] = [
  ...systemEndpoints,
  ...authEndpoints,
  ...mailboxEndpoints,
  ...messageEndpoints,
  ...draftEndpoints,
  ...iCloudEndpoints,
  ...linuxDoMailEndpoints,
  ...adminOperationEndpoints,
  ...adminAccessEndpoints,
  ...adminSettingsEndpoints,
]

const authHeaders: Partial<Record<ApiAuth, string>> = {
  authenticated: 'Authorization: Bearer om_at_...',
  admin: 'Authorization: Bearer om_at_admin...',
  superAdmin: 'Authorization: Bearer om_at_owner...',
}

function exampleRoute(path: string): string {
  return path
    .replace(':messageId', 'message_id')
    .replace(':attachmentId', 'attachment_id')
    .replace(':anonymousId', 'alias_id')
    .replace(':address', 'owner%40example.com')
    .replace(':token', 'invite_token')
    .replace(':name', 'example.com')
    .replace(':uid', '123')
    .replace(':id', 'resource_id')
}

export function displayApiPath(path: string): string {
  return path.replace(/:([A-Za-z]+)/g, '{$1}')
}

export function apiEndpointKey(endpoint: Pick<ApiEndpoint, 'method' | 'path'>): string {
  return `${endpoint.method} ${endpoint.path}`
}

export function apiEndpointCurl(endpoint: ApiEndpoint, baseUrl: string): string {
  const path = exampleRoute(endpoint.examplePath || endpoint.path)
  const url = `${baseUrl}${path.slice('/api'.length)}`
  const args = [`curl --request ${endpoint.method}`, `--url "${url}"`]
  const authHeader = authHeaders[endpoint.auth]
  if (authHeader) args.push(`--header "${authHeader}"`)
  if (endpoint.auth === 'cookie') args.push('--cookie "omnimail_session=..."')
  if (endpoint.auth === 'webhook') {
    args.push('--header "svix-id: msg_..."')
    args.push('--header "svix-timestamp: 1700000000"')
    args.push('--header "svix-signature: v1,..."')
  }
  for (const [name, value] of Object.entries(endpoint.extraHeaders || {})) {
    args.push(`--header "${name}: ${value}"`)
  }
  if (endpoint.exampleBody !== undefined) {
    args.push('--header "Content-Type: application/json"')
    args.push(`--data '${JSON.stringify(endpoint.exampleBody, null, 2)}'`)
  }
  for (const [name, value] of Object.entries(endpoint.formFields || {})) {
    args.push(`--form "${name}=${value}"`)
  }
  if (endpoint.outputFile) args.push(`--output "${endpoint.outputFile}"`)
  return args.join(' \\\n  ')
}
