import { publicSetupRequirements } from './deployment-check'
import {
  externalRegistrationEnabled,
  registrationDomainPolicy,
} from './registration-api'
import { registrationProtectionReady } from './registration-security'
import {
  mailRefreshInterval,
  remoteImagesEnabled,
} from './system-settings'
import type { Env } from './types'

async function setupComplete(db: D1Database): Promise<boolean> {
  const setting = await db.prepare(
    "SELECT value FROM settings WHERE key = 'setup_complete'",
  ).first<{ value: string }>()
  return setting?.value === '1'
}

function superAdminEmail(env: Env): string {
  const email = (env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
}

export async function publicConfig(env: Env) {
  const [
    initialized,
    registrationEnabled,
    domainPolicy,
    refreshInterval,
    allowRemoteImages,
  ] = await Promise.all([
    setupComplete(env.DB),
    externalRegistrationEnabled(env.DB),
    registrationDomainPolicy(env.DB),
    mailRefreshInterval(env.DB),
    remoteImagesEnabled(env.DB),
  ])

  return {
    appName: env.APP_NAME || 'OmniMail',
    setupComplete: initialized,
    replyEnabled: Boolean(env.RESEND_API_KEY),
    registrationEnabled,
    registrationDomainPolicy: domainPolicy,
    registrationProtectionReady: registrationProtectionReady(env),
    turnstileSiteKey: env.TURNSTILE_SITE_KEY?.trim() || '',
    mailRefreshInterval: refreshInterval,
    remoteImagesEnabled: allowRemoteImages,
    superAdminEmail: superAdminEmail(env),
    setupRequirements: publicSetupRequirements(env),
  }
}
