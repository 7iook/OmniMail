import type { parseMicrosoftMessage } from './microsoft-message-parser'
import type {
  MicrosoftFolder,
  MicrosoftMessageMetadata,
  MicrosoftTransport,
} from './microsoft-types'

/** What `parseMicrosoftMessage` yields — both transports end up in that parser. */
export type MicrosoftMessageContent = Awaited<ReturnType<typeof parseMicrosoftMessage>>

/**
 * A folder's live remote state.
 *
 * `uidValidity` is `null` for Graph, which has no such concept; consumers must
 * branch on that rather than expect a fabricated integer (decision card §3.2
 * forbids inventing one). `exists` is `null` when the transport cannot report a
 * count cheaply.
 */
export interface MicrosoftFolderState {
  uidValidity: number | null
  exists: number | null
}

export interface MicrosoftMetadataOptions {
  /** How many of the newest messages to pull. */
  limit: number
  /** Wall-clock deadline in epoch milliseconds. */
  deadline?: number
}

/**
 * One mailbox reached over one wire protocol.
 *
 * Both IMAP and Graph implement this, so orchestration never branches on which
 * transport it holds. Two shapes were deliberately generalised away from IMAP:
 *
 *  - message identity is a `string` remote id, not an integer UID. Graph ids are
 *    140-char opaque strings (measured), so an integer would physically not hold.
 *  - "which messages should I fetch" is decided by the transport, not the caller.
 *    IMAP can slice a monotonically increasing UID set; Graph ids have no order,
 *    so the equivalent has to be `$orderby=receivedDateTime`. Exposing the IMAP
 *    two-step (list ids, then fetch by id) would have forced the orchestrator to
 *    branch, which is what {@link listRecentMetadata} exists to prevent.
 */
export interface MicrosoftMailTransport {
  /** Which channel this instance speaks. Stamped onto rows as `source_transport`. */
  readonly transport: MicrosoftTransport

  /**
   * Establishes and proves the channel.
   *
   * IMAP has a real handshake. Graph has none, so its implementation must make a
   * cheap real request instead — "constructed without throwing" is not evidence a
   * channel works, and the cascade needs a definite failure point to judge.
   */
  open(): Promise<void>
  close(): Promise<void>

  listFolders(): Promise<MicrosoftFolder[]>
  folderState(folderPath: string): Promise<MicrosoftFolderState>

  /**
   * Every remote id currently present in a folder, for deletion reconciliation.
   *
   * Absence from this set means "deleted remotely", so an implementation must
   * fail rather than return a partial set.
   */
  listRemoteIds(folderPath: string): Promise<string[]>

  /** The newest `limit` messages' metadata, newest first. */
  listRecentMetadata(
    folderPath: string,
    options: MicrosoftMetadataOptions,
  ): Promise<MicrosoftMessageMetadata[]>

  getMessage(folderPath: string, remoteId: string): Promise<MicrosoftMessageContent>

  /**
   * Marks a message read remotely.
   *
   * `expectedUidValidity` is IMAP's optimistic concurrency check and is `null`
   * for Graph rows, whose implementations ignore it.
   */
  markSeen(
    folderPath: string,
    remoteId: string,
    expectedUidValidity: number | null,
  ): Promise<void>
}
