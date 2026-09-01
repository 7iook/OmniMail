/**
 * Microsoft Graph OAuth scope identifiers.
 *
 * The composite scope string sent to the token endpoint lives in
 * `microsoft-token.ts` (it owns the per-transport requirement table) and is
 * re-exported here rather than re-declared, so there is exactly one definition.
 * What this file adds is the individual scope identifiers, which callers need in
 * order to say *which* permission is missing when Graph answers 403 — the token
 * layer only knows that one of them was absent.
 *
 * Graph scopes are fully qualified against the Graph resource on purpose: the
 * Outlook REST resource publishes its own `Mail.Read`, and a token granted that
 * one cannot call Graph (invariant I-4).
 */

export { MICROSOFT_GRAPH_TOKEN_SCOPE } from './microsoft-token'

export const GRAPH_RESOURCE = 'https://graph.microsoft.com/'

/** Read mail. Sufficient for listing folders, messages and MIME content. */
export const GRAPH_MAIL_READ_SCOPE = `${GRAPH_RESOURCE}Mail.Read`
/** Required by read-state write-back; a mailbox without it can only be read. */
export const GRAPH_MAIL_READ_WRITE_SCOPE = `${GRAPH_RESOURCE}Mail.ReadWrite`
export const GRAPH_USER_READ_SCOPE = `${GRAPH_RESOURCE}User.Read`
export const GRAPH_OFFLINE_ACCESS_SCOPE = 'offline_access'

/** Which scope a Graph operation needs, for turning a 403 into an actionable message. */
export const GRAPH_SCOPE_FOR_OPERATION = {
  listFolders: GRAPH_MAIL_READ_SCOPE,
  listMessages: GRAPH_MAIL_READ_SCOPE,
  getMessage: GRAPH_MAIL_READ_SCOPE,
  markRead: GRAPH_MAIL_READ_WRITE_SCOPE,
} as const

export type MicrosoftGraphOperation = keyof typeof GRAPH_SCOPE_FOR_OPERATION

/**
 * Whether a granted scope string covers `required`.
 *
 * An empty granted string means Microsoft did not echo the scope back, which is
 * not evidence of denial — treat it as granted and let the API answer 403 if the
 * permission really is missing, rather than blocking a working mailbox on an
 * absent field.
 */
export function graphScopeGranted(granted: string, required: string): boolean {
  const items = granted.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!items.length) return true
  return items.includes(required.toLowerCase())
}
