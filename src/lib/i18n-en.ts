import { enAdmin } from './i18n-en-admin'
import { enAdminMail } from './i18n-en-admin-mail'
import { enApi } from './i18n-en-api'
import { enErrors } from './i18n-en-errors'
import { enExtension } from './i18n-en-extension'
import { enGmail } from './i18n-en-gmail'
import { enICloud } from './i18n-en-icloud'
import { enInvites } from './i18n-en-invites'
import { enLinuxDoMail } from './i18n-en-linux-do-mail'
import { enMailFeatures } from './i18n-en-mail-features'
import { enMailWorkspaces } from './i18n-en-mail-workspaces'
import { enMailboxSettings } from './i18n-en-mailbox-settings'
import { enOauth } from './i18n-en-oauth'
import { enRateLimit } from './i18n-en-rate-limit'
import { enSecurity } from './i18n-en-security'
import { enVersion } from './i18n-en-version'

export const englishTranslations: Record<string, string> = {
  ...enAdmin,
  ...enAdminMail,
  ...enInvites,
  ...enErrors,
  ...enExtension,
  ...enOauth,
  ...enSecurity,
  ...enMailFeatures,
  ...enMailWorkspaces,
  ...enMailboxSettings,
  ...enRateLimit,
  ...enVersion,
  ...enICloud,
  ...enLinuxDoMail,
  ...enGmail,
  ...enApi,
}
