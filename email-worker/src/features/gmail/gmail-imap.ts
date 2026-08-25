import { ImapConnection } from '../../platform/imap/imap-connection'
import { ImapConnectionError } from '../../platform/imap/imap-errors'
import packageMetadata from '../../../../package.json'
import {
  gmailAttachmentContent,
  parseGmailMessage,
  parseGmailMetadata,
} from './gmail-message-parser'
import type { GmailMessageMetadata } from './gmail-types'

const IMAP_HOST = 'imap.gmail.com'
const IMAP_PORT = 993
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024
const METADATA_BATCH_SIZE = 20

export { ImapConnectionError as GmailRemoteError }

function uidsFromSearch(lines: string[]): number[] {
  const line = lines.find((item) => item.startsWith('* SEARCH'))
  if (!line) return []
  return line.slice(8).trim().split(/\s+/).filter(Boolean).map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0)
}

function validUids(values: number[]): number[] {
  return [...new Set(values)]
    .filter((value) => Number.isSafeInteger(value) && value > 0)
    .sort((left, right) => left - right)
}

export class GmailImapClient {
  private readonly connection = new ImapConnection(
    IMAP_HOST,
    IMAP_PORT,
    'Gmail IMAP',
    ' Gmail 地址和应用专用密码',
    MAX_MESSAGE_BYTES,
  )

  constructor(
    private readonly email: string,
    private readonly appPassword: string,
  ) {}

  async open(): Promise<void> {
    await this.connection.open(this.email, this.appPassword)
    const capability = await this.connection.command('CAPABILITY')
    if (!capability.lines.some((line) => /\bX-GM-EXT-1\b/i.test(line))) {
      throw new ImapConnectionError(502, 'Gmail 服务未提供所需的 IMAP 扩展。', true)
    }
    await this.connection.command(
      `ID ("name" "OmniMail" "version" "${packageMetadata.version}" "contact" "https://github.com/mibgb65-cloud/OmniMail")`,
    )
  }

  async close(): Promise<void> {
    await this.connection.close()
  }

  async examineInbox(): Promise<{ uidValidity: number; exists: number }> {
    const result = await this.connection.command('EXAMINE INBOX')
    const uidValidity = Number(result.lines
      .map((line) => line.match(/\[UIDVALIDITY (\d+)\]/i)?.[1])
      .find(Boolean))
    const exists = Number(result.lines
      .map((line) => line.match(/^\* (\d+) EXISTS$/i)?.[1])
      .find(Boolean) || 0)
    if (!Number.isSafeInteger(uidValidity) || uidValidity < 1) {
      throw new ImapConnectionError(502, 'Gmail 未返回有效的 UIDVALIDITY。', true)
    }
    return { uidValidity, exists }
  }

  async searchAllUids(): Promise<number[]> {
    return uidsFromSearch((await this.connection.command('UID SEARCH ALL')).lines)
  }

  async searchAfter(uid: number): Promise<number[]> {
    if (!Number.isSafeInteger(uid) || uid < 0) {
      throw new ImapConnectionError(400, 'Gmail 同步游标无效。', true)
    }
    return uidsFromSearch((await this.connection.command(`UID SEARCH UID ${uid + 1}:*`)).lines)
      .filter((value) => value > uid)
  }

  async fetchMetadata(
    uids: number[],
    deadline = Date.now() + 150_000,
  ): Promise<GmailMessageMetadata[]> {
    const selected = validUids(uids)
    const messages: GmailMessageMetadata[] = []
    for (let offset = 0; offset < selected.length; offset += METADATA_BATCH_SIZE) {
      if (Date.now() >= deadline) {
        throw new ImapConnectionError(504, 'Gmail 同步超过总执行时间上限。')
      }
      const batch = selected.slice(offset, offset + METADATA_BATCH_SIZE)
      const result = await this.connection.command(
        `UID FETCH ${batch.join(',')} (UID X-GM-MSGID X-GM-THRID X-GM-LABELS FLAGS INTERNALDATE RFC822.SIZE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID CONTENT-TYPE)])`,
      )
      for (const literal of result.literals) {
        messages.push(await parseGmailMetadata(literal.line, literal.data))
      }
    }
    return messages
  }

  async findUid(gmailMessageId: string): Promise<number | null> {
    if (!/^\d{1,20}$/.test(gmailMessageId)) {
      throw new ImapConnectionError(400, 'Gmail 消息标识无效。', true)
    }
    const uids = uidsFromSearch((await this.connection.command(
      `UID SEARCH X-GM-MSGID ${gmailMessageId}`,
    )).lines)
    return uids.at(-1) ?? null
  }

  async getMessage(uid: number) {
    if (!Number.isSafeInteger(uid) || uid < 1) {
      throw new ImapConnectionError(400, 'Gmail 邮件 UID 无效。', true)
    }
    await this.connection.command('EXAMINE INBOX')
    const result = await this.connection.command(`UID FETCH ${uid} (UID BODY.PEEK[])`)
    const literal = result.literals.find(({ line }) => new RegExp(`\\bUID ${uid}\\b`, 'i').test(line))
    if (!literal) throw new ImapConnectionError(404, '邮件不存在或已移出收件箱。', true)
    return parseGmailMessage(literal.data, String(uid))
  }

  async markSeen(uid: number): Promise<void> {
    if (!Number.isSafeInteger(uid) || uid < 1) {
      throw new ImapConnectionError(400, 'Gmail 邮件 UID 无效。', true)
    }
    await this.connection.command('SELECT INBOX')
    await this.connection.command(`UID STORE ${uid} +FLAGS.SILENT (\\Seen)`)
  }

  async getAttachment(uid: number, partId: string) {
    const { parsedAttachments } = await this.getMessage(uid)
    return gmailAttachmentContent(parsedAttachments, partId)
  }
}
