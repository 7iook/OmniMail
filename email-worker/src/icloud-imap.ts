import PostalMime from 'postal-mime'
import { connect } from 'cloudflare:sockets'
import { ICloudRemoteError } from './icloud-apple'
import type { ICloudMessage } from './icloud-types'

const IMAP_HOST = 'imap.mail.me.com'
const IMAP_PORT = 993
const LIST_MESSAGE_BYTES = 65_536
const DETAIL_MESSAGE_BYTES = 524_288
const encoder = new TextEncoder()

interface CommandResult {
  lines: string[]
  literals: Array<{ line: string; data: Uint8Array }>
}

class SocketReader {
  private buffer = new Uint8Array(0)

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async fill(): Promise<void> {
    const { value, done } = await this.reader.read()
    if (done || !value) throw new ICloudRemoteError(502, 'IMAP 连接意外关闭。')
    const combined = new Uint8Array(this.buffer.length + value.length)
    combined.set(this.buffer)
    combined.set(value, this.buffer.length)
    this.buffer = combined
  }

  async exactly(length: number): Promise<Uint8Array> {
    while (this.buffer.length < length) await this.fill()
    const output = this.buffer.slice(0, length)
    this.buffer = this.buffer.slice(length)
    return output
  }

  async line(): Promise<string> {
    for (;;) {
      for (let index = 0; index < this.buffer.length - 1; index += 1) {
        if (this.buffer[index] === 13 && this.buffer[index + 1] === 10) {
          const line = new TextDecoder().decode(this.buffer.slice(0, index))
          this.buffer = this.buffer.slice(index + 2)
          return line
        }
      }
      await this.fill()
    }
  }
}

export function quoteICloudImapValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new ICloudRemoteError(400, 'IMAP 登录信息包含非法换行。')
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function sinceDate(days: number): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - days)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${date.getUTCDate()}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()}`
}

function mailboxText(address: { name: string; address?: string } | undefined): string {
  if (!address) return ''
  return address.name && address.address
    ? `${address.name} <${address.address}>`
    : address.address || address.name
}

function mailboxList(addresses: Array<{ name: string; address?: string }> | undefined): string {
  return (addresses || []).map(mailboxText).filter(Boolean).join(', ')
}

function cleanBody(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n(?:[^\S\n]*\n)+/g, '\n\n')
    .trim()
}

async function parsedMessage(data: Uint8Array, uid: string): Promise<ICloudMessage> {
  const parsed = await PostalMime.parse(data)
  const body = cleanBody(parsed.text?.trim() || parsed.html || '')
  const preview = body.replace(/\s+/g, ' ').trim()
  const date = parsed.date ? new Date(parsed.date) : undefined
  return {
    id: uid,
    from: mailboxText(parsed.from as { name: string; address?: string } | undefined),
    to: mailboxList(parsed.to as Array<{ name: string; address?: string }> | undefined),
    subject: parsed.subject?.trim() || '',
    date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : parsed.date || '',
    preview: preview.length > 400 ? `${preview.slice(0, 400)}…` : preview,
    body: body.length > 12_000 ? `${body.slice(0, 12_000)}…` : body,
  }
}

export class ICloudImapClient {
  private socket?: Socket
  private reader?: SocketReader
  private writer?: WritableStreamDefaultWriter<Uint8Array>
  private tagNumber = 0

  constructor(
    private readonly email: string,
    private readonly appPassword: string,
  ) {}

  async open(): Promise<void> {
    this.socket = connect(
      { hostname: IMAP_HOST, port: IMAP_PORT },
      { secureTransport: 'on', allowHalfOpen: false },
    )
    await this.socket.opened
    this.reader = new SocketReader(this.socket.readable.getReader())
    this.writer = this.socket.writable.getWriter()
    const greeting = await this.reader.line()
    if (!greeting.startsWith('* OK')) {
      throw new ICloudRemoteError(502, `IMAP 服务未就绪：${greeting.slice(0, 160)}`)
    }
    try {
      await this.command(
        `LOGIN ${quoteICloudImapValue(this.email)} ${quoteICloudImapValue(this.appPassword)}`,
      )
    } catch (error) {
      throw new ICloudRemoteError(
        400,
        `IMAP 登录失败，请检查 iCloud 邮箱和应用专用密码：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async close(): Promise<void> {
    if (!this.socket) return
    try { await this.command('LOGOUT') } catch { /* server may close first */ }
    try { await this.socket.close() } catch { /* socket may already be closed */ }
    this.socket = undefined
  }

  private async command(command: string): Promise<CommandResult> {
    if (!this.reader || !this.writer) throw new ICloudRemoteError(500, 'IMAP 尚未连接。')
    const tag = `A${String(++this.tagNumber).padStart(4, '0')}`
    await this.writer.write(encoder.encode(`${tag} ${command}\r\n`))
    const result: CommandResult = { lines: [], literals: [] }
    for (;;) {
      const line = await this.reader.line()
      result.lines.push(line)
      const literal = line.match(/\{(\d+)\}$/)
      if (literal) {
        const length = Number(literal[1])
        if (length > DETAIL_MESSAGE_BYTES) {
          throw new ICloudRemoteError(502, '邮件内容超过单封读取上限。')
        }
        result.literals.push({ line, data: await this.reader.exactly(length) })
      }
      if (line.startsWith(`${tag} `)) {
        if (!line.startsWith(`${tag} OK`)) {
          throw new ICloudRemoteError(502, `IMAP 命令失败：${line.slice(tag.length + 1, 240)}`)
        }
        return result
      }
    }
  }

  async test(): Promise<void> {
    await this.command('EXAMINE INBOX')
  }

  private async search(criteria: string): Promise<number[]> {
    await this.command('EXAMINE INBOX')
    const result = await this.command(`UID SEARCH ${criteria}`)
    const line = result.lines.find((item) => item.startsWith('* SEARCH'))
    return line
      ? line.slice(8).trim().split(/\s+/).filter(Boolean).map(Number)
        .filter((value) => Number.isSafeInteger(value) && value > 0)
      : []
  }

  private async fetch(uids: number[], limit: number): Promise<ICloudMessage[]> {
    const selected = uids.slice(-limit)
    if (!selected.length) return []
    const result = await this.command(
      `UID FETCH ${selected.join(',')} (UID BODY.PEEK[]<0.${LIST_MESSAGE_BYTES}>)`,
    )
    const messages = await Promise.all(result.literals.map(({ line, data }) => (
      parsedMessage(data, line.match(/\bUID (\d+)\b/i)?.[1] || '')
    )))
    return messages.sort((left, right) => Number(right.id) - Number(left.id))
  }

  async listInbox(limit: number, days: number): Promise<ICloudMessage[]> {
    return this.fetch(await this.search(days ? `SINCE ${sinceDate(days)}` : 'ALL'), limit)
  }

  async findByRecipient(recipient: string, limit: number, days: number): Promise<ICloudMessage[]> {
    const date = days ? `SINCE ${sinceDate(days)} ` : ''
    const uids = await this.search(`${date}HEADER To ${quoteICloudImapValue(recipient)}`)
    if (uids.length) return this.fetch(uids, limit)
    const recent = await this.listInbox(Math.min(50, limit * 3), days)
    const needle = recipient.toLowerCase()
    return recent.filter((message) => message.to.toLowerCase().includes(needle)).slice(0, limit)
  }

  async getMessage(uid: string): Promise<ICloudMessage> {
    if (!/^\d+$/.test(uid) || Number(uid) < 1) throw new ICloudRemoteError(400, '邮件 UID 无效。')
    await this.command('EXAMINE INBOX')
    const result = await this.command(
      `UID FETCH ${uid} (UID BODY.PEEK[]<0.${DETAIL_MESSAGE_BYTES}>)`,
    )
    const literal = result.literals.find(({ line }) => new RegExp(`\\bUID ${uid}\\b`, 'i').test(line))
    if (!literal) throw new ICloudRemoteError(404, '邮件不存在或已被移动。')
    return parsedMessage(literal.data, uid)
  }
}
