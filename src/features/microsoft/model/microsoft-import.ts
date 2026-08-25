import type { MicrosoftImportAccount } from '../../../shared/api'

export type MicrosoftImportMode = 'oauth2' | 'password' | 'oauth2_combination'
export type MicrosoftImportPreview = {
  line: number
  email: string
  mode: MicrosoftImportMode | null
  clientIdMasked: string
  status: 'ready' | 'duplicate' | 'error'
  error: string
}

export type ParsedMicrosoftImport = {
  preview: MicrosoftImportPreview
  input: MicrosoftImportAccount
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function maskedClientId(value: string): string {
  return value ? `${value.slice(0, 4)}••••${value.slice(-4)}` : ''
}

function invalid(line: number, email: string, error: string): ParsedMicrosoftImport {
  return {
    preview: {
      line,
      email,
      mode: null,
      clientIdMasked: '',
      status: 'error',
      error,
    },
    input: { email, authMode: 'oauth2', refreshToken: '', clientId: '' },
  }
}

export function parseMicrosoftImportText(value: string): ParsedMicrosoftImport[] {
  const rows: ParsedMicrosoftImport[] = []
  const seen = new Set<string>()
  for (const [offset, raw] of value.split(/\r?\n/).entries()) {
    const line = offset + 1
    const normalizedLine = raw.replace(/^\uFEFF/, '').trim()
    if (!normalizedLine) continue
    const fields = normalizedLine.split('----')
    const email = (fields[0] || '').trim().toLowerCase()
    if (fields.length !== 2 && fields.length !== 4) {
      rows.push(invalid(line, email, '字段数量无效；若密码包含 ----，请改用分字段输入。'))
      continue
    }
    if (!EMAIL.test(email)) {
      rows.push(invalid(line, email, '邮箱地址格式无效。'))
      continue
    }
    if (fields.length === 2) {
      const password = fields[1]
      if (!password) {
        rows.push(invalid(line, email, '密码兼容格式需要填写密码。'))
        continue
      }
      const duplicate = seen.has(email)
      seen.add(email)
      rows.push({
        preview: {
          line,
          email,
          mode: 'password',
          clientIdMasked: '',
          status: duplicate ? 'duplicate' : 'ready',
          error: '',
        },
        input: { email, authMode: 'password', password },
      })
      continue
    }
    const password = fields[1]
    const refreshToken = fields[2]
    const clientId = fields[3].trim().toLowerCase()
    if (!refreshToken) {
      rows.push(invalid(line, email, 'OAuth2 格式需要 refresh token。'))
      continue
    }
    if (!UUID.test(clientId)) {
      rows.push(invalid(line, email, 'Client ID 必须是合法 UUID。'))
      continue
    }
    const duplicate = seen.has(email)
    seen.add(email)
    rows.push({
      preview: {
        line,
        email,
        mode: password ? 'oauth2_combination' : 'oauth2',
        clientIdMasked: maskedClientId(clientId),
        status: duplicate ? 'duplicate' : 'ready',
        error: '',
      },
      input: {
        email,
        authMode: 'oauth2',
        refreshToken,
        clientId,
        authority: 'common',
        password: undefined,
      },
    })
  }
  return rows
}
