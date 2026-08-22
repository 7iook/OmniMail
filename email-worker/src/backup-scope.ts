import { BACKUP_DATABASE_IDENTITY } from './backup-target'

export async function backupIdentity(db: D1Database): Promise<string> {
  const row = await db.prepare(
    'SELECT value FROM settings WHERE key = ?',
  ).bind(BACKUP_DATABASE_IDENTITY).first<{ value: string }>()
  if (!row?.value || !/^[a-f0-9]{32}$/i.test(row.value)) {
    throw new Error('当前数据库缺少有效的备份身份标识。')
  }
  return row.value.toLowerCase()
}

export function backupScope(identity: string): string {
  return `instances/${identity}/`
}

export function scopedBackupKey(identity: string, key: string): string {
  return `${backupScope(identity)}${key}`
}
