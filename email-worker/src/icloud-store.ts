import {
  decryptICloudCredential,
  encryptICloudCredential,
  iCloudCredentialsReady,
} from './icloud-credentials'
import type {
  ICloudAccount,
  ICloudAccountRow,
  PublicICloudAccount,
} from './icloud-types'
import type { Env } from './types'

export class ICloudStoreError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export function parseICloudCookies(raw: unknown): Record<string, string> {
  if (raw && !Array.isArray(raw) && typeof raw === 'object') {
    const entries = Object.entries(raw).filter(
      (entry): entry is [string, string] => Boolean(entry[0]) && typeof entry[1] === 'string'
        && Boolean(entry[1]),
    )
    if (entries.length) return Object.fromEntries(entries)
    throw new ICloudStoreError(400, 'Cookie 中没有可用值。')
  }
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) throw new ICloudStoreError(400, '请填写 iCloud Cookie。')
  if (value.startsWith('{')) {
    try {
      return parseICloudCookies(JSON.parse(value) as unknown)
    } catch (error) {
      if (error instanceof ICloudStoreError) throw error
      throw new ICloudStoreError(400, 'Cookie JSON 格式无效。')
    }
  }
  const entries = value.split(';').flatMap((item): Array<[string, string]> => {
    const separator = item.indexOf('=')
    if (separator < 1) return []
    const name = item.slice(0, separator).trim()
    const cookieValue = item.slice(separator + 1).trim()
    return name && cookieValue ? [[name, cookieValue]] : []
  })
  if (!entries.length) throw new ICloudStoreError(400, '无法解析 iCloud Cookie。')
  return Object.fromEntries(entries)
}

export function publicICloudAccount(account: ICloudAccount): PublicICloudAccount {
  const { cookies, appPassword, userId: _userId, ...safe } = account
  return {
    ...safe,
    hasCookies: Object.keys(cookies).length > 0,
    hasAppPassword: Boolean(appPassword),
  }
}

export class ICloudAccountStore {
  constructor(
    private readonly env: Env,
    private readonly userId: string,
  ) {
    if (!iCloudCredentialsReady(env)) {
      throw new ICloudStoreError(
        503,
        'iCloud 功能尚未配置 ICLOUD_CREDENTIALS_KEY。',
      )
    }
  }

  private context(accountId: string, field: 'cookies' | 'app-password'): string {
    return `${this.userId}:${accountId}:${field}`
  }

  private async fromRow(row: ICloudAccountRow): Promise<ICloudAccount> {
    if (row.user_id !== this.userId) throw new ICloudStoreError(404, 'iCloud 账号不存在。')
    const [cookiesText, appPassword] = await Promise.all([
      decryptICloudCredential(
        this.env,
        row.cookies_cipher,
        this.context(row.id, 'cookies'),
      ),
      decryptICloudCredential(
        this.env,
        row.app_password_cipher,
        this.context(row.id, 'app-password'),
      ),
    ])
    let cookies: Record<string, string> = {}
    try {
      cookies = cookiesText ? JSON.parse(cookiesText) as Record<string, string> : {}
    } catch {
      throw new ICloudStoreError(500, 'iCloud 账号凭据已损坏。')
    }
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      realEmail: row.real_email,
      icloudEmail: row.icloud_email,
      cookies,
      host: row.host,
      appPassword,
      status: row.status,
      aliasTotal: Number(row.alias_total),
      aliasActive: Number(row.alias_active),
      lastValidated: row.last_validated,
      lastError: row.last_error,
      createdAt: row.created_at,
    }
  }

  async list(): Promise<PublicICloudAccount[]> {
    const { results } = await this.env.DB.prepare(
      `SELECT * FROM icloud_accounts WHERE user_id = ?
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                created_at`,
    ).bind(this.userId).all<ICloudAccountRow>()
    return Promise.all(results.map(async (row) => publicICloudAccount(await this.fromRow(row))))
  }

  async get(id: string): Promise<ICloudAccount> {
    const row = await this.env.DB.prepare(
      'SELECT * FROM icloud_accounts WHERE id = ? AND user_id = ?',
    ).bind(id, this.userId).first<ICloudAccountRow>()
    if (!row) throw new ICloudStoreError(404, 'iCloud 账号不存在。')
    return this.fromRow(row)
  }

  async insert(account: ICloudAccount): Promise<void> {
    const now = new Date().toISOString()
    const [cookiesCipher, passwordCipher] = await Promise.all([
      encryptICloudCredential(
        this.env,
        JSON.stringify(account.cookies),
        this.context(account.id, 'cookies'),
      ),
      encryptICloudCredential(
        this.env,
        account.appPassword,
        this.context(account.id, 'app-password'),
      ),
    ])
    await this.env.DB.prepare(
      `INSERT INTO icloud_accounts (
        id, user_id, name, real_email, icloud_email, cookies_cipher, host,
        app_password_cipher, status, alias_total, alias_active,
        last_validated, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      account.id,
      this.userId,
      account.name,
      account.realEmail,
      account.icloudEmail,
      cookiesCipher,
      account.host,
      passwordCipher,
      account.status,
      account.aliasTotal,
      account.aliasActive,
      account.lastValidated,
      account.lastError,
      account.createdAt,
      now,
    ).run()
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.env.DB.prepare(
      'DELETE FROM icloud_accounts WHERE id = ? AND user_id = ?',
    ).bind(id, this.userId).run()
    return Boolean(result.meta.changes)
  }

  async saveCookies(account: ICloudAccount): Promise<void> {
    const cipher = await encryptICloudCredential(
      this.env,
      JSON.stringify(account.cookies),
      this.context(account.id, 'cookies'),
    )
    await this.env.DB.prepare(
      `UPDATE icloud_accounts SET
        cookies_cipher = ?, real_email = ?, icloud_email = ?, status = ?,
        alias_total = ?, alias_active = ?, last_validated = ?, last_error = ?,
        updated_at = ? WHERE id = ? AND user_id = ?`,
    ).bind(
      cipher,
      account.realEmail,
      account.icloudEmail,
      account.status,
      account.aliasTotal,
      account.aliasActive,
      account.lastValidated,
      account.lastError,
      new Date().toISOString(),
      account.id,
      this.userId,
    ).run()
  }

  async saveAppPassword(id: string, icloudEmail: string, password: string): Promise<void> {
    const cipher = await encryptICloudCredential(
      this.env,
      password,
      this.context(id, 'app-password'),
    )
    const result = await this.env.DB.prepare(
      `UPDATE icloud_accounts SET icloud_email = ?, app_password_cipher = ?,
       updated_at = ? WHERE id = ? AND user_id = ?`,
    ).bind(icloudEmail, cipher, new Date().toISOString(), id, this.userId).run()
    if (!result.meta.changes) throw new ICloudStoreError(404, 'iCloud 账号不存在。')
  }
}
