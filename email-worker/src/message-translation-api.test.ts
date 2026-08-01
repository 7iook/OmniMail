import { describe, expect, it, vi } from 'vitest'
import {
  detectTranslationLanguage,
  splitTranslationText,
  translateMessage,
  translationSourceHash,
  type StoredTranslation,
} from './message-translation-api'
import type { Env, SessionUser, StoredBody } from './types'

const user = { id: 'user-1' } as SessionUser
const message = {
  id: 'message-1',
  subject: 'Tvoj novi A1 eSIM',
  body_key: 'bodies/message-1.json',
  status: 'ready',
}
const body: StoredBody = {
  text: 'Tvoj A1 eSIM je spreman za korištenje. Šaljemo upute za jednostavnu aktivaciju.',
  html: '<html lang="hr"><body><p>Tvoj A1 eSIM je spreman.</p></body></html>',
}

type MockOptions = {
  cacheRow?: Record<string, string> | null
  cachedValue?: StoredTranslation
  rateChanges?: number
  ownedMessage?: typeof message | null
}

function translationEnv(options: MockOptions = {}) {
  const calls: Array<{ sql: string; bindings: unknown[] }> = []
  const aiRun = vi.fn(async (_model: string, input: { text: string }) => ({
    translated_text: `译：${input.text}`,
  }))
  const put = vi.fn(async () => undefined)
  const remove = vi.fn(async () => undefined)
  const get = vi.fn(async (key: string) => {
    if (key === message.body_key) return new Response(JSON.stringify(body))
    if (options.cachedValue && key === options.cacheRow?.r2_key) {
      return new Response(JSON.stringify(options.cachedValue))
    }
    return null
  })
  const db = {
    prepare(sql: string) {
      const call = { sql, bindings: [] as unknown[] }
      calls.push(call)
      const statement = {
        bind(...bindings: unknown[]) {
          call.bindings = bindings
          return statement
        },
        first: async () => {
          if (sql.includes('FROM messages m')) {
            return 'ownedMessage' in options ? options.ownedMessage : message
          }
          if (sql.includes('FROM message_translations')) return options.cacheRow ?? null
          return null
        },
        run: async () => ({
          meta: {
            changes: sql.includes('INSERT INTO translation_rate_limits')
              ? options.rateChanges ?? 1
              : 1,
          },
        }),
      }
      return statement
    },
  }
  return {
    env: {
      DB: db,
      MAIL_BUCKET: { get, put, delete: remove },
      AI: { run: aiRun },
    } as unknown as Env,
    aiRun,
    calls,
    get,
    put,
  }
}

function request(targetLanguage = 'zh') {
  return new Request('https://mail.example.com/api/messages/message-1/translation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetLanguage }),
  })
}

describe('translation language handling', () => {
  it('prefers declared HTML language and recognizes short CJK text', () => {
    expect(detectTranslationLanguage(body.text, body.html)).toBe('hr')
    expect(detectTranslationLanguage('欢迎使用你的新邮箱。')).toBe('zh')
  })

  it('splits long text without dropping content', () => {
    const chunks = splitTranslationText('First paragraph.\n\nSecond paragraph is longer.', 24)
    expect(chunks.every((chunk) => chunk.length <= 24)).toBe(true)
    expect(chunks.join(' ')).toContain('Second paragraph')
  })
})

describe('message translation endpoint', () => {
  it('translates owned stored text and persists a cache entry', async () => {
    const mocked = translationEnv()
    const response = await translateMessage(mocked.env, user, message.id, request())
    const result = await response.json() as { translation: StoredTranslation & { cached: boolean } }

    expect(response.status).toBe(200)
    expect(result.translation).toMatchObject({
      sourceLanguage: 'hr',
      targetLanguage: 'zh',
      subject: `译：${message.subject}`,
      text: `译：${body.text}`,
      cached: false,
    })
    expect(mocked.aiRun).toHaveBeenCalledTimes(2)
    expect(mocked.put).toHaveBeenCalledTimes(1)
    expect(mocked.calls.some(({ sql }) => sql.includes('ON CONFLICT(message_id, target_language)'))).toBe(true)
  })

  it('returns a matching R2 cache without invoking AI', async () => {
    const cachedValue: StoredTranslation = {
      sourceLanguage: 'hr',
      targetLanguage: 'zh',
      subject: '你的新 A1 eSIM',
      text: '你的 A1 eSIM 已准备就绪。',
    }
    const sourceHash = await translationSourceHash(message.subject, body.text)
    const mocked = translationEnv({
      cachedValue,
      cacheRow: {
        source_language: 'hr',
        source_hash: sourceHash,
        model: 'm2m100-1.2b-v1',
        r2_key: 'translations/message-1/zh.json',
      },
    })
    const response = await translateMessage(mocked.env, user, message.id, request())
    const result = await response.json() as { translation: StoredTranslation & { cached: boolean } }

    expect(result.translation).toEqual({ ...cachedValue, cached: true })
    expect(mocked.aiRun).not.toHaveBeenCalled()
    expect(mocked.put).not.toHaveBeenCalled()
  })

  it('rate limits uncached inference before calling AI', async () => {
    const mocked = translationEnv({ rateChanges: 0 })
    const response = await translateMessage(mocked.env, user, message.id, request())

    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('60')
    expect(mocked.aiRun).not.toHaveBeenCalled()
  })

  it('does not expose messages owned by another user', async () => {
    const mocked = translationEnv({ ownedMessage: null })
    const response = await translateMessage(mocked.env, user, message.id, request())

    expect(response.status).toBe(404)
    expect(mocked.get).not.toHaveBeenCalled()
    expect(mocked.aiRun).not.toHaveBeenCalled()
  })
})
