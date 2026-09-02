import { ImapConnectionError } from '../../platform/imap/imap-errors'
import type { MicrosoftImapClient } from './microsoft-imap'
import { parseMicrosoftImapUid } from './microsoft-imap-values'
import type { MicrosoftMessageMetadata } from './microsoft-types'
import type {
  MicrosoftFolderState,
  MicrosoftMailTransport,
  MicrosoftMessageContent,
  MicrosoftMetadataOptions,
} from './microsoft-transport'

/**
 * Turns the string remote id the interface speaks into the integer UID the IMAP
 * protocol requires.
 *
 * A Graph id reaching this path is a routing bug, not a malformed UID, but either
 * way it must fail before a `NaN` or `0` is interpolated into a UID command.
 */
function imapUid(remoteId: string): number {
  const uid = parseMicrosoftImapUid(remoteId)
  if (uid === null) {
    throw new ImapConnectionError(400, 'Microsoft 邮件 UID 无效。', true)
  }
  return uid
}

/**
 * Presents an IMAP client as a transport-agnostic mailbox.
 *
 * Behaviour is deliberately identical to calling the client directly — this is a
 * shape change, not a policy change. Two IMAP facts are absorbed here rather than
 * leaking to the orchestrator:
 *
 *  - "newest N messages" is a slice of the ascending UID set. That works because
 *    IMAP UIDs increase monotonically; Graph ids do not, so its implementation
 *    orders by `receivedDateTime` instead. Keeping the decision inside the
 *    transport is what lets the orchestrator stay branch-free.
 *  - UIDVALIDITY belongs to the mailbox, not to a FETCH line, so the parser
 *    cannot fill it in. It is stamped on here, where the folder has just been
 *    examined, instead of being left for the persistence layer to remember.
 */
export function microsoftImapTransport(
  client: MicrosoftImapClient,
): MicrosoftMailTransport {
  return {
    transport: 'imap',

    async open(): Promise<void> {
      await client.open()
    },

    async close(): Promise<void> {
      await client.close()
    },

    listFolders: () => client.listFolders(),

    async folderState(folderPath: string): Promise<MicrosoftFolderState> {
      return await client.examineFolder(folderPath)
    },

    async listRemoteIds(folderPath: string): Promise<string[]> {
      await client.examineFolder(folderPath)
      return (await client.searchAllUids()).map(String)
    },

    async listRecentMetadata(
      folderPath: string,
      options: MicrosoftMetadataOptions,
    ): Promise<MicrosoftMessageMetadata[]> {
      const mailbox = await client.examineFolder(folderPath)
      const uids = await client.searchAllUids()
      const metadata = await client.fetchMetadata(
        uids.slice(-Math.max(0, options.limit)),
        options.deadline,
      )
      return metadata.map((message) => ({ ...message, uidValidity: mailbox.uidValidity }))
    },

    async getMessage(folderPath: string, remoteId: string): Promise<MicrosoftMessageContent> {
      return await client.getMessage(folderPath, imapUid(remoteId))
    },

    async markSeen(
      folderPath: string,
      remoteId: string,
      expectedUidValidity: number | null,
    ): Promise<void> {
      // 0 can never be a real UIDVALIDITY, so a row without one fails the
      // server-side check rather than skipping it.
      await client.markSeen(folderPath, imapUid(remoteId), expectedUidValidity ?? 0)
    },
  }
}
