/**
 * Persistence for `microsoft_graph_subscriptions` (decision card §12, P2-W2).
 *
 * Every state transition is a single conditional `UPDATE` so two Workers can
 * never both win the same transition (C-3, C-5) — no read-modify-write from
 * application code. Column groups (see the migration's own comment) stay
 * separate: identity / scheduling / coalescing never share a write path.
 *
 * `MicrosoftGraphSubscriptionRepository` (frozen in `microsoft-types.ts`,
 * P2-W1) is implemented exactly. The class also exposes a few extra methods
 * beyond that interface — `markRejected` / `markTransientFailure` /
 * `markActive` / `markStale` (C-5) and `expiringSoon` — which are additive
 * conveniences, not modifications to the frozen port; see this package's
 * report for why they were not folded into `update()`.
 */

import type { Env } from '../../app/types'
import type {
  MicrosoftGraphRefreshState,
  MicrosoftGraphSubscription,
  MicrosoftGraphSubscriptionRepository,
  MicrosoftGraphSubscriptionStatus,
} from './microsoft-types'

/** A state is treated as abandoned (crashed consumer / lost queue message) past this age. */
const STALE_SECONDS = 10 * 60
/** C-5: permanent rejection is retried at most once a day. */
const REJECTED_BACKOFF_SECONDS = 24 * 60 * 60
/** C-5: transient failures back off 5m → 15m → 1h → 6h (capped), indexed by prior failure_count. */
const TRANSIENT_BACKOFF_SECONDS = [5 * 60, 15 * 60, 60 * 60, 6 * 60 * 60]
/** Renewal becomes due this long before expiry — unifies the "due" and "expiring" scans into one column. */
const RENEWAL_LEAD_SECONDS = 24 * 60 * 60

type Row = {
  id: string
  account_id: string
  folder_path: string
  subscription_id: string
  client_state_hash: string
  expires_at: number
  status: MicrosoftGraphSubscriptionStatus
  failure_count: number
  next_attempt_at: number
  refresh_state: MicrosoftGraphRefreshState
  refresh_pending: number
  refresh_state_at: number
  last_notified_at: number | null
  last_error_code: string
  created_at: number
  updated_at: number
}

function fromRow(row: Row): MicrosoftGraphSubscription {
  return {
    id: row.id,
    accountId: row.account_id,
    folderPath: row.folder_path,
    subscriptionId: row.subscription_id,
    clientStateHash: row.client_state_hash,
    expiresAt: row.expires_at,
    status: row.status,
    failureCount: row.failure_count,
    nextAttemptAt: row.next_attempt_at,
    refreshState: row.refresh_state,
    refreshPending: row.refresh_pending === 1,
    refreshStateAt: row.refresh_state_at,
    lastNotifiedAt: row.last_notified_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

type UpdatePatch = Partial<Pick<MicrosoftGraphSubscription,
  'subscriptionId' | 'clientStateHash' | 'expiresAt' | 'status' | 'failureCount'
  | 'nextAttemptAt' | 'lastErrorCode'>>

const COLUMN_BY_KEY: Record<keyof UpdatePatch, string> = {
  subscriptionId: 'subscription_id',
  clientStateHash: 'client_state_hash',
  expiresAt: 'expires_at',
  status: 'status',
  failureCount: 'failure_count',
  nextAttemptAt: 'next_attempt_at',
  lastErrorCode: 'last_error_code',
}

export class MicrosoftGraphSubscriptionStore implements MicrosoftGraphSubscriptionRepository {
  constructor(private readonly env: Env) {}

  private async getById(id: string): Promise<MicrosoftGraphSubscription | null> {
    const row = await this.env.DB.prepare(
      'SELECT * FROM microsoft_graph_subscriptions WHERE id = ? LIMIT 1',
    ).bind(id).first<Row>()
    return row ? fromRow(row) : null
  }

  async bySubscriptionId(subscriptionId: string): Promise<MicrosoftGraphSubscription | null> {
    const row = await this.env.DB.prepare(
      'SELECT * FROM microsoft_graph_subscriptions WHERE subscription_id = ? LIMIT 1',
    ).bind(subscriptionId).first<Row>()
    return row ? fromRow(row) : null
  }

  async forAccount(accountId: string): Promise<MicrosoftGraphSubscription[]> {
    const { results } = await this.env.DB.prepare(
      'SELECT * FROM microsoft_graph_subscriptions WHERE account_id = ? ORDER BY folder_path',
    ).bind(accountId).all<Row>()
    return results.map(fromRow)
  }

  async insert(
    row: Omit<MicrosoftGraphSubscription, 'createdAt' | 'updatedAt'>,
    now: number,
  ): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO microsoft_graph_subscriptions (
        id, account_id, folder_path, subscription_id, client_state_hash, expires_at,
        status, failure_count, next_attempt_at, refresh_state, refresh_pending,
        refresh_state_at, last_notified_at, last_error_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.id,
      row.accountId,
      row.folderPath,
      row.subscriptionId,
      row.clientStateHash,
      row.expiresAt,
      row.status,
      row.failureCount,
      row.nextAttemptAt,
      row.refreshState,
      row.refreshPending ? 1 : 0,
      row.refreshStateAt,
      row.lastNotifiedAt,
      row.lastErrorCode,
      now,
      now,
    ).run()
  }

  async remove(id: string): Promise<void> {
    await this.env.DB.prepare(
      'DELETE FROM microsoft_graph_subscriptions WHERE id = ?',
    ).bind(id).run()
  }

  async update(
    id: string,
    patch: UpdatePatch,
    now: number,
  ): Promise<MicrosoftGraphSubscription | null> {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined) as Array<
      [keyof UpdatePatch, string | number]
    >
    if (!entries.length) return this.getById(id)
    const assignments = entries.map(([key]) => `${COLUMN_BY_KEY[key]} = ?`)
    const values = entries.map(([, value]) => value)
    await this.env.DB.prepare(
      `UPDATE microsoft_graph_subscriptions SET ${assignments.join(', ')}, updated_at = ?
        WHERE id = ?`,
    ).bind(...values, now, id).run()
    return this.getById(id)
  }

  /** C-5 fairness: oldest-due-first, bounded. Also the renewal queue (see `markActive`). */
  async due(now: number, limit: number): Promise<MicrosoftGraphSubscription[]> {
    const { results } = await this.env.DB.prepare(
      `SELECT * FROM microsoft_graph_subscriptions
        WHERE next_attempt_at <= ? ORDER BY next_attempt_at ASC LIMIT ?`,
    ).bind(now, limit).all<Row>()
    return results.map(fromRow)
  }

  /**
   * Defensive companion to `due()`: an explicit "close to expiry" scan, independent
   * of whatever `next_attempt_at` happens to hold. `due()` is the primary
   * mechanism in normal operation (`markActive` sets `next_attempt_at` to
   * `expires_at - 24h`, so a healthy row becomes due through that path already);
   * this exists so a row whose `next_attempt_at` was set incorrectly, or was
   * never active in the first place, is not permanently invisible to renewal.
   */
  async expiringSoon(
    now: number,
    withinSeconds: number,
    limit: number,
  ): Promise<MicrosoftGraphSubscription[]> {
    const { results } = await this.env.DB.prepare(
      `SELECT * FROM microsoft_graph_subscriptions
        WHERE status = 'active' AND (expires_at - ?) < ?
        ORDER BY expires_at ASC LIMIT ?`,
    ).bind(now, withinSeconds, limit).all<Row>()
    return results.map(fromRow)
  }

  // -------------------------------------------------------------------------
  // C-3 · coalescing state machine. Each transition is one conditional UPDATE.
  // Any state older than STALE_SECONDS is treated as abandoned and may be
  // driven forward as if it were idle (crash recovery, per the card's table).
  // -------------------------------------------------------------------------

  async markQueued(id: string, now: number): Promise<boolean> {
    const result = await this.env.DB.prepare(
      `UPDATE microsoft_graph_subscriptions
          SET refresh_state = 'queued', refresh_state_at = ?, updated_at = ?
        WHERE id = ? AND (refresh_state = 'idle' OR refresh_state_at < ?)`,
    ).bind(now, now, id, now - STALE_SECONDS).run()
    return Boolean(result.meta.changes)
  }

  /** Unconditional: a notification arriving while queued/running just flags a follow-up. */
  async markPending(id: string, now: number): Promise<void> {
    await this.env.DB.prepare(
      'UPDATE microsoft_graph_subscriptions SET refresh_pending = 1, updated_at = ? WHERE id = ?',
    ).bind(now, id).run()
  }

  /** Send failed after a successful `markQueued`: release the slot so the next notification re-enqueues. */
  async releaseQueued(id: string, now: number): Promise<boolean> {
    const result = await this.env.DB.prepare(
      `UPDATE microsoft_graph_subscriptions
          SET refresh_state = 'idle', refresh_state_at = ?, refresh_pending = 0, updated_at = ?
        WHERE id = ? AND refresh_state = 'queued'`,
    ).bind(now, now, id).run()
    return Boolean(result.meta.changes)
  }

  async markRunning(id: string, now: number): Promise<boolean> {
    const result = await this.env.DB.prepare(
      `UPDATE microsoft_graph_subscriptions
          SET refresh_state = 'running', refresh_state_at = ?, updated_at = ?
        WHERE id = ? AND (refresh_state = 'queued' OR refresh_state_at < ?)`,
    ).bind(now, now, id, now - STALE_SECONDS).run()
    return Boolean(result.meta.changes)
  }

  /**
   * Ends a run atomically: the `CASE` decides idle-vs-requeue and the
   * `RETURNING` clause reports which one happened in the same statement, so
   * there is no read-then-write race with a notification arriving in between.
   */
  async finishRunning(id: string, now: number): Promise<{ requeue: boolean }> {
    const row = await this.env.DB.prepare(
      `UPDATE microsoft_graph_subscriptions
          SET refresh_state = CASE WHEN refresh_pending = 1 THEN 'queued' ELSE 'idle' END,
              refresh_pending = 0,
              refresh_state_at = ?,
              updated_at = ?
        WHERE id = ? AND (refresh_state = 'running' OR refresh_state_at < ?)
        RETURNING refresh_state`,
    ).bind(now, now, id, now - STALE_SECONDS).first<{ refresh_state: MicrosoftGraphRefreshState }>()
    return { requeue: row?.refresh_state === 'queued' }
  }

  // -------------------------------------------------------------------------
  // C-5 · scheduling convenience methods (beyond the frozen `update()` port).
  // Each is a single atomic UPDATE — failure_count math happens in SQL so no
  // read-then-increment race is possible between concurrent cron passes.
  // -------------------------------------------------------------------------

  /** Permanent refusal (403 / 4xx non-429): retried once a day, never sooner. */
  async markRejected(id: string, errorCode: string, now: number): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE microsoft_graph_subscriptions
          SET status = 'rejected', failure_count = failure_count + 1,
              next_attempt_at = ?, last_error_code = ?, updated_at = ?
        WHERE id = ?`,
    ).bind(now + REJECTED_BACKOFF_SECONDS, errorCode, now, id).run()
  }

  /** 429 / 5xx / network / timeout: exponential backoff, capped, keyed off the CURRENT failure_count. */
  async markTransientFailure(id: string, errorCode: string, now: number): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE microsoft_graph_subscriptions
          SET failure_count = failure_count + 1,
              next_attempt_at = ? + CASE
                WHEN failure_count <= 0 THEN ?
                WHEN failure_count = 1 THEN ?
                WHEN failure_count = 2 THEN ?
                ELSE ?
              END,
              last_error_code = ?, updated_at = ?
        WHERE id = ?`,
    ).bind(now, ...TRANSIENT_BACKOFF_SECONDS, errorCode, now, id).run()
  }

  /** Create/renew succeeded: `next_attempt_at` becomes the renewal-due time, `RENEWAL_LEAD_SECONDS` before expiry. */
  async markActive(id: string, expiresAt: number, now: number): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE microsoft_graph_subscriptions
          SET status = 'active', failure_count = 0, expires_at = ?,
              next_attempt_at = ?, last_error_code = '', updated_at = ?
        WHERE id = ?`,
    ).bind(expiresAt, Math.max(now, expiresAt - RENEWAL_LEAD_SECONDS), now, id).run()
  }

  /** Lifecycle notification (`subscriptionRemoved` / `reauthorizationRequired`): due immediately, cron rebuilds. */
  async markStale(id: string, errorCode: string, now: number): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE microsoft_graph_subscriptions
          SET status = 'stale', next_attempt_at = ?, last_error_code = ?, updated_at = ?
        WHERE id = ?`,
    ).bind(now, errorCode, now, id).run()
  }
}
