import { describe, expect, it, vi } from 'vitest'
import { MicrosoftGraphError } from './microsoft-graph'
import { microsoftGraphTransport } from './microsoft-graph-transport'

function graphClient(overrides: Record<string, unknown> = {}) {
  const calls: string[] = []
  const client = {
    listFolders: vi.fn(async () => {
      calls.push('listFolders')
      return [
        { id: 'inbox-id', displayName: 'Inbox', totalItemCount: 4 },
        { id: 'sent-id', displayName: '已发送邮件', totalItemCount: 1 },
      ]
    }),
    listMessages: vi.fn(async (folder: string) => {
      calls.push(`listMessages(${folder})`)
      return { messages: [{ id: 'graph-1', internetMessageId: '<a@example.com>' }], truncated: false }
    }),
    listMessageIds: vi.fn(async (folder: string) => {
      calls.push(`listMessageIds(${folder})`)
      return ['graph-1', 'graph-2']
    }),
    getMessageMime: vi.fn(async (id: string) => {
      calls.push(`getMessageMime(${id})`)
      return new TextEncoder().encode(
        'Subject: Hi\r\nFrom: a@example.com\r\n\r\nBody\r\n',
      ).buffer
    }),
    markRead: vi.fn(async (id: string) => { calls.push(`markRead(${id})`) }),
    ...overrides,
  }
  return { client, calls }
}

describe('Microsoft Graph transport adapter', () => {
  it('reports itself as the graph transport', () => {
    const { client } = graphClient()
    expect(microsoftGraphTransport(client as never).transport).toBe('graph')
  })

  it('probes with a real request, because HTTP has no handshake to fail', async () => {
    const { client, calls } = graphClient()
    await microsoftGraphTransport(client as never).open()
    expect(calls.length).toBeGreaterThan(0)
  })

  it('fails open() when the probe fails, rather than reporting a working channel', async () => {
    const { client } = graphClient({
      listFolders: vi.fn(async () => {
        throw new MicrosoftGraphError('graph_credential_rejected', 401, false)
      }),
    })
    await expect(microsoftGraphTransport(client as never).open())
      .rejects.toBeInstanceOf(MicrosoftGraphError)
  })

  it('normalises the inbox to the literal INBOX path the rest of the code expects', async () => {
    const { client } = graphClient()
    await microsoftGraphTransport(client as never).open()
    const folders = await microsoftGraphTransport(client as never).listFolders()
    expect(folders.some(({ path }) => path === 'INBOX')).toBe(true)
  })

  it('reports a null uidValidity, never a fabricated integer', async () => {
    const { client } = graphClient()
    const transport = microsoftGraphTransport(client as never)
    await transport.open()
    const state = await transport.folderState('INBOX')
    expect(state.uidValidity).toBeNull()
  })

  it('reports a known item count for a listed folder and null for an unlisted one', async () => {
    const { client } = graphClient()
    const transport = microsoftGraphTransport(client as never)
    await transport.open()
    expect((await transport.folderState('已发送邮件')).exists).toBe(1)
    expect((await transport.folderState('Nowhere')).exists).toBeNull()
  })

  it('addresses the inbox by well-known name, not by a guessed listing entry', async () => {
    const { client, calls } = graphClient()
    const transport = microsoftGraphTransport(client as never)
    await transport.open()
    await transport.listRemoteIds('INBOX')
    expect(calls).toContain('listMessageIds(inbox)')
  })

  it('resolves a non-inbox path back to its opaque Graph folder id', async () => {
    const { client, calls } = graphClient()
    const transport = microsoftGraphTransport(client as never)
    await transport.open()
    await transport.listRemoteIds('已发送邮件')
    expect(calls).toContain('listMessageIds(sent-id)')
  })

  it('refuses an unknown folder rather than guessing an id', async () => {
    const { client } = graphClient()
    const transport = microsoftGraphTransport(client as never)
    await transport.open()
    await expect(transport.listRemoteIds('Nowhere')).rejects.toMatchObject({
      code: 'graph_invalid_folder',
    })
  })

  it('closes without a connection to tear down', async () => {
    const { client } = graphClient()
    await expect(microsoftGraphTransport(client as never).close()).resolves.toBeUndefined()
  })

  it('marks read through Graph using the opaque message id', async () => {
    const { client, calls } = graphClient()
    await microsoftGraphTransport(client as never).markSeen('INBOX', 'graph-1', null)
    expect(calls).toContain('markRead(graph-1)')
  })
})
