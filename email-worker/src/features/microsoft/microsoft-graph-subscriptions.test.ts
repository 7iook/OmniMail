import { describe, expect, it, vi } from 'vitest'
import {
  generateMicrosoftGraphClientState,
  microsoftGraphClientStateDigest,
  MicrosoftGraphSubscriptionClient,
  MicrosoftGraphSubscriptionError,
  timingSafeEqual,
} from './microsoft-graph-subscriptions'

type Call = { url: string; init: RequestInit | undefined }

function recorder() {
  const calls: Call[] = []
  return {
    calls,
    record(input: RequestInfo | URL, init?: RequestInit) {
      calls.push({ url: String(input), init })
    },
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
    subscriptions: new MicrosoftGraphSubscriptionClient({
      accessToken: 'graph-access-token',
      fetcher,
      sleeper,
    }),
  }
}

function subscription(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    id: 'sub-1',
    resource: "me/mailFolders('inbox')/messages",
    notificationUrl: 'https://omni-mail.example.workers.dev/api/microsoft/graph/notifications',
    expirationDateTime: '2026-09-09T00:00:00Z',
    ...overrides,
  })
}

function throttled(retryAfter?: string): Response {
  return new Response('', {
    status: 429,
    headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter },
  })
}

describe('Microsoft Graph subscription client · create', () => {
  it('POSTs the exact body shape Graph expects', async () => {
    const { subscriptions, log } = client([() => subscription()])

    const result = await subscriptions.create({
      wellKnownFolder: 'inbox',
      notificationUrl: 'https://omni-mail.example.workers.dev/api/microsoft/graph/notifications',
      lifecycleNotificationUrl: 'https://omni-mail.example.workers.dev/api/microsoft/graph/lifecycle',
      clientState: 'the-client-state',
      expiresAt: 1_700_000_000,
    })

    expect(result).toEqual({
      subscriptionId: 'sub-1',
      resource: "me/mailFolders('inbox')/messages",
      notificationUrl: 'https://omni-mail.example.workers.dev/api/microsoft/graph/notifications',
      expiresAt: Math.floor(Date.parse('2026-09-09T00:00:00Z') / 1_000),
    })
    expect(log.calls).toHaveLength(1)
    expect(log.calls[0].url).toBe('https://graph.microsoft.com/v1.0/subscriptions')
    expect(log.calls[0].init?.method).toBe('POST')
    const body = JSON.parse(log.calls[0].init?.body as string)
    expect(body).toEqual({
      changeType: 'created',
      resource: "me/mailFolders('inbox')/messages",
      notificationUrl: 'https://omni-mail.example.workers.dev/api/microsoft/graph/notifications',
      lifecycleNotificationUrl: 'https://omni-mail.example.workers.dev/api/microsoft/graph/lifecycle',
      expirationDateTime: new Date(1_700_000_000 * 1_000).toISOString(),
      clientState: 'the-client-state',
    })
  })

  it('uses the junkemail well-known folder verbatim in the resource string', async () => {
    const { subscriptions, log } = client([() => subscription()])
    await subscriptions.create({
      wellKnownFolder: 'junkemail',
      notificationUrl: 'https://x/notifications',
      lifecycleNotificationUrl: 'https://x/lifecycle',
      clientState: 'state',
      expiresAt: 1_700_000_000,
    })
    const body = JSON.parse(log.calls[0].init?.body as string)
    expect(body.resource).toBe("me/mailFolders('junkemail')/messages")
  })

  it('does not replay a 5xx for a create: writes are never blindly retried', async () => {
    const { subscriptions, fetcher, sleeper } = client([() => new Response('', { status: 503 })])

    const error = await subscriptions.create({
      wellKnownFolder: 'inbox',
      notificationUrl: 'https://x/notifications',
      lifecycleNotificationUrl: 'https://x/lifecycle',
      clientState: 'state',
      expiresAt: 1_700_000_000,
    }).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(MicrosoftGraphSubscriptionError)
    expect((error as MicrosoftGraphSubscriptionError).code).toBe('graph_subscription_transient')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(sleeper).not.toHaveBeenCalled()
  })

  it('classifies a 403 as rejected, not transient', async () => {
    const { subscriptions, fetcher } = client([
      () => new Response('', { status: 403 }),
    ])

    const error = await subscriptions.create({
      wellKnownFolder: 'inbox',
      notificationUrl: 'https://x/notifications',
      lifecycleNotificationUrl: 'https://x/lifecycle',
      clientState: 'state',
      expiresAt: 1_700_000_000,
    }).catch((thrown: unknown) => thrown)

    expect((error as MicrosoftGraphSubscriptionError).code).toBe('graph_subscription_rejected')
    expect((error as MicrosoftGraphSubscriptionError).status).toBe(403)
    expect((error as MicrosoftGraphSubscriptionError).retryable).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('waits the Retry-After seconds on a 429 before retrying a create', async () => {
    const { subscriptions, fetcher, sleeper, waits } = client([
      () => throttled('9'),
      () => subscription(),
    ])

    await subscriptions.create({
      wellKnownFolder: 'inbox',
      notificationUrl: 'https://x/notifications',
      lifecycleNotificationUrl: 'https://x/lifecycle',
      clientState: 'state',
      expiresAt: 1_700_000_000,
    })

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(sleeper).toHaveBeenCalledTimes(1)
    expect(waits).toEqual([9_000])
  })
})

describe('Microsoft Graph subscription client · renew', () => {
  it('PATCHes the subscription with a new expirationDateTime', async () => {
    const { subscriptions, log } = client([() => subscription({ expirationDateTime: '2026-09-16T00:00:00Z' })])

    const result = await subscriptions.renew('sub-1', 1_700_600_000)

    expect(log.calls[0].url).toBe('https://graph.microsoft.com/v1.0/subscriptions/sub-1')
    expect(log.calls[0].init?.method).toBe('PATCH')
    expect(JSON.parse(log.calls[0].init?.body as string)).toEqual({
      expirationDateTime: new Date(1_700_600_000 * 1_000).toISOString(),
    })
    expect(result.expiresAt).toBe(Math.floor(Date.parse('2026-09-16T00:00:00Z') / 1_000))
  })
})

describe('Microsoft Graph subscription client · remove', () => {
  it('DELETEs the subscription', async () => {
    const { subscriptions, log } = client([() => new Response(null, { status: 204 })])
    await subscriptions.remove('sub-1')
    expect(log.calls[0].url).toBe('https://graph.microsoft.com/v1.0/subscriptions/sub-1')
    expect(log.calls[0].init?.method).toBe('DELETE')
  })

  it('treats a 404 as success — the goal is "it no longer exists"', async () => {
    const { subscriptions, fetcher } = client([() => new Response('', { status: 404 })])
    await expect(subscriptions.remove('already-gone')).resolves.toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('still surfaces a non-404 rejection', async () => {
    const { subscriptions } = client([() => new Response('', { status: 403 })])
    await expect(subscriptions.remove('sub-1')).rejects.toMatchObject({ code: 'graph_subscription_rejected' })
  })
})

describe('Microsoft Graph subscription client · list', () => {
  it('follows @odata.nextLink across pages rather than truncating', async () => {
    const nextLink = 'https://graph.microsoft.com/v1.0/subscriptions?$skiptoken=abc'
    const { subscriptions, log } = client([
      () => Response.json({
        value: [{ id: 'sub-1', resource: 'r1', notificationUrl: 'u1', expirationDateTime: '2026-09-09T00:00:00Z' }],
        '@odata.nextLink': nextLink,
      }),
      () => Response.json({
        value: [{ id: 'sub-2', resource: 'r2', notificationUrl: 'u2', expirationDateTime: '2026-09-09T00:00:00Z' }],
      }),
    ])

    const result = await subscriptions.list()

    expect(result.map(({ subscriptionId }) => subscriptionId)).toEqual(['sub-1', 'sub-2'])
    expect(log.calls).toHaveLength(2)
    expect(log.calls[1].url).toBe(nextLink)
  })

  it('rejects a nextLink that points off the Graph origin', async () => {
    const { subscriptions } = client([
      () => Response.json({
        value: [{ id: 'sub-1', resource: 'r1', notificationUrl: 'u1', expirationDateTime: '2026-09-09T00:00:00Z' }],
        '@odata.nextLink': 'https://evil.example.com/steal',
      }),
    ])

    await expect(subscriptions.list()).rejects.toMatchObject({ code: 'graph_subscription_rejected' })
  })
})

describe('Microsoft Graph subscription client · clientState (C-1)', () => {
  it('generates a different value on every call', () => {
    const a = generateMicrosoftGraphClientState()
    const b = generateMicrosoftGraphClientState()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThan(20)
  })

  it('digests deterministically and compares in constant time', async () => {
    const value = generateMicrosoftGraphClientState()
    const digestA = await microsoftGraphClientStateDigest(value)
    const digestB = await microsoftGraphClientStateDigest(value)
    expect(digestA).toBe(digestB)
    expect(digestA).toMatch(/^[0-9a-f]{64}$/)
    expect(timingSafeEqual(digestA, digestB)).toBe(true)
    expect(timingSafeEqual(digestA, await microsoftGraphClientStateDigest('other'))).toBe(false)
    expect(timingSafeEqual(digestA, 'short')).toBe(false)
  })
})
