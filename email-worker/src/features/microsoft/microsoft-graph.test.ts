import { describe, expect, it, vi } from 'vitest'
import {
  GRAPH_ATTACHMENT_SELECT,
  GRAPH_MESSAGE_DETAIL_SELECT,
  GRAPH_MESSAGE_LIST_SELECT,
  MicrosoftGraphClient,
  MicrosoftGraphError,
} from './microsoft-graph'

type Call = { url: string; init: RequestInit | undefined }

function recorder() {
  const calls: Call[] = []
  return {
    calls,
    record(input: RequestInfo | URL, init?: RequestInit) {
      calls.push({ url: String(input), init })
    },
    urls: () => calls.map(({ url }) => url),
  }
}

function client(
  responses: Array<() => Response>,
  { waits = [] as number[] } = {},
) {
  const log = recorder()
  let index = 0
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    log.record(input, init)
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    return next()
  })
  const sleeper = vi.fn(async (ms: number) => { waits.push(ms) })
  return {
    log,
    fetcher,
    sleeper,
    waits,
    graph: new MicrosoftGraphClient({ accessToken: 'graph-access-token', fetcher, sleeper }),
  }
}

function throttled(retryAfter?: string): Response {
  return new Response(
    JSON.stringify({ error: { code: 'TooManyRequests', message: 'Please retry again later.' } }),
    {
      status: 429,
      headers: retryAfter === undefined
        ? { 'Content-Type': 'application/json' }
        : { 'Content-Type': 'application/json', 'Retry-After': retryAfter },
    },
  )
}

function messagePage(ids: string[], nextLink?: string): Response {
  return Response.json({
    value: ids.map((id) => ({
      id,
      internetMessageId: `<${id}@example.test>`,
      subject: `subject ${id}`,
      bodyPreview: `preview ${id}`,
      isRead: false,
      hasAttachments: false,
      receivedDateTime: '2026-09-01T10:00:00Z',
      sentDateTime: '2026-09-01T09:59:00Z',
      from: { emailAddress: { name: 'Sender', address: 'sender@example.test' } },
      toRecipients: [{ emailAddress: { name: 'Me', address: 'me@example.test' } }],
      ccRecipients: [],
    })),
    ...(nextLink ? { '@odata.nextLink': nextLink } : {}),
  })
}

describe('Microsoft Graph throttling', () => {
  it('waits the Retry-After seconds before retrying instead of retrying immediately', async () => {
    const { graph, fetcher, sleeper, waits } = client([
      () => throttled('7'),
      () => messagePage(['m1']),
    ])

    const page = await graph.listMessages('inbox')

    expect(page.messages).toHaveLength(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(sleeper).toHaveBeenCalledTimes(1)
    expect(waits).toEqual([7_000])
    // The wait must be ordered before the retry, not merely have happened.
    expect(sleeper.mock.invocationCallOrder[0])
      .toBeLessThan(fetcher.mock.invocationCallOrder[1])
  })

  it('falls back to exponential backoff when Graph omits Retry-After', async () => {
    const { graph, waits, fetcher } = client([
      () => throttled(),
      () => throttled(),
      () => messagePage(['m1']),
    ])

    await graph.listMessages('inbox')

    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(waits).toEqual([1_000, 2_000])
  })

  it('ignores a Retry-After that is not a positive number and backs off instead', async () => {
    const { graph, waits } = client([
      () => throttled('not-a-number'),
      () => messagePage(['m1']),
    ])

    await graph.listMessages('inbox')

    expect(waits).toEqual([1_000])
  })

  it('caps an absurd Retry-After so a single mailbox cannot stall the worker', async () => {
    const { graph, waits } = client([
      () => throttled('86400'),
      () => messagePage(['m1']),
    ])

    await graph.listMessages('inbox')

    expect(waits).toEqual([60_000])
  })

  it('surfaces a typed error carrying retry-after seconds when the retry budget runs out', async () => {
    const { graph, fetcher, waits } = client([() => throttled('11')])

    const error = await graph.listMessages('inbox').catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(MicrosoftGraphError)
    const graphError = error as MicrosoftGraphError
    expect(graphError.code).toBe('graph_throttled')
    expect(graphError.status).toBe(429)
    expect(graphError.retryAfterSeconds).toBe(11)
    expect(graphError.retryable).toBe(true)
    // 3 attempts total, so only 2 waits: never sleep after the final failure.
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(waits).toEqual([11_000, 11_000])
  })

  it('does not retry a 401 because a fresh token, not a wait, is what fixes it', async () => {
    const { graph, fetcher, sleeper } = client([
      () => Response.json({ error: { code: 'InvalidAuthenticationToken' } }, { status: 401 }),
    ])

    const error = await graph.listMessages('inbox').catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(MicrosoftGraphError)
    expect((error as MicrosoftGraphError).code).toBe('graph_credential_rejected')
    expect((error as MicrosoftGraphError).retryable).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(sleeper).not.toHaveBeenCalled()
  })

  it('classifies 403 as a permission problem distinct from an expired credential', async () => {
    const { graph } = client([
      () => Response.json({ error: { code: 'ErrorAccessDenied' } }, { status: 403 }),
    ])

    const error = await graph.markRead('AAMk-id').catch((thrown: unknown) => thrown)

    expect((error as MicrosoftGraphError).code).toBe('graph_permission_denied')
    expect((error as MicrosoftGraphError).status).toBe(403)
    expect((error as MicrosoftGraphError).retryable).toBe(false)
  })

  it('retries a 503 within budget and then reports it as retryable', async () => {
    const { graph, fetcher, waits } = client([
      () => new Response('', { status: 503 }),
    ])

    const error = await graph.listFolders().catch((thrown: unknown) => thrown)

    expect((error as MicrosoftGraphError).code).toBe('graph_unavailable')
    expect((error as MicrosoftGraphError).retryable).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(waits).toEqual([1_000, 2_000])
  })

  it('reports a network failure as retryable without leaking the transport error', async () => {
    const fetcher = vi.fn(async () => { throw new TypeError('boom: internal host detail') })
    const sleeper = vi.fn(async () => {})
    const graph = new MicrosoftGraphClient({ accessToken: 'token', fetcher, sleeper })

    const error = await graph.listFolders().catch((thrown: unknown) => thrown)

    expect((error as MicrosoftGraphError).code).toBe('graph_connection_failed')
    expect((error as MicrosoftGraphError).retryable).toBe(true)
    expect((error as Error).message).not.toContain('internal host detail')
  })
})

describe('Microsoft Graph pagination', () => {
  it('follows @odata.nextLink and returns every page rather than truncating', async () => {
    const nextLink = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=abc'
    const { graph, log, fetcher } = client([
      () => messagePage(['m1', 'm2'], nextLink),
      () => messagePage(['m3']),
    ])

    const page = await graph.listMessages('inbox')

    expect(page.messages.map(({ remoteId }) => remoteId)).toEqual(['m1', 'm2', 'm3'])
    expect(fetcher).toHaveBeenCalledTimes(2)
    // The second call must use the server-issued link verbatim, never computed $skip.
    expect(log.urls()[1]).toBe(nextLink)
    expect(log.urls()[1]).not.toContain('$skip=')
  })

  it('never computes $skip arithmetic on the first page either', async () => {
    const { graph, log } = client([() => messagePage(['m1'])])

    await graph.listMessages('inbox')

    expect(log.urls()[0]).not.toContain('$skip')
  })

  it('refuses a nextLink pointing off the Graph origin so a bad page cannot redirect the token', async () => {
    const { graph, fetcher } = client([
      () => messagePage(['m1'], 'https://evil.example/steal?token=1'),
    ])

    const error = await graph.listMessages('inbox').catch((thrown: unknown) => thrown)

    expect((error as MicrosoftGraphError).code).toBe('graph_invalid_next_link')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('stops at the page budget instead of following links forever', async () => {
    const selfLink = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=loop'
    const { graph, fetcher } = client([() => messagePage(['m1'], selfLink)])

    const page = await graph.listMessages('inbox', { maxPages: 3 })

    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(page.messages).toHaveLength(3)
    expect(page.truncated).toBe(true)
  })

  it('honours a Retry-After mid-pagination without losing the pages already collected', async () => {
    const nextLink = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=abc'
    const { graph, waits } = client([
      () => messagePage(['m1'], nextLink),
      () => throttled('4'),
      () => messagePage(['m2']),
    ])

    const page = await graph.listMessages('inbox')

    expect(page.messages.map(({ remoteId }) => remoteId)).toEqual(['m1', 'm2'])
    expect(waits).toEqual([4_000])
  })

  it('enumerates remote ids across pages for deletion reconciliation', async () => {
    const nextLink = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=abc'
    const { graph, log } = client([
      () => messagePage(['m1'], nextLink),
      () => messagePage(['m2']),
    ])

    const ids = await graph.listMessageIds('inbox')

    expect(ids).toEqual(['m1', 'm2'])
    // Reconciliation only needs ids, so it must not pull previews or recipients.
    expect(log.urls()[0]).toContain('%24select=id')
    expect(log.urls()[0]).not.toContain('bodyPreview')
  })
})

describe('Microsoft Graph endpoints', () => {
  it('narrows the message list with $select and orders newest first', async () => {
    const { graph, log } = client([() => messagePage(['m1'])])

    await graph.listMessages('inbox', { pageSize: 25 })

    const url = new URL(log.urls()[0])
    expect(url.origin + url.pathname)
      .toBe('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages')
    expect(url.searchParams.get('$select')).toBe(GRAPH_MESSAGE_LIST_SELECT)
    expect(url.searchParams.get('$top')).toBe('25')
    expect(url.searchParams.get('$orderby')).toBe('receivedDateTime desc')
  })

  it('selects only fields the v1.0 message resource actually has', async () => {
    // Graph's message resource has no `size` property; asking for it fails the
    // whole request. Message size is only reachable via PidTagMessageSize
    // (singleValueExtendedProperties 0x0E08), which is deliberately not in $select.
    expect(GRAPH_MESSAGE_LIST_SELECT.split(',')).not.toContain('size')
    expect(GRAPH_MESSAGE_LIST_SELECT.split(',')).toContain('internetMessageId')
    expect(GRAPH_MESSAGE_LIST_SELECT.split(',')).toContain('hasAttachments')
    expect(GRAPH_MESSAGE_LIST_SELECT.split(',')).toContain('bodyPreview')
  })

  it('requests message size through the extended property Graph does expose', async () => {
    const { graph, log } = client([() => messagePage(['m1'])])

    await graph.listMessages('inbox', { includeSize: true })

    const url = new URL(log.urls()[0])
    expect(url.searchParams.get('$expand'))
      .toBe("singleValueExtendedProperties($filter=id eq 'Integer 0x0E08')")
  })

  it('reads the extended size property back into sizeBytes', async () => {
    const { graph } = client([() => Response.json({
      value: [{
        id: 'm1',
        receivedDateTime: '2026-09-01T10:00:00Z',
        singleValueExtendedProperties: [{ id: 'Integer 0xe08', value: '100265' }],
      }],
    })])

    const page = await graph.listMessages('inbox', { includeSize: true })

    expect(page.messages[0].sizeBytes).toBe(100_265)
  })

  it('lists folders with the fields v1.0 exposes and no beta-only wellKnownName', async () => {
    const { graph, log } = client([() => Response.json({
      value: [{
        id: 'AAMk-inbox',
        displayName: 'Inbox',
        parentFolderId: 'AAMk-root',
        totalItemCount: 60,
        unreadItemCount: 59,
      }],
    })])

    const folders = await graph.listFolders()

    const url = new URL(log.urls()[0])
    expect(url.pathname).toBe('/v1.0/me/mailFolders')
    // wellKnownName is beta-only: selecting it on v1.0 rejects the request.
    expect(url.searchParams.get('$select')).not.toContain('wellKnownName')
    expect(folders).toEqual([{
      id: 'AAMk-inbox',
      displayName: 'Inbox',
      parentFolderId: 'AAMk-root',
      totalItemCount: 60,
      unreadItemCount: 59,
    }])
  })

  it('follows nextLink when a mailbox has more folders than one page', async () => {
    const nextLink = 'https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=f2'
    const { graph } = client([
      () => Response.json({
        value: [{ id: 'f1', displayName: 'Inbox' }],
        '@odata.nextLink': nextLink,
      }),
      () => Response.json({ value: [{ id: 'f2', displayName: 'Archive' }] }),
    ])

    expect((await graph.listFolders()).map(({ id }) => id)).toEqual(['f1', 'f2'])
  })
})

describe('Microsoft Graph single message access', () => {
  it('fetches raw MIME through $value and returns bytes, not JSON', async () => {
    const mime = 'From: a@example.test\r\nSubject: hi\r\n\r\nbody'
    const { graph, log } = client([() => new Response(mime, {
      headers: { 'Content-Type': 'text/plain' },
    })])

    const raw = await graph.getMessageMime('AAMk-id')

    expect(new TextDecoder().decode(raw)).toBe(mime)
    expect(log.urls()[0]).toBe('https://graph.microsoft.com/v1.0/me/messages/AAMk-id/$value')
  })

  it('percent-encodes an opaque message id so slashes cannot escape the path', async () => {
    const { graph, log } = client([() => new Response('mime')])

    await graph.getMessageMime('AA/Mk+id=')

    expect(log.urls()[0])
      .toBe('https://graph.microsoft.com/v1.0/me/messages/AA%2FMk%2Bid%3D/$value')
  })

  it('rejects an empty message id before spending a request', async () => {
    const { graph, fetcher } = client([() => new Response('mime')])

    const error = await graph.getMessageMime('  ').catch((thrown: unknown) => thrown)

    expect((error as MicrosoftGraphError).code).toBe('graph_invalid_message_id')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('asks for html body content when fetching one message content', async () => {
    const { graph, log } = client([() => Response.json({
      id: 'AAMk-id',
      internetMessageId: '<x@example.test>',
      subject: 'hello',
      receivedDateTime: '2026-09-01T10:00:00Z',
      body: { contentType: 'html', content: '<p>hi</p>' },
      bodyPreview: 'hi',
      from: { emailAddress: { name: 'S', address: 's@example.test' } },
      toRecipients: [],
      ccRecipients: [],
    })])

    const message = await graph.getMessageContent('AAMk-id')

    const url = new URL(log.urls()[0])
    expect(url.searchParams.get('$select')).toBe(GRAPH_MESSAGE_DETAIL_SELECT)
    expect(new Headers(log.calls[0].init?.headers).get('Prefer'))
      .toBe("outlook.body-content-type='html'")
    expect(message.body).toEqual({ contentType: 'html', content: '<p>hi</p>' })
  })

  it('marks a message read with PATCH isRead and treats 200 as success', async () => {
    const { graph, log } = client([() => Response.json({ id: 'AAMk-id', isRead: true })])

    await graph.markRead('AAMk-id')

    expect(log.urls()[0]).toBe('https://graph.microsoft.com/v1.0/me/messages/AAMk-id')
    expect(log.calls[0].init?.method).toBe('PATCH')
    expect(JSON.parse(String(log.calls[0].init?.body))).toEqual({ isRead: true })
  })

  it('accepts an empty 204 from PATCH without trying to parse a body', async () => {
    const { graph } = client([() => new Response(null, { status: 204 })])

    await expect(graph.markRead('AAMk-id')).resolves.toBeUndefined()
  })

  it('does not retry a failed mark-read, since a write must not be replayed blindly', async () => {
    const { graph, fetcher } = client([
      () => Response.json({ error: { code: 'ErrorItemNotFound' } }, { status: 404 }),
    ])

    const error = await graph.markRead('AAMk-id').catch((thrown: unknown) => thrown)

    expect((error as MicrosoftGraphError).code).toBe('graph_message_not_found')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('still honours Retry-After on a write because 429 is a wait, not a failure', async () => {
    const { graph, waits, fetcher } = client([
      () => throttled('3'),
      () => new Response(null, { status: 204 }),
    ])

    await graph.markRead('AAMk-id')

    expect(waits).toEqual([3_000])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('omits contentId from the attachment $select because Graph rejects that request', async () => {
    // contentId is readable in the response body but is not a selectable property;
    // including it makes Graph reject the whole request.
    expect(GRAPH_ATTACHMENT_SELECT.split(',')).not.toContain('contentId')
    const { graph, log } = client([() => Response.json({
      value: [{
        id: 'att1',
        name: 'a.pdf',
        contentType: 'application/pdf',
        size: 12,
        isInline: false,
        contentId: '<cid1>',
      }],
    })])

    const attachments = await graph.listAttachments('AAMk-id')

    expect(new URL(log.urls()[0]).searchParams.get('$select')).toBe(GRAPH_ATTACHMENT_SELECT)
    expect(attachments[0].contentId).toBe('<cid1>')
  })

  it('rejects a folder name that is not a Graph well-known folder', async () => {
    const { graph, fetcher } = client([() => messagePage(['m1'])])

    const error = await graph.listMessages('../../users/victim/messages')
      .catch((thrown: unknown) => thrown)

    expect((error as MicrosoftGraphError).code).toBe('graph_invalid_folder')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('accepts an opaque folder id alongside well-known names', async () => {
    const { graph, log } = client([() => messagePage(['m1'])])

    await graph.listMessages('AAMkAGVmMDEzMTM4LTZmYWUtNDdkNA==')

    expect(new URL(log.urls()[0]).pathname)
      .toBe('/v1.0/me/mailFolders/AAMkAGVmMDEzMTM4LTZmYWUtNDdkNA%3D%3D/messages')
  })

  it('sends the bearer token and asks for JSON on every request', async () => {
    const { graph, log } = client([() => messagePage(['m1'])])

    await graph.listMessages('inbox')

    const headers = new Headers(log.calls[0].init?.headers)
    expect(headers.get('Authorization')).toBe('Bearer graph-access-token')
    expect(headers.get('Accept')).toBe('application/json')
  })

  it('rejects an unparseable success body instead of returning empty results', async () => {
    const { graph } = client([() => new Response('<html>oops</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })])

    const error = await graph.listMessages('inbox').catch((thrown: unknown) => thrown)

    expect((error as MicrosoftGraphError).code).toBe('graph_invalid_response')
  })
})
