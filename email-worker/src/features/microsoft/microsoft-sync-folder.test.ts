import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../../app/types'
import { MicrosoftGraphError } from './microsoft-graph'
import {
  missingMicrosoftRemoteIds,
  refreshMicrosoftFolderWithTransport,
} from './microsoft-sync-folder'
import type { MicrosoftMailTransport } from './microsoft-transport'
import type { MicrosoftMessageMetadata, MicrosoftTransport } from './microsoft-types'

type Statement = { sql: string; bindings: unknown[] }

/** A real Graph id is 140 opaque characters; nothing about it is numeric. */
const GRAPH_ID = 'AAMkAGI2THVSAAA'.padEnd(139, 'A') + '='
const GRAPH_ID_OLD = 'AAMkAGI2THVSBBB'.padEnd(139, 'B') + '='

function metadata(remoteId: string, uidValidity: number | null): MicrosoftMessageMetadata {
  return {
    remoteId,
    uidValidity,
    internetMessageId: `<${remoteId.slice(0, 8)}@example.com>`,
    senderName: 'Sender',
    senderAddress: 'sender@example.com',
    recipients: ['user@outlook.com'],
    cc: [],
    subject: 'Subject',
    preview: 'Preview',
    receivedAt: 1_700_000_000,
    sentAt: null,
    sizeBytes: 0,
    flags: [],
    isRead: false,
    isStarred: false,
    hasAttachments: false,
  }
}

function fakeDb(options: {
  folder?: { uid_validity: number | null } | null
  local?: string[]
} = {}) {
  const statements: Statement[] = []
  const batches: Statement[][] = []
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...bindings: unknown[]) {
            const statement = { sql, bindings }
            statements.push(statement)
            return {
              ...statement,
              first: async () => (
                sql.includes('FROM microsoft_imap_folders')
                  ? (options.folder === undefined ? { uid_validity: null } : options.folder)
                  : null
              ),
              all: async () => ({
                results: sql.includes('SELECT remote_id')
                  ? (options.local ?? []).map((remote_id) => ({ remote_id }))
                  : [],
              }),
              run: async () => ({ meta: { changes: 1 } }),
            }
          },
        }
      },
      batch: async (items: Statement[]) => {
        batches.push(items.map(({ sql, bindings }) => ({ sql, bindings })))
        return []
      },
    },
  } as unknown as Env
  return { env, statements, batches }
}

function fakeTransport(
  kind: MicrosoftTransport,
  remoteIds: string[],
  overrides: Partial<MicrosoftMailTransport> = {},
) {
  const uidValidity = kind === 'imap' ? 42 : null
  const calls: string[] = []
  const transport: MicrosoftMailTransport = {
    transport: kind,
    open: async () => { calls.push('open') },
    close: async () => { calls.push('close') },
    listFolders: async () => [],
    folderState: async (path) => {
      calls.push(`folderState(${path})`)
      return { uidValidity, exists: remoteIds.length }
    },
    listRemoteIds: async (path) => {
      calls.push(`listRemoteIds(${path})`)
      return remoteIds
    },
    listRecentMetadata: async (path, { limit }) => {
      calls.push(`listRecentMetadata(${path},${limit})`)
      return remoteIds.slice(-limit).reverse().map((id) => metadata(id, uidValidity))
    },
    getMessage: async () => { throw new Error('not used') },
    markSeen: async () => undefined,
    ...overrides,
  }
  return { transport, calls }
}

function batched(batches: Statement[][]): Statement[] {
  return batches.flat()
}

const insert = ({ sql }: Statement) => sql.includes('INSERT INTO microsoft_imap_messages')
const deleteByRemoteId = ({ sql }: Statement) => (
  sql.includes('DELETE FROM microsoft_imap_messages') && sql.includes('remote_id = ?')
)
const wipe = ({ sql }: Statement) => (
  sql.includes('DELETE FROM microsoft_imap_messages')
  && !sql.includes('remote_id = ?') && !sql.includes('NOT IN')
)
const trim = ({ sql }: Statement) => (
  sql.includes('DELETE FROM microsoft_imap_messages') && sql.includes('NOT IN')
)
const folderUpdate = ({ sql }: Statement) => sql.includes('UPDATE microsoft_imap_folders')

describe('Microsoft folder refresh through the transport interface', () => {
  it('diffs local against remote ids as opaque strings', () => {
    expect(missingMicrosoftRemoteIds(['10', '11', '12'], ['10', '12', '13'])).toEqual(['11'])
    expect(missingMicrosoftRemoteIds([GRAPH_ID, GRAPH_ID_OLD], [GRAPH_ID])).toEqual([GRAPH_ID_OLD])
  })

  it('stamps IMAP rows with source_transport, the UID as a string and the mailbox UIDVALIDITY', async () => {
    const { env, batches } = fakeDb({ folder: { uid_validity: 42 } })
    const { transport } = fakeTransport('imap', ['5', '6', '7'])
    const result = await refreshMicrosoftFolderWithTransport(env, 'acct', 'INBOX', 2, transport, 1_700_000_100)

    const inserts = batched(batches).filter(insert)
    expect(inserts).toHaveLength(2)
    expect(inserts[0].bindings.slice(1, 6)).toEqual(['acct', 'INBOX', 'imap', '7', 42])
    expect(result).toMatchObject({ indexed: 2, reconciled: true, uidValidity: 42 })
  })

  it('stamps Graph rows with source_transport graph, the opaque id and a null uid_validity', async () => {
    const { env, batches } = fakeDb()
    const { transport } = fakeTransport('graph', [GRAPH_ID_OLD, GRAPH_ID])
    const result = await refreshMicrosoftFolderWithTransport(env, 'acct', 'INBOX', 5, transport, 1_700_000_100)

    const inserts = batched(batches).filter(insert)
    expect(inserts).toHaveLength(2)
    expect(inserts[0].bindings.slice(1, 6)).toEqual(['acct', 'INBOX', 'graph', GRAPH_ID, null])
    expect(result).toMatchObject({ indexed: 2, reconciled: true, uidValidity: null })
  })

  it('deletes only same-transport rows that vanished remotely (IMAP)', async () => {
    const { env, statements, batches } = fakeDb({ folder: { uid_validity: 42 }, local: ['5', '6', '7'] })
    const { transport } = fakeTransport('imap', ['6', '7'])
    await refreshMicrosoftFolderWithTransport(env, 'acct', 'INBOX', 2, transport, 1_700_000_100)

    const localQuery = statements.find(({ sql }) => sql.includes('SELECT remote_id'))
    expect(localQuery?.bindings.slice(0, 3)).toEqual(['acct', 'INBOX', 'imap'])
    const deletes = batched(batches).filter(deleteByRemoteId)
    expect(deletes.map(({ bindings }) => bindings)).toEqual([['acct', 'INBOX', 'imap', '5']])
  })

  it('deletes only same-transport rows that vanished remotely (Graph)', async () => {
    const { env, statements, batches } = fakeDb({ local: [GRAPH_ID_OLD, GRAPH_ID] })
    const { transport } = fakeTransport('graph', [GRAPH_ID])
    await refreshMicrosoftFolderWithTransport(env, 'acct', 'INBOX', 2, transport, 1_700_000_100)

    const localQuery = statements.find(({ sql }) => sql.includes('SELECT remote_id'))
    expect(localQuery?.bindings.slice(0, 3)).toEqual(['acct', 'INBOX', 'graph'])
    const deletes = batched(batches).filter(deleteByRemoteId)
    expect(deletes.map(({ bindings }) => bindings)).toEqual([['acct', 'INBOX', 'graph', GRAPH_ID_OLD]])
  })

  it('never scopes a delete by anything other than the transport that produced the row', async () => {
    const { env, batches } = fakeDb({ local: [GRAPH_ID_OLD] })
    const { transport } = fakeTransport('graph', [GRAPH_ID])
    await refreshMicrosoftFolderWithTransport(env, 'acct', 'INBOX', 2, transport, 1_700_000_100)
    for (const statement of batched(batches).filter(({ sql }) => sql.startsWith('DELETE'))) {
      expect(statement.sql).toContain('source_transport = ?')
      expect(statement.sql).not.toMatch(/source_transport = '/)
    }
  })

  it('skips deletion reconciliation when the listing is truncated, and still indexes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { env, batches } = fakeDb({ local: [GRAPH_ID_OLD, GRAPH_ID] })
    const { transport } = fakeTransport('graph', [GRAPH_ID], {
      listRemoteIds: async () => {
        throw new MicrosoftGraphError('graph_listing_truncated', 502, true)
      },
    })
    const result = await refreshMicrosoftFolderWithTransport(env, 'acct', 'INBOX', 2, transport, 1_700_000_100)
    warn.mockRestore()

    expect(batched(batches).filter(deleteByRemoteId)).toHaveLength(0)
    expect(batched(batches).filter(insert)).toHaveLength(1)
    expect(result).toMatchObject({ indexed: 1, reconciled: false })
  })

  it('skips deletion reconciliation when the listing is throttled or times out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    for (const error of [
      new MicrosoftGraphError('graph_throttled', 429, true, 30),
      new MicrosoftGraphError('graph_timeout', 504, true),
    ]) {
      const { env, batches } = fakeDb({ local: [GRAPH_ID_OLD, GRAPH_ID] })
      const { transport } = fakeTransport('graph', [GRAPH_ID], {
        listRemoteIds: async () => { throw error },
      })
      const result = await refreshMicrosoftFolderWithTransport(env, 'acct', 'INBOX', 2, transport, 1_700_000_100)
      expect(batched(batches).filter(deleteByRemoteId)).toHaveLength(0)
      expect(result.reconciled).toBe(false)
    }
    warn.mockRestore()
  })

  it('wipes only IMAP rows when UIDVALIDITY changes and does not diff against the stale set', async () => {
    const { env, batches } = fakeDb({ folder: { uid_validity: 41 }, local: ['5'] })
    const { transport, calls } = fakeTransport('imap', ['6', '7'])
    await refreshMicrosoftFolderWithTransport(env, 'acct', 'INBOX', 2, transport, 1_700_000_100)

    const wipes = batched(batches).filter(wipe)
    expect(wipes.map(({ bindings }) => bindings)).toEqual([['acct', 'INBOX', 'imap']])
    expect(batched(batches).filter(deleteByRemoteId)).toHaveLength(0)
    expect(calls).not.toContain('listRemoteIds(INBOX)')
    // The wipe must precede the re-insert of the same folder's rows.
    const order = batched(batches).map((statement) => (wipe(statement) ? 'wipe' : insert(statement) ? 'insert' : ''))
    expect(order.indexOf('wipe')).toBeLessThan(order.indexOf('insert'))
  })

  it('never wipes on Graph, even when the folder row still carries an IMAP UIDVALIDITY', async () => {
    const { env, batches } = fakeDb({ folder: { uid_validity: 41 }, local: [GRAPH_ID] })
    const { transport } = fakeTransport('graph', [GRAPH_ID])
    await refreshMicrosoftFolderWithTransport(env, 'acct', 'INBOX', 2, transport, 1_700_000_100)
    expect(batched(batches).filter(wipe)).toHaveLength(0)
  })

  it('keeps the IMAP UIDVALIDITY on the folder row when Graph syncs the same folder', async () => {
    const graph = fakeDb({ folder: { uid_validity: 41 } })
    await refreshMicrosoftFolderWithTransport(
      graph.env, 'acct', 'INBOX', 2, fakeTransport('graph', [GRAPH_ID]).transport, 1_700_000_100,
    )
    const graphUpdate = batched(graph.batches).find(folderUpdate)
    expect(graphUpdate?.sql).toMatch(/uid_validity = COALESCE\(\?, uid_validity\)/)
    expect(graphUpdate?.bindings).toEqual([null, 1_700_000_100, 'acct', 'INBOX'])

    const imap = fakeDb({ folder: { uid_validity: 42 } })
    await refreshMicrosoftFolderWithTransport(
      imap.env, 'acct', 'INBOX', 2, fakeTransport('imap', ['7']).transport, 1_700_000_100,
    )
    expect(batched(imap.batches).find(folderUpdate)?.bindings)
      .toEqual([42, 1_700_000_100, 'acct', 'INBOX'])
  })

  it('does not write an IMAP high-water UID from the orchestrator', async () => {
    const { env, batches } = fakeDb()
    await refreshMicrosoftFolderWithTransport(
      env, 'acct', 'INBOX', 2, fakeTransport('graph', [GRAPH_ID]).transport, 1_700_000_100,
    )
    expect(batched(batches).find(folderUpdate)?.sql).not.toContain('last_uid')
  })

  it('trims retention within the transport that is syncing', async () => {
    const { env, batches } = fakeDb()
    await refreshMicrosoftFolderWithTransport(
      env, 'acct', 'INBOX', 2, fakeTransport('graph', [GRAPH_ID]).transport, 1_700_000_100,
    )
    const trimStatement = batched(batches).find(trim)
    expect(trimStatement?.bindings).toEqual(['acct', 'INBOX', 'graph', 'acct', 'INBOX', 'graph', 500])
  })

  it('asks the transport for at least as many messages as are already indexed', async () => {
    const { env } = fakeDb({ local: ['1', '2', '3'] })
    const { transport, calls } = fakeTransport('imap', ['1', '2', '3', '4'])
    await refreshMicrosoftFolderWithTransport(env, 'acct', 'INBOX', 2, transport, 1_700_000_100)
    expect(calls).toContain('listRecentMetadata(INBOX,3)')
  })

  it('refuses to index into a folder that has no row, because the FK would reject it', async () => {
    const { env } = fakeDb({ folder: null })
    await expect(refreshMicrosoftFolderWithTransport(
      env, 'acct', 'Nowhere', 2, fakeTransport('graph', []).transport, 1_700_000_100,
    )).rejects.toMatchObject({ code: 'folder_not_found' })
  })
})
