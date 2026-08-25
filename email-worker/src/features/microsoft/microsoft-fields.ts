import { validEmail } from '../../shared/http/api-helpers'
import { validateMicrosoftAuthority } from './microsoft-token'
import type { MicrosoftImportInput, ValidMicrosoftImport } from './microsoft-types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class MicrosoftInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

function secret(value: unknown, label: string, maximum: number): string {
  const result = typeof value === 'string' ? value : ''
  if (!result || result.length > maximum || /[\r\n\0]/.test(result)) {
    throw new MicrosoftInputError('invalid_credential', `${label} 无效。`)
  }
  return result
}

export function microsoftImportAccount(
  value: MicrosoftImportInput,
  options: { allowUnconfirmedPassword?: boolean } = {},
): ValidMicrosoftImport {
  const email = typeof value.email === 'string' ? value.email.trim().toLowerCase() : ''
  if (!validEmail(email) || /[\r\n\0]/.test(email)) {
    throw new MicrosoftInputError('invalid_email', '请填写完整的 Microsoft 邮箱地址。')
  }
  const name = typeof value.name === 'string' && value.name.trim()
    ? value.name.trim() : email
  if (name.length > 60 || /[\r\n\0]/.test(name)) {
    throw new MicrosoftInputError('invalid_name', '账号名称需要为 1–60 个字符。')
  }
  if (value.authMode === 'password') {
    if (value.persistPasswordConfirmed !== true && !options.allowUnconfirmedPassword) {
      throw new MicrosoftInputError(
        'password_confirmation_required',
        '保存密码兼容凭据前必须明确确认。',
      )
    }
    return {
      name,
      email,
      authMode: 'password',
      password: secret(value.password, 'Microsoft 邮箱密码', 1024),
      refreshToken: null,
      clientId: '',
      authority: 'common',
    }
  }
  if (value.authMode !== 'oauth2') {
    throw new MicrosoftInputError('invalid_auth_mode', 'Microsoft 认证方式无效。')
  }
  const clientId = typeof value.clientId === 'string' ? value.clientId.trim().toLowerCase() : ''
  if (!UUID.test(clientId)) {
    throw new MicrosoftInputError('invalid_client_id', 'Microsoft Client ID 必须是合法 UUID。')
  }
  let authority = 'common'
  try {
    authority = validateMicrosoftAuthority(
      typeof value.authority === 'string' && value.authority.trim()
        ? value.authority : 'common',
    )
  } catch {
    throw new MicrosoftInputError('invalid_authority', 'Microsoft authority 无效。')
  }
  return {
    name,
    email,
    authMode: 'oauth2',
    password: null,
    refreshToken: secret(value.refreshToken, 'Microsoft refresh token', 16_384),
    clientId,
    authority,
  }
}

export function microsoftMessageLimit(value: string | null): number {
  if (value === null || value === '') return 50
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new MicrosoftInputError('invalid_limit', '邮件数量必须在 1–200 之间。')
  }
  return limit
}
