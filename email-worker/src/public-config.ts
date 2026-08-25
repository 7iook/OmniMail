import { publicSetupRequirements } from './deployment-check'
import {
  linuxDoAuthReady,
  parseRegistrationDomains,
  parseRegistrationMethod,
  type RegistrationDomainPolicy,
} from './registration-api'
import { registrationProtectionReady } from './registration-security'
import {
  parseMailRefreshInterval,
  parseRandomMailboxPrefix,
} from './system-settings'
import { hasOutboundProviderConfig } from './outbound-provider-config'
import type { Env } from './types'
import { iCloudCredentialsReady } from './features/icloud/icloud-credentials'
import { gmailCredentialsReady } from './features/gmail/gmail-credentials'

type Setting = { key: string; value: string }

function domainPolicy(settings: Map<string, string>): RegistrationDomainPolicy {
  const mode = settings.get('registration_domain_policy_mode') === 'allowlist'
    ? 'allowlist'
    : 'blocklist'
  try {
    const domains = parseRegistrationDomains(
      JSON.parse(settings.get('registration_blocked_domains') || '[]'),
    ) ?? []
    return { mode, domains }
  } catch {
    return { mode, domains: [] }
  }
}

function superAdminEmail(env: Env): string {
  const email = (env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
}

export async function publicConfig(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM settings WHERE key IN (
      'setup_complete',
      'external_registration_enabled',
      'external_registration_method',
      'registration_domain_policy_mode',
      'registration_blocked_domains',
      'mail_refresh_interval',
      'remote_images_enabled',
      'unassigned_mail_enabled',
      'official_extension_enabled',
      'random_mailbox_prefix',
      'icloud_workspace_enabled',
      'linuxdo_mail_workspace_enabled',
      'gmail_workspace_enabled'
    )`,
  ).all<Setting>()
  const settings = new Map(results.map((row) => [row.key, row.value]))
  const registrationEnabled = settings.get('external_registration_enabled') === '1'
  const registrationMethod = parseRegistrationMethod(
    settings.get('external_registration_method'),
  ) || 'password'
  const linuxDoLoginEnabled = linuxDoAuthReady(env)
  const passwordRegistrationReady = registrationProtectionReady(env)
  const setupComplete = settings.get('setup_complete') === '1'

  return {
    appName: env.APP_NAME || 'OmniMail',
    setupComplete,
    replyEnabled: hasOutboundProviderConfig(env),
    iCloudEnabled: iCloudCredentialsReady(env),
    gmailEnabled: env.GMAIL_IMAP_ENABLED !== 'false' && gmailCredentialsReady(env),
    gmailWorkspaceEnabled: env.GMAIL_IMAP_ENABLED !== 'false'
      && settings.get('gmail_workspace_enabled') !== '0',
    iCloudWorkspaceEnabled: settings.get('icloud_workspace_enabled') !== '0',
    linuxDoMailWorkspaceEnabled: settings.get('linuxdo_mail_workspace_enabled') !== '0',
    registrationEnabled,
    registrationAvailable: registrationEnabled && (
      registrationMethod === 'linuxdo' ? linuxDoLoginEnabled : passwordRegistrationReady
    ),
    registrationMethod,
    linuxDoLoginEnabled,
    registrationDomainPolicy: domainPolicy(settings),
    registrationProtectionReady: passwordRegistrationReady,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY?.trim() || '',
    mailRefreshInterval: parseMailRefreshInterval(
      Number(settings.get('mail_refresh_interval')),
    ) ?? 30,
    remoteImagesEnabled: settings.get('remote_images_enabled') === '1',
    unassignedMailEnabled: settings.get('unassigned_mail_enabled') === '1',
    officialExtensionEnabled: settings.get('official_extension_enabled') === '1',
    randomMailboxPrefix: parseRandomMailboxPrefix(
      settings.get('random_mailbox_prefix') || '',
    ) ?? '',
    superAdminEmail: setupComplete ? '' : superAdminEmail(env),
    setupRequirements: publicSetupRequirements(env),
  }
}
