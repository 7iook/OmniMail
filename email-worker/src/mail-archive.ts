import { backupEnabled } from './storage-policy'
import type { Env } from './types'

export type StoredMail = {
  id: string
  direction: 'incoming' | 'outgoing'
  raw_key: string | null
  body_key: string | null
  stored_at: number
}

function backupMonth(timestamp: Date | number): string {
  return new Date(timestamp).toISOString().slice(0, 7)
}

function archiveKey(message: StoredMail): string | null {
  const month = backupMonth(message.stored_at * 1000)
  if (message.direction === 'incoming' && message.raw_key) {
    return `mail/raw/${month}/${message.id}.eml`
  }
  if (message.direction === 'outgoing' && message.body_key) {
    return `mail/sent/${month}/${message.id}.json`
  }
  return null
}

export async function copyStoredMail(
  sourceBucket: R2Bucket,
  backupBucket: R2Bucket,
  message: StoredMail,
): Promise<void> {
  const destination = archiveKey(message)
  const source = message.direction === 'incoming' ? message.raw_key : message.body_key
  if (!destination || !source || await backupBucket.head(destination)) return
  const object = await sourceBucket.get(source)
  if (!object) throw new Error(`邮件备份源文件不存在：${source}`)
  await backupBucket.put(destination, object.body, {
    httpMetadata: object.httpMetadata,
    customMetadata: {
      messageId: message.id,
      direction: message.direction,
      sourceKey: source,
    },
  })
}

export async function archiveIncomingMessage(
  env: Env,
  messageId: string,
  raw: ArrayBuffer,
  receivedAt: number,
): Promise<void> {
  if (!env.BACKUP_BUCKET || !await backupEnabled(env.DB)) return
  const destination = `mail/raw/${backupMonth(receivedAt * 1000)}/${messageId}.eml`
  if (await env.BACKUP_BUCKET.head(destination)) return
  await env.BACKUP_BUCKET.put(destination, raw, {
    httpMetadata: { contentType: 'message/rfc822' },
    customMetadata: { messageId, direction: 'incoming' },
  })
}

export async function archiveSentMessage(
  env: Env,
  messageId: string,
  body: string,
  sentAt: number,
): Promise<void> {
  if (!env.BACKUP_BUCKET || !await backupEnabled(env.DB)) return
  const destination = `mail/sent/${backupMonth(sentAt * 1000)}/${messageId}.json`
  if (await env.BACKUP_BUCKET.head(destination)) return
  await env.BACKUP_BUCKET.put(destination, body, {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { messageId, direction: 'outgoing' },
  })
}
