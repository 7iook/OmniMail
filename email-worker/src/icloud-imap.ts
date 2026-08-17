import { connect } from 'cloudflare:sockets'
import { ICloudRemoteError } from './icloud-apple'
import { parseICloudMessage } from './icloud-message-parser'
import type { ICloudMessage } from './icloud-types'

const IMAP_HOST = 'imap.mail.me.com'
const IMAP_PORT = 993
const LIST_MESSAGE_BYTES = 65_536
const DETAIL_MESSAGE_BYTES = 524_288
const CONNECT_TIMEOUT_MS = 10_000
const COMMAND_TIMEOUT_MS = 20_000
const CLOSE_TIMEOUT_MS = 2_000
const encoder = new TextEncoder()

interface CommandResult {
  lines: string[]
  literals: Array<{ line: string; data: Uint8Array }>
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout()
      reject(new ICloudRemoteError(504, 'iCloud IMAP 请求超时。'))
    }, timeoutMs)
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
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

export class ICloudImapClient {
  private socket?: Socket
  private reader?: SocketReader
  private writer?: WritableStreamDefaultWriter<Uint8Array>
  private tagNumber = 0

  constructor(
    private readonly email: string,
    private readonly appPassword: string,
  ) {}

  private abort(): void {
    const socket = this.socket
    this.socket = undefined
    this.reader = undefined
    this.writer = undefined
    if (socket) void socket.close().catch(() => undefined)
  }

  async open(): Promise<void> {
    try {
      this.socket = connect(
        { hostname: IMAP_HOST, port: IMAP_PORT },
        { secureTransport: 'on', allowHalfOpen: false },
      )
      await withTimeout(this.socket.opened, CONNECT_TIMEOUT_MS, () => this.abort())
      this.reader = new SocketReader(this.socket.readable.getReader())
      this.writer = this.socket.writable.getWriter()
      const greeting = await withTimeout(
        this.reader.line(),
        CONNECT_TIMEOUT_MS,
        () => this.abort(),
      )
      if (!greeting.startsWith('* OK')) {
        throw new ICloudRemoteError(502, 'iCloud IMAP 服务未就绪。')
      }
      await this.command(
        `LOGIN ${quoteICloudImapValue(this.email)} ${quoteICloudImapValue(this.appPassword)}`,
        401,
      )
    } catch (error) {
      this.abort()
      if (error instanceof ICloudRemoteError && error.status === 401) {
        throw new ICloudRemoteError(400, 'IMAP 登录失败，请检查 iCloud 邮箱和应用专用密码。')
      }
      if (error instanceof ICloudRemoteError) throw error
      throw new ICloudRemoteError(502, '连接 iCloud IMAP 失败。')
    }
  }

  async close(): Promise<void> {
    const socket = this.socket
    if (!socket) return
    try { await this.command('LOGOUT', 502, CLOSE_TIMEOUT_MS) } catch { /* close below */ }
    this.socket = undefined
    this.reader = undefined
    this.writer = undefined
    try {
      await withTimeout(socket.close(), CLOSE_TIMEOUT_MS, () => undefined)
    } catch { /* socket may already be closed */ }
  }

  private async command(
    command: string,
    failureStatus = 502,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<CommandResult> {
    if (!this.reader || !this.writer) throw new ICloudRemoteError(500, 'IMAP 尚未连接。')
    const operation = (async () => {
      const tag = `A${String(++this.tagNumber).padStart(4, '0')}`
      await this.writer!.write(encoder.encode(`${tag} ${command}\r\n`))
      const result: CommandResult = { lines: [], literals: [] }
      for (;;) {
        const line = await this.reader!.line()
        result.lines.push(line)
        const literal = line.match(/\{(\d+)\}$/)
        if (literal) {
          const length = Number(literal[1])
          if (length > DETAIL_MESSAGE_BYTES) {
            throw new ICloudRemoteError(502, '邮件内容超过单封读取上限。')
          }
          result.literals.push({ line, data: await this.reader!.exactly(length) })
        }
        if (line.startsWith(`${tag} `)) {
          if (!line.startsWith(`${tag} OK`)) {
            throw new ICloudRemoteError(
              failureStatus,
              failureStatus === 401 ? 'iCloud IMAP 拒绝了登录凭据。' : 'iCloud IMAP 命令失败。',
              true,
            )
          }
          return result
        }
      }
    })()
    try {
      return await withTimeout(operation, timeoutMs, () => this.abort())
    } catch (error) {
      if (error instanceof ICloudRemoteError) {
        if (!error.definitive) this.abort()
        throw error
      }
      this.abort()
      throw new ICloudRemoteError(502, 'iCloud IMAP 连接失败。')
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
      parseICloudMessage(data, line.match(/\bUID (\d+)\b/i)?.[1] || '')
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
    return parseICloudMessage(literal.data, uid, true)
  }
}
