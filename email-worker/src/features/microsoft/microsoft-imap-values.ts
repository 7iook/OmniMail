import type { MicrosoftFolder } from './microsoft-types'

/** IMAP UIDs are 32-bit unsigned and start at 1 (RFC 3501). */
const MAX_IMAP_UID = 4_294_967_295

/**
 * Reads an IMAP UID out of a stored `remote_id`, or `null` if it is not one.
 *
 * The column is TEXT because it also holds Graph's opaque ids, so nothing at the
 * schema level keeps an IMAP row's value canonical. `Number()` alone is too
 * permissive here — it accepts `'0'`, `'-1'`, `'1e3'`, `'7.0'` and whitespace,
 * any of which would silently address the wrong message or send UID 0 to the
 * server. Callers that need a UID must go through this, so sync and the message
 * API cannot drift apart on what counts as valid.
 */
export function parseMicrosoftImapUid(value: string): number | null {
  if (!/^[1-9][0-9]*$/.test(value)) return null
  const uid = Number(value)
  return uid <= MAX_IMAP_UID ? uid : null
}

const SPECIAL_USE = new Set([
  '\\inbox', '\\sent', '\\drafts', '\\trash', '\\junk', '\\archive', '\\all',
])

function base64Bytes(value: string): Uint8Array {
  const normalized = value.replaceAll(',', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0))
}

export function decodeModifiedUtf7(value: string): string {
  return value.replace(/&([^-]*)-/g, (_match, encoded: string) => {
    if (!encoded) return '&'
    try {
      const bytes = base64Bytes(encoded)
      if (bytes.length % 2 !== 0) return '\uFFFD'
      let result = ''
      for (let index = 0; index < bytes.length; index += 2) {
        result += String.fromCharCode((bytes[index] << 8) | bytes[index + 1])
      }
      return result
    } catch {
      return '\uFFFD'
    }
  })
}

function quotedValue(value: string): string | null {
  let result = ''
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\\') {
      result += value[index]
      continue
    }
    const next = value[++index]
    if (next !== '\\' && next !== '"') return null
    result += next
  }
  return /[\r\n\0]/.test(result) ? null : result
}

export function parseMicrosoftList(lines: string[]): MicrosoftFolder[] {
  const folders: MicrosoftFolder[] = []
  for (const line of lines) {
    const match = line.match(
      /^\* LIST \(([^)]*)\) (?:NIL|"(?:\\.|[^"])*") (?:"((?:\\.|[^"])*)"|([^\s]+))$/i,
    )
    if (!match) continue
    const path = match[2] !== undefined ? quotedValue(match[2]) : match[3]
    if (!path || /[\r\n\0]/.test(path)) continue
    const flags = match[1].split(/\s+/).filter(Boolean)
    const specialUse = flags.find((flag) => SPECIAL_USE.has(flag.toLowerCase())) || ''
    folders.push({
      path,
      displayName: decodeModifiedUtf7(path),
      flags,
      specialUse,
      uidValidity: null,
      lastUid: 0,
    })
  }
  return folders
}

export function parseMicrosoftSearchUids(lines: string[]): number[] {
  const values = lines.filter((line) => line.startsWith('* SEARCH'))
    .flatMap((line) => line.slice(8).trim().split(/\s+/))
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0)
  return [...new Set(values)].sort((left, right) => left - right)
}
