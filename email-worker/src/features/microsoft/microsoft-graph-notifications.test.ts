import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../../app/types'
import {
  handleMicrosoftGraphLifecycle,
  handleMicrosoftGraphNotification,
  MAX_NOTIFICATION_BODY_BYTES,
  MAX_NOTIFICATION_ITEMS,
  MICROSOFT_GRAPH_NOTIFICATION_PATH,
  type MicrosoftGraphNotificationItem,
} from './microsoft-graph-notifications'

const env = {} as Env
const ORIGIN = 'https://omni-mail.example.workers.dev'
const SUB_ID = 'c3f5f0a2-7b9e-4c6a-9d1e-0f2a3b4c5d6e'

function post(body: unknown, query = '', headers: Record<string, string> = {}): Request {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return new Request(`${ORIGIN}${MICROSOFT_GRAPH_NOTIFICATION_PATH}${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: text,
  })
}

function harness() {
  const deferred: Promise<unknown>[] = []
  const processed: MicrosoftGraphNotificationItem[][] = []
  const process = vi.fn(async (_env: Env, items: MicrosoftGraphNotificationItem[]) => {
    processed.push(items)
  })
  const run = (request: Request) => handleMicrosoftGraphNotification(
    env, request, '203.0.113.9', (task) => { deferred.push(task) }, process,
  )
  return { run, process, processed, settle: () => Promise.all(deferred) }
}

describe('Microsoft Graph notification endpoint · validation handshake (C-6 branch 1)', () => {
  it('echoes the validation token verbatim as text/plain and reads nothing else', async () => {
    const { run, process } = harness()
    const token = 'Validation: Testing client application reachability for subscription Request-Id: 1234'
    const request = post('{"value":[{"subscriptionId":"ignored"}]}', `?validationToken=${encodeURIComponent(token)}`)

    const response = await run(request)

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toMatch(/^text\/plain/)
    await expect(response.text()).resolves.toBe(token)
    expect(process).not.toHaveBeenCalled()
    // The body was never consumed: a handshake must not depend on it.
    expect(request.bodyUsed).toBe(false)
  })

  it('also answers the handshake on the lifecycle URL', async () => {
    const response = await handleMicrosoftGraphLifecycle(
      env,
      new Request(`${ORIGIN}/api/microsoft/graph/lifecycle?validationToken=abc`, { method: 'POST' }),
      '203.0.113.9', () => undefined, async () => undefined,
    )
    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('abc')
  })
})

describe('Microsoft Graph notification endpoint · notifications (C-6 branch 2, I-8)', () => {
  it('acknowledges with 202 before processing and defers the work', async () => {
    const { run, process, processed, settle } = harness()

    const response = await run(post({ value: [{
      subscriptionId: SUB_ID, clientState: 'secret', changeType: 'created', resource: 'me/mailFolders/inbox/messages/x',
    }] }))

    expect(response.status).toBe(202)
    await settle()
    expect(process).toHaveBeenCalledTimes(1)
    expect(processed[0]).toEqual([{
      subscriptionId: SUB_ID, clientState: 'secret', changeType: 'created', resource: 'me/mailFolders/inbox/messages/x',
    }])
  })

  it('answers 202 and processes nothing for malformed, oversized or non-JSON bodies', async () => {
    const { run, process, settle } = harness()
    const cases = [
      post('not json'),
      post({ nope: [] }),
      post({ value: 'not-an-array' }),
      post({ value: [] }, '', { 'content-length': String(MAX_NOTIFICATION_BODY_BYTES + 1) }),
      post('x'.repeat(MAX_NOTIFICATION_BODY_BYTES + 1)),
    ]
    for (const request of cases) {
      expect((await run(request)).status).toBe(202)
    }
    await settle()
    expect(process).not.toHaveBeenCalled()
  })

  it('drops malformed items individually and caps the batch, without changing the response', async () => {
    const { run, processed, settle } = harness()
    const good = { subscriptionId: SUB_ID, clientState: 's', changeType: 'created', resource: 'r' }
    const value = [
      good,
      { subscriptionId: 'not-a-uuid', clientState: 's' },
      { subscriptionId: SUB_ID },
      null,
      'string',
      ...Array.from({ length: MAX_NOTIFICATION_ITEMS + 10 }, () => good),
    ]

    const response = await run(post({ value }))

    expect(response.status).toBe(202)
    await settle()
    // The first MAX_NOTIFICATION_ITEMS raw entries are considered; 4 of them are junk.
    expect(processed[0]).toHaveLength(MAX_NOTIFICATION_ITEMS - 4)
  })

  it('never lets a processor failure change the response', async () => {
    const deferred: Promise<unknown>[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const response = await handleMicrosoftGraphNotification(
      env,
      post({ value: [{ subscriptionId: SUB_ID, clientState: 's' }] }),
      '203.0.113.9',
      (task) => { deferred.push(task) },
      async () => { throw new Error('boom') },
    )
    expect(response.status).toBe(202)
    await Promise.all(deferred)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })
})
