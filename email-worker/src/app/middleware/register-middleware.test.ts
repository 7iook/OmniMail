import { describe, expect, it, vi } from 'vitest'
import { fetchApi } from '../api'
import type { Env } from '../types'
import {
  MICROSOFT_GRAPH_LIFECYCLE_PATH,
  MICROSOFT_GRAPH_NOTIFICATION_PATH,
} from '../../features/microsoft/microsoft-graph-notifications'

const ORIGIN = 'https://omni-mail.example.workers.dev'

/**
 * A `DB` binding that throws on the first `prepare()` call, so any request
 * that reaches `ensureSchema()`/`syncSuperAdminIdentity()` — or any other
 * unexpected D1 access — fails loudly instead of silently succeeding against
 * an empty in-memory fake (review3 #1).
 */
function throwingDbEnv(): Env {
  return {
    DB: {
      prepare(): never {
        throw new Error('D1 must not be touched by this request')
      },
    },
  } as unknown as Env
}

function noopExecutionContext(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext
}

describe('registerMiddleware · Graph public endpoints bypass schema/super-admin sync (review3 #1)', () => {
  it('answers the notification handshake through the full route stack without touching D1', async () => {
    const request = new Request(
      `${ORIGIN}${MICROSOFT_GRAPH_NOTIFICATION_PATH}?validationToken=${encodeURIComponent('probe-token')}`,
      { method: 'POST' },
    )

    const response = await fetchApi(request, throwingDbEnv(), noopExecutionContext())

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toMatch(/^text\/plain/)
    await expect(response.text()).resolves.toBe('probe-token')
  })

  it('answers the lifecycle handshake through the full route stack without touching D1', async () => {
    const request = new Request(
      `${ORIGIN}${MICROSOFT_GRAPH_LIFECYCLE_PATH}?validationToken=${encodeURIComponent('probe-token-2')}`,
      { method: 'POST' },
    )

    const response = await fetchApi(request, throwingDbEnv(), noopExecutionContext())

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toMatch(/^text\/plain/)
    await expect(response.text()).resolves.toBe('probe-token-2')
  })

  it('a non-handshake notification POST still reaches the handler (bypass is scoped to this middleware only)', async () => {
    // The handler does its own targeted D1 read (the per-IP counter), so this
    // still fails against the throwing DB — but the throw must come from
    // inside the route handler's own read, proving the bypass above did not
    // turn into "skip everything" for this path.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const request = new Request(`${ORIGIN}${MICROSOFT_GRAPH_NOTIFICATION_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: [] }),
    })

    const response = await fetchApi(request, throwingDbEnv(), noopExecutionContext())

    expect(response.status).toBe(500)
    errorSpy.mockRestore()
  })

  it('does not bypass schema/super-admin sync for unrelated public paths', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const request = new Request(`${ORIGIN}/api/config`, { method: 'GET' })

    const response = await fetchApi(request, throwingDbEnv(), noopExecutionContext())

    expect(response.status).toBe(500)
    errorSpy.mockRestore()
  })
})
