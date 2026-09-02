import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { Env } from '../../app/types'
import { WRANGLER_MIGRATION_NAMES } from '../../platform/d1/schema-migrations'
import { MicrosoftAccountStore } from './microsoft-store'

/**
 * Card §12.7 Q3 / C-5 `pushStatus` derivation, run against the real schema
 * (follows `microsoft-graph-subscription-store.test.ts`): the rule joins two
 * tables and a `Boolean(env var)` check, which a hand-built fake D1 could get
 * right for the wrong reason (e.g. by not exercising the JOIN at all).
 */

const WEBHOOK_BASE_URL = 'https://mail.example.com'
const T0 = 1_700_000_000

function applyDiskMigrations(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
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

function seedUser(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO users (id, email, display_name, password_hash)
     VALUES ('user_push', 'owner@example.com', 'Owner', 'hash')`,
  ).run()
}

function seedAccount(
  db: DatabaseSync,
  id: string,
  preferredTransport: 'graph' | 'imap' | 'unknown',
): void {
  db.prepare(
    `INSERT INTO microsoft_imap_accounts (
       id, user_id, name, provided_email, normalized_email, auth_mode,
       client_id, refresh_token_cipher, preferred_transport, created_at, updated_at
     ) VALUES (?, 'user_push', 'Outlook', ?, ?, 'oauth2', 'client', 'cipher', ?, ?, ?)`,
  ).run(id, `${id}@outlook.com`, `${id}@outlook.com`, preferredTransport, T0, T0)
}

function seedSubscription(
  db: DatabaseSync,
  accountId: string,
  folderPath: string,
  status: 'active' | 'stale' | 'rejected',
): void {
  db.prepare(
    `INSERT INTO microsoft_graph_subscriptions (
       id, account_id, folder_path, subscription_id, client_state_hash, expires_at,
       status, failure_count, next_attempt_at, refresh_state, refresh_pending,
       refresh_state_at, last_notified_at, last_error_code, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'idle', 0, ?, NULL, '', ?, ?)`,
  ).run(
    `${accountId}_${folderPath}`, accountId, folderPath, `remote_${accountId}_${folderPath}`,
    'a'.repeat(64), T0 + 7 * 24 * 3_600, status, T0 + 6 * 24 * 3_600, T0, T0, T0,
  )
}

function realEnv(db: DatabaseSync, webhookBaseUrl?: string): Env {
  return {
    MICROSOFT_CREDENTIALS_KEY: 'microsoft-store-key-longer-than-thirty-two-bytes',
    MICROSOFT_GRAPH_WEBHOOK_BASE_URL: webhookBaseUrl,
    DB: {
      prepare: (sql: string) => {
        const state = { bindings: [] as unknown[] }
        const api = {
          bind: (...bindings: unknown[]) => { state.bindings = bindings; return api },
          first: async <T>() => (db.prepare(sql).get(...(state.bindings as never[])) as T | undefined) ?? null,
          all: async <T>() => ({ results: db.prepare(sql).all(...(state.bindings as never[])) as T[] }),
          run: async () => {
            const { changes } = db.prepare(sql).run(...(state.bindings as never[]))
            return { meta: { changes } }
          },
        }
        return api
      },
    },
  } as unknown as Env
}

describe('MicrosoftAccountStore.list() — pushStatus derivation (card §12.7 Q3 / C-5)', () => {
  it('is "off" when the account is not on the Graph channel, regardless of subscriptions', async () => {
    const db = applyDiskMigrations()
    seedUser(db)
    seedAccount(db, 'acct_imap', 'imap')
    seedSubscription(db, 'acct_imap', 'INBOX', 'active')
    seedSubscription(db, 'acct_imap', 'Junk Email', 'active')
    const store = new MicrosoftAccountStore(realEnv(db, WEBHOOK_BASE_URL), 'user_push')

    const [account] = await store.list()
    expect(account.pushStatus).toBe('off')
  })

  it('is "off" for an "unknown" (not yet probed) account even with the webhook configured', async () => {
    const db = applyDiskMigrations()
    seedUser(db)
    seedAccount(db, 'acct_unknown', 'unknown')
    const store = new MicrosoftAccountStore(realEnv(db, WEBHOOK_BASE_URL), 'user_push')

    const [account] = await store.list()
    expect(account.pushStatus).toBe('off')
  })

  it('is "off" for a Graph account when MICROSOFT_GRAPH_WEBHOOK_BASE_URL is unset (S-6 kill switch)', async () => {
    const db = applyDiskMigrations()
    seedUser(db)
    seedAccount(db, 'acct_graph', 'graph')
    seedSubscription(db, 'acct_graph', 'INBOX', 'active')
    seedSubscription(db, 'acct_graph', 'Junk Email', 'active')
    const store = new MicrosoftAccountStore(realEnv(db, undefined), 'user_push')

    const [account] = await store.list()
    expect(account.pushStatus).toBe('off')
  })

  it('is "active" only when both the INBOX and Junk Email subscriptions are active', async () => {
    const db = applyDiskMigrations()
    seedUser(db)
    seedAccount(db, 'acct_graph', 'graph')
    seedSubscription(db, 'acct_graph', 'INBOX', 'active')
    seedSubscription(db, 'acct_graph', 'Junk Email', 'active')
    const store = new MicrosoftAccountStore(realEnv(db, WEBHOOK_BASE_URL), 'user_push')

    const [account] = await store.list()
    expect(account.pushStatus).toBe('active')
  })

  it('is "degraded" when a subscription row is missing', async () => {
    const db = applyDiskMigrations()
    seedUser(db)
    seedAccount(db, 'acct_graph', 'graph')
    seedSubscription(db, 'acct_graph', 'INBOX', 'active')
    // Junk Email row never created (e.g. S-8 refusal, or reconciliation hasn't run yet).
    const store = new MicrosoftAccountStore(realEnv(db, WEBHOOK_BASE_URL), 'user_push')

    const [account] = await store.list()
    expect(account.pushStatus).toBe('degraded')
  })

  it('is "degraded" when a subscription exists but is stale or rejected, not active', async () => {
    const db = applyDiskMigrations()
    seedUser(db)
    seedAccount(db, 'acct_graph', 'graph')
    seedSubscription(db, 'acct_graph', 'INBOX', 'active')
    seedSubscription(db, 'acct_graph', 'Junk Email', 'stale')
    const store = new MicrosoftAccountStore(realEnv(db, WEBHOOK_BASE_URL), 'user_push')

    const [account] = await store.list()
    expect(account.pushStatus).toBe('degraded')
  })

  it('is "degraded" for a Graph account with zero subscription rows at all', async () => {
    const db = applyDiskMigrations()
    seedUser(db)
    seedAccount(db, 'acct_graph', 'graph')
    const store = new MicrosoftAccountStore(realEnv(db, WEBHOOK_BASE_URL), 'user_push')

    const [account] = await store.list()
    expect(account.pushStatus).toBe('degraded')
  })

  it('keeps each account\'s pushStatus independent when listing several at once', async () => {
    const db = applyDiskMigrations()
    seedUser(db)
    seedAccount(db, 'acct_a', 'graph')
    seedSubscription(db, 'acct_a', 'INBOX', 'active')
    seedSubscription(db, 'acct_a', 'Junk Email', 'active')
    seedAccount(db, 'acct_b', 'graph')
    seedSubscription(db, 'acct_b', 'INBOX', 'rejected')
    seedAccount(db, 'acct_c', 'imap')
    const store = new MicrosoftAccountStore(realEnv(db, WEBHOOK_BASE_URL), 'user_push')

    const accounts = await store.list()
    const byId = Object.fromEntries(accounts.map((account) => [account.id, account.pushStatus]))
    expect(byId).toEqual({ acct_a: 'active', acct_b: 'degraded', acct_c: 'off' })
  })
})
