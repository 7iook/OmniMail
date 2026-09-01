import PostalMime, { type Address, type Attachment } from 'postal-mime'
import { normalizeAttachmentFilename } from '../../shared/mail/attachment-policy'
import type {
  MicrosoftAttachment,
  MicrosoftMessageDetail,
  MicrosoftMessageMetadata,
} from './microsoft-types'

const MAX_BODY_CHARS = 200_000
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024

function mailboxes(addresses: Address[] | Address | undefined): Array<{ name: string; address: string }> {
  const list = addresses ? (Array.isArray(addresses) ? addresses : [addresses]) : []
  const result: Array<{ name: string; address: string }> = []
  for (const address of list) {
    if (address.group) result.push(...address.group)
    else if (address.address) result.push({ name: address.name, address: address.address })
  }
  return result
}

function mailboxText(address: { name: string; address: string } | undefined): string {
  if (!address) return ''
  return address.name ? `${address.name} <${address.address}>` : address.address
}

function cleanText(value: string): string {
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

function listValues(value: string): string[] {
  const values: string[] = []
  let current = ''
  let quoted = false
  let escaped = false
  for (const character of value) {
    if (escaped) {
      current += character
      escaped = false
    } else if (quoted && character === '\\') {
      escaped = true
    } else if (character === '"') {
      quoted = !quoted
    } else if (!quoted && /\s/.test(character)) {
      if (current) values.push(current)
      current = ''
    } else {
      current += character
    }
  }
  if (current) values.push(current)
  return values
}

function attributeList(line: string, name: string): string[] {
  const marker = line.search(new RegExp(`\\b${name} \\(`, 'i'))
  if (marker < 0) return []
  const start = line.indexOf('(', marker) + 1
  let quoted = false
  let escaped = false
  for (let index = start; index < line.length; index += 1) {
    const character = line[index]
    if (escaped) escaped = false
    else if (quoted && character === '\\') escaped = true
    else if (character === '"') quoted = !quoted
    else if (!quoted && character === ')') return listValues(line.slice(start, index))
  }
  return []
}

function numericAttribute(line: string, name: string): string {
  return line.match(new RegExp(`\\b${name} (\\d+)\\b`, 'i'))?.[1] || ''
}

function timestamp(value: string | undefined): number | null {
  const parsed = Date.parse(value || '')
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null
}

export async function parseMicrosoftMetadata(
  fetchLine: string,
  headers: Uint8Array,
): Promise<MicrosoftMessageMetadata> {
  const uid = Number(numericAttribute(fetchLine, 'UID'))
  if (!Number.isSafeInteger(uid) || uid < 1) {
    throw new Error('Microsoft FETCH 响应缺少有效 UID。')
  }
  const parsed = await PostalMime.parse(headers, { maxHeadersSize: 128 * 1024 })
  const sender = mailboxes(parsed.from)[0]
  const recipients = mailboxes(parsed.to)
  const cc = mailboxes(parsed.cc)
  const flags = attributeList(fetchLine, 'FLAGS')
  const internal = fetchLine.match(/\bINTERNALDATE "([^"]+)"/i)?.[1]
  const receivedAt = timestamp(internal) ?? timestamp(parsed.date) ?? 0
  const sentAt = timestamp(parsed.date)
  const contentType = parsed.headers.find(({ key }) => key === 'content-type')?.value || ''
  return {
    remoteId: String(uid),
    // UIDVALIDITY belongs to the mailbox, not the FETCH line — the sync layer,
    // which has already examined the folder, fills it in before persisting.
    uidValidity: null,
    internetMessageId: parsed.messageId || '',
    senderName: sender?.name || '',
    senderAddress: sender?.address || '',
    recipients: recipients.map(mailboxText),
    cc: cc.map(mailboxText),
    subject: (parsed.subject || '').trim().slice(0, 998),
    preview: '',
    receivedAt,
    sentAt,
    sizeBytes: Number(numericAttribute(fetchLine, 'RFC822.SIZE')) || 0,
    flags,
    isRead: flags.some((flag) => flag.toLowerCase() === '\\seen'),
    isStarred: flags.some((flag) => flag.toLowerCase() === '\\flagged'),
    hasAttachments: /multipart\/mixed/i.test(contentType) || /"ATTACHMENT"/i.test(fetchLine),
  }
}

/**
 * The slice of a Graph `message` resource this mapper reads.
 *
 * Declared locally on purpose: it is the anti-corruption boundary. Nothing past
 * this file sees Graph's field names, and the Graph client owns its own types, so
 * importing them here would couple the two in both directions.
 */
export interface MicrosoftGraphMessageInput {
  id?: unknown
  internetMessageId?: unknown
  subject?: unknown
  bodyPreview?: unknown
  isRead?: unknown
  hasAttachments?: unknown
  receivedDateTime?: unknown
  sentDateTime?: unknown
  from?: unknown
  sender?: unknown
  toRecipients?: unknown
  ccRecipients?: unknown
  flag?: unknown
  singleValueExtendedProperties?: unknown
}

/** PidTagMessageSize — the only route to a message's size on the v1.0 surface. */
const GRAPH_SIZE_PROPERTY = /^integer 0x0*e08$/i
const GRAPH_PREVIEW_CHARS = 180

/**
 * Same bound and shape as the inbound preview, kept local on purpose: the shared
 * helper lives in the queue handler module, which imports the Microsoft sync
 * consumer, so importing it here would close an import cycle.
 */
function graphPreview(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > GRAPH_PREVIEW_CHARS
    ? `${clean.slice(0, GRAPH_PREVIEW_CHARS - 1)}…` : clean
}

function graphText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function graphMailbox(value: unknown): { name: string; address: string } | undefined {
  const mailbox = (value as { emailAddress?: { name?: unknown; address?: unknown } } | null)
    ?.emailAddress
  const address = graphText(mailbox?.address).trim()
  if (!address) return undefined
  return { name: graphText(mailbox?.name).trim(), address }
}

function graphMailboxes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(graphMailbox).filter((mailbox) => !!mailbox).map(mailboxText)
}

function graphSizeBytes(value: unknown): number {
  if (!Array.isArray(value)) return 0
  for (const property of value) {
    const { id, value: raw } = (property || {}) as { id?: unknown; value?: unknown }
    if (!GRAPH_SIZE_PROPERTY.test(graphText(id).trim())) continue
    const size = Number(graphText(raw) || raw)
    if (Number.isSafeInteger(size) && size >= 0) return size
  }
  return 0
}

/**
 * Normalises one Graph message into the same shape the IMAP path produces, so a
 * mail fetched over either transport renders identically.
 *
 * Where the two transports genuinely differ, this picks the value that keeps the
 * UI consistent rather than the value that is cheapest to read:
 * - `remoteId` stays Graph's opaque id verbatim; it is transport-scoped by contract.
 * - `uidValidity` is `null` — Graph has no UIDVALIDITY.
 * - Display names are kept. Graph splits them out of the address, while IMAP keeps
 *   the RFC2822 header, so recipients are re-composed into `Name <addr>` form.
 * - Dates become epoch seconds, erasing the ISO-8601 vs RFC-2822 divergence.
 * - `flags` stays empty: IMAP flag tokens are an IMAP fact and would be a lie here.
 *   `isRead` / `isStarred` carry the same meaning across both instead.
 */
export function parseMicrosoftGraphMetadata(
  message: MicrosoftGraphMessageInput,
): MicrosoftMessageMetadata {
  const remoteId = graphText(message.id).trim()
  if (!remoteId) throw new Error('Microsoft Graph 消息缺少 id。')
  const sender = graphMailbox(message.from) ?? graphMailbox(message.sender)
  const messageId = graphText(message.internetMessageId).trim()
  const receivedAt = timestamp(graphText(message.receivedDateTime))
  const sentAt = timestamp(graphText(message.sentDateTime))
  const flagStatus = graphText((message.flag as { flagStatus?: unknown } | null)?.flagStatus)
  return {
    remoteId,
    // Graph has no UIDVALIDITY; the two-layer identity uses internetMessageId instead.
    uidValidity: null,
    // Empty is legitimate — not every mail carries a Message-ID, and inventing a
    // synthetic one would fabricate a cross-transport identity that does not exist.
    // Bare ids are bracketed so both transports key on the same string.
    internetMessageId: messageId && !messageId.startsWith('<') ? `<${messageId}>` : messageId,
    senderName: sender?.name || '',
    senderAddress: sender?.address || '',
    recipients: graphMailboxes(message.toRecipients),
    cc: graphMailboxes(message.ccRecipients),
    subject: graphText(message.subject).trim().slice(0, 998),
    preview: graphPreview(graphText(message.bodyPreview)),
    receivedAt: receivedAt ?? sentAt ?? 0,
    sentAt,
    sizeBytes: graphSizeBytes(message.singleValueExtendedProperties),
    // IMAP flag tokens (\Seen, \Flagged) describe an IMAP mailbox. Graph state is
    // carried by the booleans below, which is what every consumer actually reads.
    flags: [],
    isRead: message.isRead === true,
    isStarred: flagStatus === 'flagged' || flagStatus === 'complete',
    hasAttachments: message.hasAttachments === true,
  }
}

function attachmentBytes(attachment: Attachment): Uint8Array {
  if (typeof attachment.content === 'string') return new TextEncoder().encode(attachment.content)
  return attachment.content instanceof Uint8Array
    ? attachment.content : new Uint8Array(attachment.content)
}

function base64(bytes: Uint8Array): string {
  let result = ''
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 16_384))
  }
  return btoa(result)
}

function inlineImages(html: string, attachments: Attachment[]): string {
  let total = 0
  let result = html
  for (const attachment of attachments) {
    const contentId = attachment.contentId?.replace(/^<|>$/g, '')
    if (!contentId || !/^image\/(?:png|jpeg|gif|webp)$/i.test(attachment.mimeType)) continue
    const bytes = attachmentBytes(attachment)
    total += bytes.byteLength
    if (total > MAX_INLINE_IMAGE_BYTES) break
    const escaped = contentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    result = result.replace(
      new RegExp(`cid:${escaped}`, 'gi'),
      `data:${attachment.mimeType};base64,${base64(bytes)}`,
    )
  }
  return result
}

export async function parseMicrosoftMessage(
  data: Uint8Array,
  uid: string,
): Promise<{ message: MicrosoftMessageDetail; parsedAttachments: Attachment[] }> {
  const parsed = await PostalMime.parse(data, {
    attachmentEncoding: 'arraybuffer',
    maxHeadersSize: 256 * 1024,
    maxNestingDepth: 20,
  })
  const sender = mailboxes(parsed.from)[0]
  const recipients = mailboxes(parsed.to).map(mailboxText)
  const cc = mailboxes(parsed.cc).map(mailboxText)
  const plain = cleanText(parsed.text?.trim() || parsed.html || '').slice(0, MAX_BODY_CHARS)
  const attachments: MicrosoftAttachment[] = parsed.attachments.map((attachment, index) => ({
    partId: String(index),
    filename: normalizeAttachmentFilename(attachment.filename || `attachment-${index + 1}`),
    contentType: attachment.mimeType || 'application/octet-stream',
    size: attachmentBytes(attachment).byteLength,
    contentId: attachment.contentId?.replace(/^<|>$/g, '') || null,
    disposition: attachment.disposition || 'attachment',
  }))
  return {
    message: {
      id: uid,
      from: mailboxText(sender),
      to: recipients.join(', '),
      cc: cc.join(', '),
      subject: (parsed.subject || '').trim(),
      date: parsed.date || '',
      body: plain,
      html: parsed.html ? inlineImages(parsed.html, parsed.attachments) : '',
      attachments,
    },
    parsedAttachments: parsed.attachments,
  }
}

export function microsoftAttachmentContent(
  attachments: Attachment[],
  partId: string,
): { metadata: MicrosoftAttachment; data: Uint8Array } | null {
  if (!/^\d+$/.test(partId)) return null
  const index = Number(partId)
  const attachment = attachments[index]
  if (!attachment) return null
  const data = attachmentBytes(attachment)
  return {
    metadata: {
      partId,
      filename: normalizeAttachmentFilename(attachment.filename || `attachment-${index + 1}`),
      contentType: attachment.mimeType || 'application/octet-stream',
      size: data.byteLength,
      contentId: attachment.contentId?.replace(/^<|>$/g, '') || null,
      disposition: attachment.disposition || 'attachment',
    },
    data,
  }
}
