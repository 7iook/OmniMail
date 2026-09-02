import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { Env } from '../../app/types'
import { WRANGLER_MIGRATION_NAMES } from '../../platform/d1/schema-migrations'
import { refreshMicrosoftFolderWithTransport } from './microsoft-sync-folder'
import type { MicrosoftMailTransport } from './microsoft-transport'
import type { MicrosoftMessageMetadata, MicrosoftTransport } from './microsoft-types'

/**
 * Executes the message upsert for real, against the real schema.
 *
 * Why this exists: every other microsoft test drives a fake D1 that records SQL
 * text, so the two-clause `INSERT ... ON CONFLICT(...) DO UPDATE ... ON CONFLICT
 * DO UPDATE` in `messageStatement()` had never been *run* by an automated test.
 * SQLite rejected an earlier shape of it (two named targets) at prepare time,
 * and the merge semantics — same mail over the other transport takes over the
 * existing row instead of failing the whole batch — were only ever hand-checked.
 * The statement is not exported, so the orchestrator is driven end to end
 * through a `DatabaseSync`-backed D1 shim, which also exercises binding order.
 */

const ACCOUNT = 'acct_upsert'
const IMAP_FOLDER = 'INBOX'
/** Graph names the same mailbox folder by an opaque id, not `INBOX`. */
const GRAPH_FOLDER = 'AAMkAGI2Folder'.padEnd(120, 'F') + '='
const GRAPH_ID = 'AAMkAGI2THVSAAA'.padEnd(139, 'A') + '='
const GRAPH_ID_2 = 'AAMkAGI2THVSBBB'.padEnd(139, 'B') + '='
const IMAP_UIDVALIDITY = 42
const T0 = 1_700_000_100
const T1 = 1_700_000_200
const T2 = 1_700_000_300

type Row = {
  id: string
  folder_path: string
  source_transport: MicrosoftTransport
  remote_id: string
  uid_validity: number | null
  internet_message_id: string
  subject: string
  is_read: number
  updated_at: number
}

type Recorded = { sql: string; values: SQLInputValue[] }

function applyDiskMigrations(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  // Migrations rebuild tables (0017, 0036) and must run with FKs off, exactly as
  // wrangler applies them. Enforcement is switched on afterwards for the test.
  db.exec('PRAGMA foreign_keys = OFF')
  for (const name of WRANGLER_MIGRATION_NAMES) {
    const sql = readFileSync(`migrations/${name}`, 'utf8')
    try {
      db.exec(sql)
    } catch (error) {
      throw new Error(`migration ${name} failed: ${(error as Error).message}`)
    }
  }
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

function seed(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO users (id, email, display_name, password_hash)
     VALUES ('user_upsert', 'owner@example.com', 'Owner', 'hash')`,
  ).run()
  db.prepare(
    `INSERT INTO microsoft_imap_accounts (
       id, user_id, name, provided_email, normalized_email, auth_mode,
       client_id, refresh_token_cipher, created_at, updated_at
     ) VALUES (?, 'user_upsert', 'Outlook', 'user@outlook.com', 'user@outlook.com',
       'oauth2', 'client', 'cipher', ?, ?)`,
  ).run(ACCOUNT, T0, T0)
  const folder = db.prepare(
    `INSERT INTO microsoft_imap_folders (
       account_id, path, display_name, special_use, uid_validity, last_listed_at
     ) VALUES (?, ?, 'Inbox', 'inbox', ?, ?)`,
  )
  folder.run(ACCOUNT, IMAP_FOLDER, IMAP_UIDVALIDITY, T0)
  folder.run(ACCOUNT, GRAPH_FOLDER, null, T0)
}

/**
 * The slice of `D1Database` the orchestrator touches, executed for real.
 * `batch()` is atomic like D1's, so a rejected upsert takes the batch with it —
 * the exact failure mode the fallback clause exists to prevent.
 */
function realD1(db: DatabaseSync) {
  const upserts: Recorded[] = []
  const statement = (sql: string, values: SQLInputValue[]) => ({
    sql,
    values,
    first: async <T>() => (db.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({ results: db.prepare(sql).all(...values) as T[] }),
    run: async () => {
      if (sql.includes('INSERT INTO microsoft_imap_messages')) upserts.push({ sql, values })
      const { changes } = db.prepare(sql).run(...values)
      return { meta: { changes } }
    },
  })
  type Statement = ReturnType<typeof statement>
  const env = {
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
  return { env, upserts }
}

function harness() {
  const db = applyDiskMigrations()
  seed(db)
  return { db, ...realD1(db) }
}

function message(
  kind: MicrosoftTransport,
  remoteId: string,
  overrides: Partial<MicrosoftMessageMetadata> = {},
): MicrosoftMessageMetadata {
  return {
    remoteId,
    uidValidity: kind === 'imap' ? IMAP_UIDVALIDITY : null,
    internetMessageId: '<shared@example.com>',
    senderName: 'Sender',
    senderAddress: 'sender@example.com',
    recipients: ['user@outlook.com'],
    cc: [],
    subject: 'Subject',
    preview: 'Preview',
    receivedAt: 1_700_000_000,
    sentAt: null,
    sizeBytes: 10,
    flags: [],
    isRead: false,
    isStarred: false,
    hasAttachments: false,
    ...overrides,
  }
}

function transportOf(kind: MicrosoftTransport, messages: MicrosoftMessageMetadata[]): MicrosoftMailTransport {
  return {
    transport: kind,
    open: async () => undefined,
    close: async () => undefined,
    listFolders: async () => [],
    folderState: async () => ({
      uidValidity: kind === 'imap' ? IMAP_UIDVALIDITY : null,
      exists: messages.length,
    }),
    listRemoteIds: async () => messages.map(({ remoteId }) => remoteId),
    listRecentMetadata: async (_path, { limit }) => messages.slice(0, limit),
    getMessage: async () => { throw new Error('not used') },
    markSeen: async () => undefined,
  }
}

function sync(
  env: Env,
  kind: MicrosoftTransport,
  messages: MicrosoftMessageMetadata[],
  now: number,
) {
  const folder = kind === 'imap' ? IMAP_FOLDER : GRAPH_FOLDER
  return refreshMicrosoftFolderWithTransport(env, ACCOUNT, folder, 10, transportOf(kind, messages), now)
}

function rows(db: DatabaseSync): Row[] {
  return db.prepare(
    `SELECT id, folder_path, source_transport, remote_id, uid_validity,
            internet_message_id, subject, is_read, updated_at
       FROM microsoft_imap_messages ORDER BY remote_id`,
  ).all() as unknown as Row[]
}

describe('Microsoft message upsert (real SQLite, real migrations)', () => {
  it('runs with foreign keys enforced so the composite folder FK is honoured', () => {
    const { db } = harness()
    const pragma = db.prepare('PRAGMA foreign_keys').get() as Record<string, SQLOutputValue>
    expect(Object.values(pragma)).toEqual([1])
    // The FK is real: a row for a folder that has no folder row is rejected.
    expect(() => db.prepare(
      `INSERT INTO microsoft_imap_messages (
         id, account_id, folder_path, source_transport, remote_id, uid_validity,
         received_at, created_at, updated_at
       ) VALUES ('m', ?, 'Nowhere', 'imap', '1', 1, 0, 0, 0)`,
    ).run(ACCOUNT)).toThrow(/FOREIGN KEY constraint failed/)
  })

  it('(a) the same mail fetched over IMAP then Graph keeps one row, re-addressed by the later transport', async () => {
    const { db, env } = harness()
    await sync(env, 'imap', [message('imap', '7')], T0)
    const [imapRow] = rows(db)
    expect(imapRow).toMatchObject({
      folder_path: IMAP_FOLDER, source_transport: 'imap', remote_id: '7', uid_validity: IMAP_UIDVALIDITY,
    })

    const graph = await sync(env, 'graph', [message('graph', GRAPH_ID)], T1)
    expect(graph).toMatchObject({ indexed: 1, reconciled: true, uidValidity: null })

    const after = rows(db)
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({
      id: imapRow.id,
      folder_path: GRAPH_FOLDER,
      source_transport: 'graph',
      remote_id: GRAPH_ID,
      // The takeover must also swap the epoch, or the table CHECK
      // (graph rows carry no uid_validity) would reject the update.
      uid_validity: null,
      internet_message_id: '<shared@example.com>',
      updated_at: T1,
    })

    // And back: IMAP re-fetching it reclaims the same row rather than adding one.
    await sync(env, 'imap', [message('imap', '7')], T2)
    const roundTrip = rows(db)
    expect(roundTrip).toHaveLength(1)
    expect(roundTrip[0]).toMatchObject({
      id: imapRow.id, source_transport: 'imap', remote_id: '7', uid_validity: IMAP_UIDVALIDITY, updated_at: T2,
    })
  })

  it('(b) the same transport re-fetching the same locator refreshes the payload in place', async () => {
    const { db, env } = harness()
    await sync(env, 'imap', [message('imap', '7', { subject: 'v1', isRead: false })], T0)
    const [before] = rows(db)

    await sync(env, 'imap', [message('imap', '7', { subject: 'v2', isRead: true })], T1)
    const after = rows(db)
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({
      id: before.id, source_transport: 'imap', remote_id: '7', subject: 'v2', is_read: 1, updated_at: T1,
    })

    const graphFirst = harness()
    await sync(graphFirst.env, 'graph', [message('graph', GRAPH_ID, { subject: 'g1' })], T0)
    await sync(graphFirst.env, 'graph', [message('graph', GRAPH_ID, { subject: 'g2', isRead: true })], T1)
    expect(rows(graphFirst.db)).toHaveLength(1)
    expect(rows(graphFirst.db)[0]).toMatchObject({ subject: 'g2', is_read: 1, uid_validity: null })
  })

  it('(c) mails without a Message-ID are not merged across transports (I-2b exemption)', async () => {
    const { db, env } = harness()
    await sync(env, 'imap', [message('imap', '7', { internetMessageId: '' })], T0)
    await sync(env, 'graph', [message('graph', GRAPH_ID, { internetMessageId: '' })], T1)

    const after = rows(db)
    expect(after).toHaveLength(2)
    expect(after.map(({ source_transport, remote_id }) => [source_transport, remote_id]))
      .toEqual([['imap', '7'], ['graph', GRAPH_ID]])
    expect(after.every(({ internet_message_id }) => internet_message_id === '')).toBe(true)
  })

  it('(d) different mails stay separate rows, within and across transports', async () => {
    const { db, env } = harness()
    await sync(env, 'imap', [
      message('imap', '7', { internetMessageId: '<one@example.com>' }),
      message('imap', '8', { internetMessageId: '<two@example.com>' }),
    ], T0)
    await sync(env, 'graph', [
      message('graph', GRAPH_ID, { internetMessageId: '<three@example.com>' }),
      message('graph', GRAPH_ID_2, { internetMessageId: '<four@example.com>' }),
    ], T1)

    const after = rows(db)
    expect(after).toHaveLength(4)
    expect(new Set(after.map(({ internet_message_id }) => internet_message_id)).size).toBe(4)
    expect(after.filter(({ source_transport }) => source_transport === 'imap')).toHaveLength(2)
    expect(after.filter(({ source_transport }) => source_transport === 'graph')).toHaveLength(2)
  })

  it('needs the targetless fallback clause: without it, the cross-transport fetch is rejected outright', async () => {
    // Mutation guard. Takes the real statement the orchestrator produced in (a)
    // and re-runs it with the second ON CONFLICT clause stripped, to pin down
    // the failure the clause exists to prevent (and to prove (a) can go red).
    const { db, env, upserts } = harness()
    await sync(env, 'imap', [message('imap', '7')], T0)
    await sync(env, 'graph', [message('graph', GRAPH_ID)], T1)
    expect(rows(db)).toHaveLength(1)

    const graphUpsert = upserts.at(-1)
    expect(graphUpsert?.values.slice(1, 6)).toEqual([ACCOUNT, GRAPH_FOLDER, 'graph', GRAPH_ID, null])
    const sql = graphUpsert?.sql ?? ''
    const fallbackAt = sql.lastIndexOf('ON CONFLICT DO UPDATE')
    expect(fallbackAt).toBeGreaterThan(sql.indexOf('ON CONFLICT(account_id, folder_path, source_transport, remote_id)'))
    const withoutFallback = sql.slice(0, fallbackAt)

    // Re-seat the row under IMAP so the Graph insert collides on Message-ID again.
    await sync(env, 'imap', [message('imap', '7')], T2)
    expect(() => db.prepare(withoutFallback).run(...(graphUpsert?.values ?? [])))
      .toThrow(/UNIQUE constraint failed: microsoft_imap_messages\.account_id, microsoft_imap_messages\.internet_message_id/)
    // The full statement, same bindings, succeeds where the truncated one failed.
    expect(() => db.prepare(sql).run(...(graphUpsert?.values ?? []))).not.toThrow()
    expect(rows(db)).toHaveLength(1)
    expect(rows(db)[0]).toMatchObject({ source_transport: 'graph', remote_id: GRAPH_ID })
  })
})
