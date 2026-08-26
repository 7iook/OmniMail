import {
  decryptQqMailCredential,
  encryptQqMailCredential,
  qqMailCredentialsReady,
} from './qq-mail-credentials'
import type {
  PublicQqMailAccount,
  QqMailAccount,
  QqMailAccountRow,
} from './qq-mail-types'
import type { Env } from '../../app/types'

export class QqMailStoreError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function context(userId: string, accountId: string): string {
  return `${userId}:${accountId}:qq-authorization-code`
}

export function publicQqMailAccount(account: QqMailAccount): PublicQqMailAccount {
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    status: account.status,
    lastSyncedAt: account.lastSyncedAt,
    nextSyncAt: account.nextSyncAt,
    lastErrorCode: account.lastErrorCode,
    lastErrorAt: account.lastErrorAt,
    createdAt: account.createdAt,
    hasAuthorizationCode: true,
  }
}

type PublicRow = Omit<QqMailAccountRow, 'user_id' | 'authorization_code_cipher'>

function publicRow(row: PublicRow): PublicQqMailAccount {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    status: row.status,
    lastSyncedAt: row.last_synced_at,
    nextSyncAt: row.next_sync_at,
    lastErrorCode: row.last_error_code,
    lastErrorAt: row.last_error_at,
    createdAt: row.created_at,
    hasAuthorizationCode: true,
  }
}

async function accountFromRow(env: Env, row: QqMailAccountRow): Promise<QqMailAccount> {
  let authorizationCode = ''
  try {
    authorizationCode = await decryptQqMailCredential(
      env,
      row.authorization_code_cipher,
      context(row.user_id, row.id),
    )
  } catch {
    throw new QqMailStoreError(500, 'QQ 邮箱凭据已损坏。')
  }
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    email: row.email,
    authorizationCode,
    status: row.status,
    uidValidity: row.uid_validity,
    uidNext: row.uid_next,
    lastSeenUid: row.last_seen_uid,
    lastSyncedAt: row.last_synced_at,
    nextSyncAt: row.next_sync_at,
    lastErrorCode: row.last_error_code,
    lastErrorAt: row.last_error_at,
    syncLeaseId: row.sync_lease_id,
    syncLeaseUntil: row.sync_lease_until,
    lastManualSyncAt: row.last_manual_sync_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function qqMailAccountForSync(env: Env, accountId: string): Promise<QqMailAccount | null> {
  if (!qqMailCredentialsReady(env)) {
    throw new QqMailStoreError(503, 'QQ 邮箱凭据加密密钥不可用。')
  }
  const row = await env.DB.prepare(
    'SELECT * FROM qq_mail_accounts WHERE id = ? LIMIT 1',
  ).bind(accountId).first<QqMailAccountRow>()
  return row ? accountFromRow(env, row) : null
}

export class QqMailAccountStore {
  constructor(
    private readonly env: Env,
    private readonly userId: string,
  ) {
    if (!qqMailCredentialsReady(env)) {
      throw new QqMailStoreError(503, 'QQ 邮箱功能尚未配置 QQ_MAIL_CREDENTIALS_KEY。')
    }
  }

  async list(): Promise<PublicQqMailAccount[]> {
    const { results } = await this.env.DB.prepare(
      `SELECT id, name, email, status, uid_validity, uid_next, last_seen_uid,
              last_synced_at, next_sync_at, last_error_code, last_error_at,
              sync_lease_id, sync_lease_until, last_manual_sync_at, created_at, updated_at
         FROM qq_mail_accounts WHERE user_id = ? ORDER BY created_at, id`,
    ).bind(this.userId).all<PublicRow>()
    return results.map(publicRow)
  }

  async publicAccount(accountId: string): Promise<PublicQqMailAccount | null> {
    const row = await this.env.DB.prepare(
      `SELECT id, name, email, status, uid_validity, uid_next, last_seen_uid,
              last_synced_at, next_sync_at, last_error_code, last_error_at,
              sync_lease_id, sync_lease_until, last_manual_sync_at, created_at, updated_at
         FROM qq_mail_accounts WHERE id = ? AND user_id = ? LIMIT 1`,
    ).bind(accountId, this.userId).first<PublicRow>()
    return row ? publicRow(row) : null
  }

  async get(accountId: string): Promise<QqMailAccount> {
    const row = await this.env.DB.prepare(
      'SELECT * FROM qq_mail_accounts WHERE id = ? AND user_id = ? LIMIT 1',
    ).bind(accountId, this.userId).first<QqMailAccountRow>()
    if (!row) throw new QqMailStoreError(404, 'QQ 邮箱账号不存在。')
    return accountFromRow(this.env, row)
  }

  async insert(account: QqMailAccount): Promise<void> {
    const cipher = await encryptQqMailCredential(
      this.env,
      account.authorizationCode,
      context(this.userId, account.id),
    )
    const mailbox = await this.env.DB.prepare(
      'SELECT user_id, is_hidden FROM mailboxes WHERE address = ? LIMIT 1',
    ).bind(account.email).first<{ user_id: string; is_hidden: number }>()
    if (mailbox && (mailbox.user_id !== this.userId || !mailbox.is_hidden)) {
      throw new QqMailStoreError(409, '这个 QQ 邮箱账号已被其他账户使用。')
    }
    try {
      const accountStatement = this.env.DB.prepare(
        `INSERT INTO qq_mail_accounts (
          id, user_id, name, email, authorization_code_cipher, status, uid_validity,
          uid_next, last_seen_uid, last_synced_at, next_sync_at, last_error_code,
          last_error_at, sync_lease_id, sync_lease_until, last_manual_sync_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        account.id,
        this.userId,
        account.name,
        account.email,
        cipher,
        account.status,
        account.uidValidity,
        account.uidNext,
        account.lastSeenUid,
        account.lastSyncedAt,
        account.nextSyncAt,
        account.lastErrorCode,
        account.lastErrorAt,
        account.syncLeaseId,
        account.syncLeaseUntil,
        account.lastManualSyncAt,
        account.createdAt,
        account.updatedAt,
      )
      const mailboxStatement = mailbox
        ? this.env.DB.prepare(
          `UPDATE mailboxes SET is_active = 1
            WHERE address = ? AND user_id = ? AND is_hidden = 1`,
        ).bind(account.email, this.userId)
        : this.env.DB.prepare(
          `INSERT INTO mailboxes (
             address, user_id, is_primary, is_active, created_at, is_hidden
           ) VALUES (?, ?, 0, 1, ?, 1)`,
        ).bind(account.email, this.userId, account.createdAt)
      await this.env.DB.batch([accountStatement, mailboxStatement])
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (/UNIQUE|constraint/i.test(message)) {
        throw new QqMailStoreError(409, '这个 QQ 邮箱账号已经连接。')
      }
      throw error
    }
  }

  async rename(accountId: string, name: string, now: number): Promise<PublicQqMailAccount> {
    const result = await this.env.DB.prepare(
      'UPDATE qq_mail_accounts SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    ).bind(name, now, accountId, this.userId).run()
    if (!result.meta.changes) throw new QqMailStoreError(404, 'QQ 邮箱账号不存在。')
    const account = await this.publicAccount(accountId)
    if (!account) throw new QqMailStoreError(404, 'QQ 邮箱账号不存在。')
    return account
  }

  async replaceAuthorizationCode(accountId: string, code: string, now: number): Promise<void> {
    const cipher = await encryptQqMailCredential(
      this.env,
      code,
      context(this.userId, accountId),
    )
    const result = await this.env.DB.prepare(
      `UPDATE qq_mail_accounts SET authorization_code_cipher = ?, status = 'active',
              last_error_code = '', last_error_at = NULL, next_sync_at = 0,
              sync_lease_id = NULL, sync_lease_until = NULL, updated_at = ?
        WHERE id = ? AND user_id = ?`,
    ).bind(cipher, now, accountId, this.userId).run()
    if (!result.meta.changes) throw new QqMailStoreError(404, 'QQ 邮箱账号不存在。')
  }

  async remove(accountId: string): Promise<PublicQqMailAccount> {
    const account = await this.publicAccount(accountId)
    if (!account) throw new QqMailStoreError(404, 'QQ 邮箱账号不存在。')
    const result = await this.env.DB.prepare(
      'DELETE FROM qq_mail_accounts WHERE id = ? AND user_id = ?',
    ).bind(accountId, this.userId).run()
    if (!result.meta.changes) throw new QqMailStoreError(404, 'QQ 邮箱账号不存在。')
    return account
  }
}
