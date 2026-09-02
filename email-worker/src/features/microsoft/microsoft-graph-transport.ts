import {
  MicrosoftGraphError,
  type MicrosoftGraphClient,
  type MicrosoftGraphFolder,
} from './microsoft-graph'
import {
  parseMicrosoftGraphMetadata,
  parseMicrosoftMessage,
} from './microsoft-message-parser'
import { MICROSOFT_GRAPH_SUBSCRIBED_FOLDERS } from './microsoft-types'
import type { MicrosoftFolder, MicrosoftMessageMetadata } from './microsoft-types'
import type {
  MicrosoftFolderState,
  MicrosoftMailTransport,
  MicrosoftMessageContent,
  MicrosoftMetadataOptions,
} from './microsoft-transport'

/**
 * Graph's well-known name for the inbox.
 *
 * Folders must be addressed by well-known name or opaque id: on v1.0 there is no
 * property that identifies which returned folder is the inbox (`wellKnownName` is
 * beta-only and `displayName` is localised, so a mailbox in Chinese returns
 * "收件箱"). Measured during W3 — do not try to recognise it from the listing.
 */
const [MICROSOFT_GRAPH_INBOX_SPEC, MICROSOFT_GRAPH_JUNK_SPEC] = MICROSOFT_GRAPH_SUBSCRIBED_FOLDERS
const GRAPH_INBOX = MICROSOFT_GRAPH_INBOX_SPEC.wellKnownName

/**
 * The path the rest of the codebase uses for the inbox.
 *
 * Sync, the message API and the account API all locate the inbox with
 * `path.toUpperCase() === 'INBOX'`, so a Graph mailbox whose inbox is called
 * "收件箱" would present as having no inbox at all — imports would succeed and the
 * mailbox would render empty (link table node 7).
 */
const INBOX_PATH = MICROSOFT_GRAPH_INBOX_SPEC.folderPath

/**
 * The inbox, as a folder row addressed by well-known name.
 *
 * Synthesised rather than picked out of the listing because v1.0 offers no way to
 * recognise it there. `totalItemCount` is left unknown; `folderState` reports what
 * the listing knows and `null` otherwise, which is the honest answer.
 */
const INBOX_FOLDER: MicrosoftGraphFolder = { id: GRAPH_INBOX, displayName: 'INBOX' }

/**
 * Junk Email, addressed and synthesised exactly like the inbox above (decision
 * card §12 recon §14): a mailbox in Chinese calls this folder "垃圾邮件" in its
 * `displayName`, so it must never be identified from the listing either. The
 * well-known name `junkemail` and the fixed literal path both come from
 * `microsoft-types.ts` (card C-4 / C-7) so the notification subscription's
 * `resource` string and this transport's `folder_path` never drift apart.
 */
const GRAPH_JUNK = MICROSOFT_GRAPH_JUNK_SPEC.wellKnownName
const JUNK_PATH = MICROSOFT_GRAPH_JUNK_SPEC.folderPath
const JUNK_PATH_UPPER = JUNK_PATH.toUpperCase()
const JUNK_FOLDER: MicrosoftGraphFolder = { id: GRAPH_JUNK, displayName: JUNK_PATH }

/**
 * Page budget for the id-only listing that deletion reconciliation consumes.
 *
 * The client defaults (50 x 40) would report any folder above 2000 messages as
 * truncated on every sync, and a truncated listing is skipped — so such a folder
 * would never reconcile. Ids are tiny, so wide pages cost little; the ceiling is
 * still finite so a runaway mailbox cannot pin a Worker invocation.
 */
const REMOTE_ID_PAGE_SIZE = 500
const REMOTE_ID_MAX_PAGES = 20

/**
 * Presents a Graph mailbox as the same transport-agnostic mailbox as IMAP.
 *
 * Where Graph has no equivalent of an IMAP concept, this reports the absence
 * rather than fabricating a value:
 *  - `uidValidity` is always `null`. Inventing an integer would create a second,
 *    fake identity source (decision card §3.2).
 *  - `open()` performs a real cheap request. HTTP has no handshake, and "the
 *    constructor did not throw" is not evidence a channel works.
 */
export function microsoftGraphTransport(
  client: MicrosoftGraphClient,
): MicrosoftMailTransport {
  /**
   * Folder metadata, keyed by the path this adapter exposes.
   *
   * Populated by the probe and by `listFolders`. It exists because every Graph
   * message call needs a folder id while every caller holds an IMAP-style path;
   * without it each call would re-list the whole mailbox.
   */
  let folders = new Map<string, MicrosoftGraphFolder>()

  async function loadFolders(): Promise<MicrosoftFolder[]> {
    const remote = await client.listFolders()
    const next = new Map<string, MicrosoftGraphFolder>()
    // The inbox and Junk Email are always exposed under their literal paths,
    // addressed by well-known name. Neither is matched against the listing:
    // v1.0 has no property that identifies either there, so any such match
    // would be guesswork (and would break on a localised mailbox).
    next.set(INBOX_PATH, INBOX_FOLDER)
    next.set(JUNK_PATH, JUNK_FOLDER)
    const mapped: MicrosoftFolder[] = [{
      path: INBOX_PATH,
      displayName: INBOX_PATH,
      flags: [],
      // Graph has no UIDVALIDITY, and leaving this NULL is what keeps the IMAP
      // wipe-on-UIDVALIDITY-change path from ever firing on a Graph folder.
      uidValidity: null,
      lastUid: 0,
      specialUse: '\\inbox',
    }, {
      path: JUNK_PATH,
      displayName: JUNK_PATH,
      flags: [],
      uidValidity: null,
      lastUid: 0,
      specialUse: '\\junk',
    }]
    for (const folder of remote) {
      const path = folder.displayName || folder.id
      // The inbox and Junk Email already occupy their literal paths under their
      // well-known names; the localised duplicate would otherwise shadow them
      // with an opaque id.
      if (path.toUpperCase() === INBOX_PATH || path.toUpperCase() === JUNK_PATH_UPPER || next.has(path)) continue
      next.set(path, folder)
      mapped.push({
        path,
        displayName: folder.displayName,
        flags: [],
        specialUse: '',
        uidValidity: null,
        lastUid: 0,
      })
    }
    folders = next
    return mapped
  }

  function folderId(folderPath: string): string {
    const folder = folders.get(folderPath)
    if (folder) return folder.id
    // The inbox and Junk Email are addressable without a prior listing thanks to
    // their well-known names; anything else genuinely requires one.
    if (folderPath.toUpperCase() === INBOX_PATH) return GRAPH_INBOX
    if (folderPath.toUpperCase() === JUNK_PATH_UPPER) return GRAPH_JUNK
    throw new MicrosoftGraphError('graph_invalid_folder', 404, false)
  }

  return {
    transport: 'graph',

    /**
     * Proves the channel with one cheap real request.
     *
     * `GET /me/mailFolders` doubles as the probe and as the folder-id resolution
     * every later call needs, so proving the channel costs nothing extra.
     */
    async open(): Promise<void> {
      await loadFolders()
    },

    async close(): Promise<void> {
      // No connection to tear down. Present so the orchestrator's finally-block
      // needs no knowledge of which transport it holds.
    },

    listFolders: () => loadFolders(),

    async folderState(folderPath: string): Promise<MicrosoftFolderState> {
      const folder = folders.get(folderPath)
      return {
        // Graph has no UIDVALIDITY. Reporting null is what stops the IMAP
        // identity check from firing on a Graph row.
        uidValidity: null,
        exists: folder?.totalItemCount ?? null,
      }
    },

    async listRemoteIds(folderPath: string): Promise<string[]> {
      // Throws `graph_listing_truncated` rather than returning a partial set:
      // deletion reconciliation reads absence as "deleted remotely".
      return await client.listMessageIds(folderId(folderPath), {
        pageSize: REMOTE_ID_PAGE_SIZE,
        maxPages: REMOTE_ID_MAX_PAGES,
      })
    },

    async listRecentMetadata(
      folderPath: string,
      options: MicrosoftMetadataOptions,
    ): Promise<MicrosoftMessageMetadata[]> {
      // Graph ids carry no order, so "newest N" is a server-side
      // `$orderby=receivedDateTime desc` plus a page budget — not a slice of the
      // id set the way IMAP's ascending UIDs allow.
      const pageSize = Math.min(Math.max(1, options.limit), 100)
      const { messages } = await client.listMessages(folderId(folderPath), {
        pageSize,
        maxPages: Math.max(1, Math.ceil(options.limit / pageSize)),
      })
      return messages
        .slice(0, options.limit)
        .map((message) => parseMicrosoftGraphMetadata({
          id: message.remoteId,
          internetMessageId: message.internetMessageId,
          subject: message.subject,
          bodyPreview: message.preview,
          isRead: message.isRead,
          hasAttachments: message.hasAttachments,
          receivedDateTime: new Date(message.receivedAt * 1_000).toISOString(),
          sentDateTime: message.sentAt === null
            ? undefined : new Date(message.sentAt * 1_000).toISOString(),
          from: { emailAddress: message.from ?? undefined },
          toRecipients: message.to.map((item) => ({ emailAddress: item })),
          ccRecipients: message.cc.map((item) => ({ emailAddress: item })),
        }))
    },

    async getMessage(
      _folderPath: string,
      remoteId: string,
    ): Promise<MicrosoftMessageContent> {
      // MIME rather than the JSON body: it feeds the same parser the IMAP path
      // uses, so attachment handling and inline images behave identically instead
      // of growing a second implementation.
      const mime = await client.getMessageMime(remoteId)
      return await parseMicrosoftMessage(new Uint8Array(mime), remoteId)
    },

    async markSeen(
      _folderPath: string,
      remoteId: string,
      _expectedUidValidity: number | null,
    ): Promise<void> {
      // UIDVALIDITY has no Graph equivalent; a message that no longer exists
      // surfaces as 404 from the PATCH instead.
      await client.markRead(remoteId)
    },
  }
}
