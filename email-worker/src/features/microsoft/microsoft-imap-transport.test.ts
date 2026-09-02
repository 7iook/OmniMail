import { describe, expect, it, vi } from 'vitest'
import { microsoftImapTransport } from './microsoft-imap-transport'
import type { MicrosoftImapClient } from './microsoft-imap'

function imapClient(overrides: Partial<MicrosoftImapClient> = {}) {
  const calls: string[] = []
  const client = {
    open: vi.fn(async () => { calls.push('open') }),
    close: vi.fn(async () => { calls.push('close') }),
    listFolders: vi.fn(async () => {
      calls.push('listFolders')
      return [{
        path: 'INBOX', displayName: 'INBOX', flags: [], specialUse: '\\inbox',
        uidValidity: null, lastUid: 0,
      }]
    }),
    examineFolder: vi.fn(async () => {
      calls.push('examineFolder')
      return { uidValidity: 42, exists: 3 }
    }),
    searchAllUids: vi.fn(async () => {
      calls.push('searchAllUids')
      return [5, 6, 7]
    }),
    fetchMetadata: vi.fn(async (uids: number[]) => {
      calls.push(`fetchMetadata(${uids.join(',')})`)
      return uids.map((uid) => ({ remoteId: String(uid) }))
    }),
    getMessage: vi.fn(async (folder: string, uid: number) => {
      calls.push(`getMessage(${folder},${uid})`)
      return { message: { id: String(uid) }, parsedAttachments: [] }
    }),
    markSeen: vi.fn(async (folder: string, uid: number, expected: number) => {
      calls.push(`markSeen(${folder},${uid},${expected})`)
    }),
    ...overrides,
  } as unknown as MicrosoftImapClient
  return { client, calls }
}

describe('Microsoft IMAP transport adapter', () => {
  it('reports itself as the imap transport', () => {
    const { client } = imapClient()
    expect(microsoftImapTransport(client).transport).toBe('imap')
  })

  it('opens and closes through the underlying IMAP connection unchanged', async () => {
    const { client, calls } = imapClient()
    const transport = microsoftImapTransport(client)
    await transport.open()
    await transport.close()
    expect(calls).toEqual(['open', 'close'])
  })

  it('reports folder state with the real UIDVALIDITY, never a fabricated one', async () => {
    const { client } = imapClient()
    await expect(microsoftImapTransport(client).folderState('INBOX'))
      .resolves.toEqual({ uidValidity: 42, exists: 3 })
  })

  it('lists remote ids as strings so Graph ids fit the same contract', async () => {
    const { client } = imapClient()
    await expect(microsoftImapTransport(client).listRemoteIds('INBOX'))
      .resolves.toEqual(['5', '6', '7'])
  })

  it('fetches the newest messages by slicing the ascending UID set', async () => {
    const { client, calls } = imapClient()
    const metadata = await microsoftImapTransport(client)
      .listRecentMetadata('INBOX', { limit: 2 })
    expect(metadata.map(({ remoteId }) => remoteId)).toEqual(['6', '7'])
    expect(calls).toContain('fetchMetadata(6,7)')
  })

  it('stamps the mailbox UIDVALIDITY onto metadata the parser cannot know', async () => {
    const { client } = imapClient()
    const metadata = await microsoftImapTransport(client)
      .listRecentMetadata('INBOX', { limit: 5 })
    expect(metadata.every(({ uidValidity }) => uidValidity === 42)).toBe(true)
  })

  it('addresses a message by its stored string remote id', async () => {
    const { client, calls } = imapClient()
    await microsoftImapTransport(client).getMessage('INBOX', '7')
    expect(calls).toContain('getMessage(INBOX,7)')
  })

  it('rejects a remote id that is not an IMAP UID instead of sending NaN', async () => {
    const { client } = imapClient()
    const graphId = 'AAMkAGI2THVSAAA='
    await expect(microsoftImapTransport(client).getMessage('INBOX', graphId))
      .rejects.toMatchObject({ status: 400 })
    await expect(microsoftImapTransport(client).markSeen('INBOX', '0', 42))
      .rejects.toMatchObject({ status: 400 })
  })

  it('passes the expected UIDVALIDITY through, and 0 when the row has none', async () => {
    const { client, calls } = imapClient()
    const transport = microsoftImapTransport(client)
    await transport.markSeen('INBOX', '7', 42)
    await transport.markSeen('INBOX', '7', null)
    expect(calls).toContain('markSeen(INBOX,7,42)')
    expect(calls).toContain('markSeen(INBOX,7,0)')
  })
})
