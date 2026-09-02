import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env, MailQueueJob } from '../../app/types'
import { WRANGLER_MIGRATION_NAMES } from '../../platform/d1/schema-migrations'
import {
  encryptMicrosoftCredential,
  microsoftCredentialContext,
} from './microsoft-credentials'
import {
  configureMicrosoftGraphSubscriptionRuntime,
  hashMicrosoftGraphClientState,
  microsoftGraphSubscriptionRuntime,
  processMicrosoftGraphNotificationItems,
  type MicrosoftGraphNotificationItem,
} from './microsoft-graph-notifications'
import { MicrosoftGraphSubscriptionStore } from './microsoft-graph-subscription-store'
import { consumeMicrosoftFolderRefreshJob } from './microsoft-sync'
import type { MicrosoftMailTransport } from './microsoft-transport'
import type { MicrosoftMessageMetadata } from './microsoft-types'

/**
 * review3 Minor #3: the existing storm test in `microsoft-graph-notifications.test.ts`
 * only proves 50 notifications produce one initial `MAIL_QUEUE.send` against a
 * *fake* repository — it never actually consumes that job or counts real
 * folder-refresh calls, so it does not establish the promised "at most two
 * refreshes" end to end.
 *
 * This drives the real notification processor (imported read-only from
 * `microsoft-graph-notifications.ts`, owned by a parallel executor) against
 * the real `MicrosoftGraphSubscriptionStore` (real SQLite, real `0037` DDL),
 * then runs the real queue consumer (`consumeMicrosoftFolderRefreshJob`,
 * owned here) twice, and counts actual transport calls: I-10's guarantee is
 * "one initial + at most one trailing refresh", never more, regardless of
 * how many notifications arrived.
 */

const ACCOUNT = 'acct_storm'
const USER = 'user_storm'
const SUB_ID = 'c3f5f0a2-7b9e-4c6a-9d1e-0f2a3b4c5d6e'
const CLIENT_STATE = 'storm-client-state'
const CREDENTIALS_KEY = 'microsoft-storm-test-key-longer-than-thirty-two-bytes'

const { resolveMicrosoftTransport } = vi.hoisted(() => ({
  resolveMicrosoftTransport: vi.fn(),
}))
vi.mock('./microsoft-session', () => ({ resolveMicrosoftTransport }))

function applyDiskMigrations(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  for (const name of WRANGLER_MIGRATION_NAMES) {
    const sql = readFileSync(`migrations/${name}`, 'utf8')
    db.exec(sql)
  }
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

async function seed(db: DatabaseSync, now: number): Promise<void> {
  db.prepare(
    `INSERT INTO users (id, email, display_name, password_hash)
     VALUES (?, 'owner@example.com', 'Owner', 'hash')`,
  ).run(USER)
  const refreshTokenCipher = await encryptMicrosoftCredential(
    { MICROSOFT_CREDENTIALS_KEY: CREDENTIALS_KEY } as Env,
    'refresh-secret',
    microsoftCredentialContext(USER, ACCOUNT, 'refresh-token'),
  )
  db.prepare(
    `INSERT INTO microsoft_imap_accounts (
       id, user_id, name, provided_email, normalized_email, auth_mode,
       preferred_transport, client_id, refresh_token_cipher, status,
       created_at, updated_at
     ) VALUES (?, ?, 'Outlook', 'user@outlook.com', 'user@outlook.com',
       'oauth2', 'graph', 'client', ?, 'active', ?, ?)`,
  ).run(ACCOUNT, USER, refreshTokenCipher, now, now)
  db.prepare(
    `INSERT INTO microsoft_imap_folders (
       account_id, path, display_name, special_use, uid_validity, last_listed_at
     ) VALUES (?, 'INBOX', 'Inbox', 'inbox', NULL, ?)`,
  ).run(ACCOUNT, now)
}

/** The slice of `D1Database` touched, executed for real (mirrors `microsoft-sync-folder.upsert.test.ts`). */
function realEnv(db: DatabaseSync): Env {
  const statement = (sql: string, values: SQLInputValue[]) => ({
    first: async <T>() => (db.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({ results: db.prepare(sql).all(...values) as T[] }),
    run: async () => {
      const { changes } = db.prepare(sql).run(...values)
      return { meta: { changes } }
    },
  })
  type Statement = ReturnType<typeof statement> & { bind: (...values: unknown[]) => ReturnType<typeof statement> }
  return {
    MICROSOFT_CREDENTIALS_KEY: CREDENTIALS_KEY,
    DB: {
      prepare: (sql: string) => ({
        ...statement(sql, []),
        bind: (...values: unknown[]) => statement(sql, values as SQLInputValue[]),
      }),
      batch: async (statements: Statement[]) => {
        db.exec('BEGIN')
        try {
          const results = []
          for (const item of statements) results.push(await item.run())
          db.exec('COMMIT')
          return results
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      },
    },
  } as unknown as Env
}

/** Counts real refresh work; each call represents one `refreshMicrosoftFolderWithTransport` invocation. */
function countingGraphTransport() {
  let refreshCalls = 0
  const transport: MicrosoftMailTransport = {
    transport: 'graph',
    open: async () => undefined,
    close: async () => undefined,
    listFolders: async () => [],
    folderState: async () => { refreshCalls += 1; return { uidValidity: null, exists: 0 } },
    listRemoteIds: async () => [],
    listRecentMetadata: async () => [] as MicrosoftMessageMetadata[],
    getMessage: async () => { throw new Error('not used') },
    markSeen: async () => undefined,
  }
  return { transport, refreshCalls: () => refreshCalls }
}

function folderRefreshMessage(): { message: Message<MailQueueJob>; ack: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> } {
  const ack = vi.fn()
  const retry = vi.fn()
  const message = {
    body: { kind: 'microsoft-folder-refresh', accountId: ACCOUNT, folderPath: 'INBOX', reason: 'notification' },
    attempts: 1,
    ack,
    retry,
  } as unknown as Message<MailQueueJob>
  return { message, ack, retry }
}

describe('Microsoft Graph notification storm -> real repository -> real queue consumer (review3 Minor #3)', () => {
  beforeEach(() => {
    resolveMicrosoftTransport.mockReset()
  })
  afterEach(() => {
    configureMicrosoftGraphSubscriptionRuntime(null)
  })

  it('50 notifications for the same subscription produce exactly one initial and at most one trailing refresh (I-10)', async () => {
    const now = 1_700_000_000
    const db = applyDiskMigrations()
    await seed(db, now)
    const env = realEnv(db)
    const store = new MicrosoftGraphSubscriptionStore(env)
    const clientStateHash = await hashMicrosoftGraphClientState(CLIENT_STATE)
    await store.insert({
      id: 'sub-row-storm',
      accountId: ACCOUNT,
      folderPath: 'INBOX',
      subscriptionId: SUB_ID,
      clientStateHash,
      expiresAt: now + 7 * 24 * 3_600,
      status: 'active',
      failureCount: 0,
      nextAttemptAt: now + 6 * 24 * 3_600,
      refreshState: 'idle',
      refreshPending: false,
      refreshStateAt: now,
      lastNotifiedAt: null,
      lastErrorCode: '',
    }, now)

    const sent: MailQueueJob[] = []
    const queueEnv = { ...env, MAIL_QUEUE: { send: async (job: MailQueueJob) => { sent.push(job) } } } as unknown as Env

    // Drive the storm through the REAL processor against the REAL repository.
    const items: MicrosoftGraphNotificationItem[] = Array.from({ length: 50 }, () => ({
      subscriptionId: SUB_ID, clientState: CLIENT_STATE, changeType: 'created', resource: 'r',
    }))
    await processMicrosoftGraphNotificationItems(queueEnv, store, items, now)

    expect(sent).toHaveLength(1)
    const afterStorm = await store.bySubscriptionId(SUB_ID)
    expect(afterStorm).toMatchObject({ refreshState: 'queued', refreshPending: true })

    // Now run the real consumer, twice, wired to this same real repository —
    // exactly what would happen when the queue delivers the initial job and
    // then the trailing one `finishRunning` schedules.
    configureMicrosoftGraphSubscriptionRuntime({
      repositoryFor: () => store,
      clientFor: () => { throw new Error('not used') },
    })
    const { transport, refreshCalls } = countingGraphTransport()
    resolveMicrosoftTransport.mockResolvedValue({ transport, preferredTransport: 'graph' })
    const consumerSent: MailQueueJob[] = []
    const consumerEnv = { ...env, MAIL_QUEUE: { send: async (job: MailQueueJob) => { consumerSent.push(job) } } } as unknown as Env

    const first = folderRefreshMessage()
    await consumeMicrosoftFolderRefreshJob(first.message, consumerEnv)
    expect(first.ack).toHaveBeenCalled()
    // The storm's 49 follow-up notifications set exactly one pending flag,
    // so finishRunning must have scheduled exactly one trailing job.
    expect(consumerSent).toHaveLength(1)

    const second = folderRefreshMessage()
    await consumeMicrosoftFolderRefreshJob(second.message, consumerEnv)
    expect(second.ack).toHaveBeenCalled()
    // No further follow-up: the trailing run finished with nothing pending.
    expect(consumerSent).toHaveLength(1)

    // The headline guarantee: one initial refresh call plus at most one
    // trailing refresh call, never more, no matter that 50 notifications came in.
    expect(refreshCalls()).toBe(2)

    const finalRow = await store.bySubscriptionId(SUB_ID)
    expect(finalRow?.refreshState).toBe('idle')
    expect(finalRow?.refreshPending).toBe(false)
  })

  it('confirms the read-only import surface used above still exists on microsoft-graph-notifications.ts', () => {
    // Not a behavioral assertion — just documents (and would fail loudly if
    // renamed) which exports this package depends on from the file owned by
    // the parallel R3-fix-A executor.
    expect(typeof processMicrosoftGraphNotificationItems).toBe('function')
    expect(typeof configureMicrosoftGraphSubscriptionRuntime).toBe('function')
    expect(typeof microsoftGraphSubscriptionRuntime).toBe('function')
    expect(typeof hashMicrosoftGraphClientState).toBe('function')
  })
})
