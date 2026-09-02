import type { Env, MicrosoftSyncJob, SessionUser } from '../../app/types'
import { ImapConnectionError } from '../../platform/imap/imap-errors'
import { writeAudit } from '../../shared/audit/audit'
import { sha256 } from '../auth/session/auth'
import { microsoftMailEnabled } from './microsoft-credentials'
import { microsoftImportAccount, MicrosoftInputError } from './microsoft-fields'
import {
  maskedMicrosoftEmail,
  microsoftFailureMessage,
  microsoftJsonBody,
  microsoftName,
  microsoftPrivateJson,
  microsoftResponseError,
} from './microsoft-api-shared'
import {
  type MicrosoftResolvedTransport,
  type MicrosoftRotatedCredential,
  MicrosoftTransportUnavailableError,
  openMicrosoftTransport,
  recordMicrosoftPreferredTransport,
  resolveMicrosoftTransport,
} from './microsoft-session'
import {
  MicrosoftAccountStore,
  MicrosoftStoreError,
  publicMicrosoftAccount,
  saveMicrosoftFolders,
} from './microsoft-store'
import { refreshMicrosoftFolders } from './microsoft-sync'
import type { MicrosoftMailTransport } from './microsoft-transport'
import {
  microsoftAccountStatusForFailure,
  microsoftTransportFailure,
  publicMicrosoftTransportAttempts,
} from './microsoft-transport-errors'
import type {
  MicrosoftAccount,
  MicrosoftFolder,
  MicrosoftTransport,
  ValidMicrosoftImport,
} from './microsoft-types'

const VALIDATION_WINDOW_SECONDS = 10 * 60
const MANUAL_SYNC_INTERVAL_SECONDS = 60
const MAX_IMPORT_ACCOUNTS = 25
export const MICROSOFT_VALIDATION_ATTEMPTS = MAX_IMPORT_ACCOUNTS * 2

export async function claimMicrosoftValidationAttempt(
  env: Env,
  userId: string,
  ip: string,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  const identity = await sha256(`${userId}:${ip}`)
  const windowStartedAt = Math.floor(now / VALIDATION_WINDOW_SECONDS) * VALIDATION_WINDOW_SECONDS
  const result = await env.DB.prepare(
    `INSERT INTO microsoft_imap_validation_limits (
       identity_hash, window_started_at, attempt_count, updated_at
     ) VALUES (?, ?, 1, ?)
     ON CONFLICT(identity_hash) DO UPDATE SET
       window_started_at = excluded.window_started_at,
       attempt_count = CASE
         WHEN microsoft_imap_validation_limits.window_started_at = excluded.window_started_at
           THEN microsoft_imap_validation_limits.attempt_count + 1
         ELSE 1
       END,
       updated_at = excluded.updated_at
     WHERE microsoft_imap_validation_limits.window_started_at != excluded.window_started_at
        OR microsoft_imap_validation_limits.attempt_count < ?`,
  ).bind(identity, windowStartedAt, now, MICROSOFT_VALIDATION_ATTEMPTS).run()
  if (!result.meta.changes) {
    throw new MicrosoftStoreError(
      429,
      'validation_rate_limited',
      'Microsoft 凭据验证过于频繁，请稍后重试。',
    )
  }
}

/**
 * Lists folders and proves the inbox is reachable on an already-open transport.
 *
 * Both adapters expose the inbox under the literal path `INBOX` (Graph is
 * addressed by well-known name and normalised in its adapter), so this check is
 * transport-agnostic.
 */
async function checkInbox(transport: MicrosoftMailTransport): Promise<MicrosoftFolder[]> {
  const folders = await transport.listFolders()
  const inbox = folders.find(({ path }) => path.toUpperCase() === 'INBOX')
  if (!inbox) throw new MicrosoftStoreError(502, 'inbox_unavailable', 'Microsoft INBOX 不可用。')
  await transport.folderState(inbox.path)
  return folders
}

/**
 * Validates a credential that is not stored yet, through the same cascade every
 * other path uses (invariant I-1).
 *
 * `microsoftImportAccount` only ever yields `authMode: 'oauth2'` — password
 * imports are refused at parse time with `password_auth_removed` — so there is
 * no second, IMAP-only path here any more. That path was the bypass that made
 * the 20 RCA credentials (IMAP refused, Graph fine) fail to import.
 */
async function validateImport(env: Env, input: ValidMicrosoftImport): Promise<{
  credential: MicrosoftRotatedCredential
  preferredTransport: MicrosoftTransport
  folders: MicrosoftFolder[]
}> {
  const resolved = await openMicrosoftTransport(env, {
    email: input.email,
    authority: input.authority,
    clientId: input.clientId,
    refreshToken: input.refreshToken || '',
  })
  try {
    const folders = await checkInbox(resolved.transport)
    return {
      // No exchange ran only when the cascade was replaced by a test seam; the
      // pasted token is then still the live one.
      credential: resolved.credential ?? {
        refreshToken: input.refreshToken || '',
        accessToken: '',
        accessTokenExpiresAt: null,
      },
      preferredTransport: resolved.preferredTransport,
      folders,
    }
  } finally {
    await resolved.transport.close()
  }
}

async function enqueueSync(
  env: Env,
  accountId: string,
  reason: MicrosoftSyncJob['reason'],
): Promise<void> {
  await env.MAIL_QUEUE.send({ kind: 'microsoft-sync', accountId, reason })
}

export async function listMicrosoftAccounts(env: Env, user: SessionUser): Promise<Response> {
  try {
    const enabled = microsoftMailEnabled(env)
    const accounts = enabled ? await new MicrosoftAccountStore(env, user.id).list() : []
    return microsoftPrivateJson({ enabled, accounts })
  } catch (error) {
    return microsoftResponseError(error)
  }
}

/**
 * The error response for account-level requests.
 *
 * Adds the per-channel `attempts` when the cascade exhausted both transports,
 * so a client can show "Graph: permission denied / IMAP: access rejected"
 * instead of one opaque failure (I-7). Each attempt carries the same sentence
 * the single-error path would have used for its code. Everything else keeps
 * the shared shape.
 */
function accountErrorResponse(
  error: unknown,
  authMode?: ValidMicrosoftImport['authMode'],
): Response {
  if (error instanceof MicrosoftTransportUnavailableError) {
    return microsoftPrivateJson({
      error: error.message,
      code: error.code,
      attempts: publicMicrosoftTransportAttempts(error.attempts, microsoftFailureMessage),
    }, error.status)
  }
  return microsoftResponseError(error, authMode)
}

function importError(error: unknown, authMode?: ValidMicrosoftImport['authMode']) {
  const response = accountErrorResponse(error, authMode)
  return response.json().then((body) => ({
    status: response.status === 409 ? 'duplicate' as const : 'error' as const,
    ...(body as Record<string, unknown>),
  }))
}

export async function importMicrosoftAccounts(
  env: Env,
  user: SessionUser,
  request: Request,
  ip: string,
): Promise<Response> {
  try {
    const body = await microsoftJsonBody(request)
    const values = Array.isArray(body.accounts) ? body.accounts : []
    if (!values.length || values.length > MAX_IMPORT_ACCOUNTS) {
      throw new MicrosoftInputError(
        'invalid_batch',
        `每批需要提交 1–${MAX_IMPORT_ACCOUNTS} 个 Microsoft 账号。`,
      )
    }
    const store = new MicrosoftAccountStore(env, user.id)
    const existing = new Set((await store.list()).map(({ email }) => email))
    const seen = new Set<string>()
    const results: Array<Record<string, unknown>> = []
    for (let index = 0; index < values.length; index += 1) {
      let input: ValidMicrosoftImport | undefined
      try {
        if (!values[index] || Array.isArray(values[index]) || typeof values[index] !== 'object') {
          throw new MicrosoftInputError('invalid_account', '账号条目必须是 JSON 对象。')
        }
        input = microsoftImportAccount(values[index] as Record<string, unknown>)
        if (existing.has(input.email) || seen.has(input.email)) {
          results.push({ index, status: 'duplicate', code: 'duplicate' })
          continue
        }
        seen.add(input.email)
        await claimMicrosoftValidationAttempt(env, user.id, ip)
        const validated = await validateImport(env, input)
        const now = Math.floor(Date.now() / 1000)
        const account: MicrosoftAccount = {
          id: `microsoft_${crypto.randomUUID().replaceAll('-', '')}`,
          userId: user.id,
          name: input.name,
          providedEmail: input.email,
          normalizedEmail: input.email,
          authMode: input.authMode,
          // The channel that just validated this credential — the state machine
          // leaves `unknown` at import, not on first sync.
          preferredTransport: validated.preferredTransport,
          clientId: input.clientId,
          authority: input.authority,
          refreshToken: validated.credential.refreshToken,
          accessToken: validated.credential.accessToken,
          accessTokenExpiresAt: validated.credential.accessTokenExpiresAt,
          graphAccessTokenExpiresAt: null,
          password: '',
          status: 'active',
          lastSyncedAt: null,
          nextSyncAt: 0,
          lastErrorCode: '',
          lastErrorAt: null,
          syncLeaseId: null,
          syncLeaseUntil: null,
          tokenLeaseId: null,
          tokenLeaseUntil: null,
          lastManualSyncAt: null,
          createdAt: now,
          updatedAt: now,
        }
        await store.insert(account, input.password || '')
        // `insert` does not carry `preferred_transport` (the row takes the column
        // default `unknown`), so the winner is written through the one place that
        // owns that SQL, conditioned on the default it is replacing.
        await recordMicrosoftPreferredTransport(
          env, { ...account, preferredTransport: 'unknown' }, validated.preferredTransport,
        )
        await saveMicrosoftFolders(env, account.id, validated.folders, now)
        await writeAudit(env, user.id, 'microsoft.account.connect', account.id, ip, {
          email: maskedMicrosoftEmail(account.normalizedEmail),
          authMode: account.authMode,
        })
        try { await enqueueSync(env, account.id, 'connect') } catch { /* cron will retry */ }
        existing.add(input.email)
        results.push({ index, status: 'accepted', account: publicMicrosoftAccount(account) })
      } catch (error) {
        results.push({ index, ...await importError(error, input?.authMode) })
      }
    }
    const allAccepted = results.every(({ status }) => status === 'accepted')
    return microsoftPrivateJson({ results }, allAccepted ? 201 : 207)
  } catch (error) {
    return microsoftResponseError(error)
  }
}

export async function renameMicrosoftAccount(
  env: Env,
  user: SessionUser,
  accountId: string,
  request: Request,
  ip: string,
): Promise<Response> {
  try {
    const account = await new MicrosoftAccountStore(env, user.id).rename(
      accountId,
      microsoftName((await microsoftJsonBody(request)).name),
      Math.floor(Date.now() / 1000),
    )
    await writeAudit(env, user.id, 'microsoft.account.rename', accountId, ip)
    return microsoftPrivateJson({ account })
  } catch (error) {
    return microsoftResponseError(error)
  }
}

export async function updateMicrosoftCredential(
  env: Env,
  user: SessionUser,
  accountId: string,
  request: Request,
  ip: string,
): Promise<Response> {
  let authMode: MicrosoftAccount['authMode'] | undefined
  try {
    const store = new MicrosoftAccountStore(env, user.id)
    const account = await store.get(accountId)
    authMode = account.authMode
    const input = microsoftImportAccount({
      ...await microsoftJsonBody(request),
      name: account.name,
      email: account.normalizedEmail,
      authMode,
    })
    await claimMicrosoftValidationAttempt(env, user.id, ip)
    // `microsoftImportAccount` has already refused anything but oauth2, so a
    // legacy password account cannot reach this point with a password to store.
    const validated = await validateImport(env, input)
    const now = Math.floor(Date.now() / 1000)
    await store.replaceOAuthCredential({
      ...account,
      clientId: input.clientId,
      authority: input.authority,
      refreshToken: validated.credential.refreshToken,
      accessToken: validated.credential.accessToken,
      accessTokenExpiresAt: validated.credential.accessTokenExpiresAt,
    }, now)
    // The replace resets stickiness to `unknown` (the old credential's channel
    // says nothing about the new one); the cascade just proved which channel the
    // new credential works on, so record it rather than re-probe on first sync.
    await recordMicrosoftPreferredTransport(
      env, { ...account, preferredTransport: 'unknown' }, validated.preferredTransport,
    )
    await saveMicrosoftFolders(env, accountId, validated.folders, now)
    await writeAudit(env, user.id, 'microsoft.account.credential_update', accountId, ip, {
      email: maskedMicrosoftEmail(account.normalizedEmail),
      authMode,
    })
    try { await enqueueSync(env, accountId, 'manual') } catch { /* cron will retry */ }
    return microsoftPrivateJson({ ok: true })
  } catch (error) {
    return accountErrorResponse(error, authMode)
  }
}

/**
 * Which channel an error came from, when the caller did not get as far as a
 * resolved transport. Only the IMAP client raises `ImapConnectionError`; Graph
 * errors carry `graph_*` codes of their own. An exhausted cascade is judged by
 * its attempts inside the classifier regardless of this hint.
 */
function failedTransport(error: unknown, resolved?: MicrosoftResolvedTransport): MicrosoftTransport {
  return resolved?.preferredTransport ?? (error instanceof ImapConnectionError ? 'imap' : 'graph')
}

/**
 * Leaves the account in the status the classifier derives for this failure —
 * the same derivation sync uses, so verify and sync agree on what a dead
 * credential looks like.
 */
async function recordRemoteFailure(
  env: Env,
  account: MicrosoftAccount,
  error: unknown,
  resolved?: MicrosoftResolvedTransport,
): Promise<void> {
  const failure = microsoftTransportFailure(error, failedTransport(error, resolved))
  const now = Math.floor(Date.now() / 1000)
  try {
    await env.DB.prepare(
      `UPDATE microsoft_imap_accounts SET status = ?, last_error_code = ?,
              last_error_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(microsoftAccountStatusForFailure(failure), failure.code, now, now, account.id).run()
  } catch { /* preserve remote error */ }
}

export async function verifyMicrosoftAccount(
  env: Env,
  user: SessionUser,
  accountId: string,
  ip: string,
): Promise<Response> {
  let account: MicrosoftAccount | undefined
  let resolved: MicrosoftResolvedTransport | undefined
  try {
    // Claim before loading the row: our own rate limit is not a remote failure
    // and must not be recorded against the account.
    await claimMicrosoftValidationAttempt(env, user.id, ip)
    account = await new MicrosoftAccountStore(env, user.id).get(accountId)
    // The cascade records the winning channel on the row (stickiness), so
    // verify doubles as a re-probe for an account whose channel state is stale.
    resolved = await resolveMicrosoftTransport(env, account)
    const folders = await checkInbox(resolved.transport)
    const now = Math.floor(Date.now() / 1000)
    await saveMicrosoftFolders(env, accountId, folders, now)
    await env.DB.prepare(
      `UPDATE microsoft_imap_accounts SET status = 'active', last_error_code = '',
              last_error_at = NULL, updated_at = ?
        WHERE id = ? AND user_id = ?`,
    ).bind(now, accountId, user.id).run()
    await writeAudit(env, user.id, 'microsoft.account.verify', accountId, ip, {
      email: maskedMicrosoftEmail(account.normalizedEmail),
    })
    return microsoftPrivateJson({ ok: true, validatedAt: now })
  } catch (error) {
    if (account) await recordRemoteFailure(env, account, error, resolved)
    return accountErrorResponse(error, account?.authMode)
  } finally {
    await resolved?.transport.close()
  }
}

export async function deleteMicrosoftAccount(
  env: Env,
  user: SessionUser,
  accountId: string,
  ip: string,
): Promise<Response> {
  try {
    const account = await new MicrosoftAccountStore(env, user.id).remove(accountId)
    await writeAudit(env, user.id, 'microsoft.account.disconnect', accountId, ip, {
      email: maskedMicrosoftEmail(account.email),
    })
    return microsoftPrivateJson({ ok: true, remoteRevocationRequired: account.authMode === 'oauth2' })
  } catch (error) {
    return microsoftResponseError(error)
  }
}

export async function requestMicrosoftSync(
  env: Env,
  user: SessionUser,
  accountId: string,
  defer: (task: Promise<unknown>) => void,
): Promise<Response> {
  try {
    const account = await new MicrosoftAccountStore(env, user.id).publicAccount(accountId)
    if (!account) throw new MicrosoftStoreError(404, 'account_not_found', 'Microsoft 账号不存在。')
    if (account.status === 'credential_error' || account.status === 'permission_error') {
      throw new MicrosoftStoreError(409, 'account_requires_attention', '请先修复 Microsoft 凭据或权限。')
    }
    const now = Math.floor(Date.now() / 1000)
    const result = await env.DB.prepare(
      `UPDATE microsoft_imap_accounts SET last_manual_sync_at = ?, next_sync_at = 0,
              updated_at = ?
        WHERE id = ? AND user_id = ?
          AND (last_manual_sync_at IS NULL OR last_manual_sync_at <= ?)`,
    ).bind(now, now, accountId, user.id, now - MANUAL_SYNC_INTERVAL_SECONDS).run()
    if (!result.meta.changes) {
      throw new MicrosoftStoreError(429, 'manual_sync_rate_limited', '手动同步过于频繁，请稍后重试。')
    }
    defer(enqueueSync(env, accountId, 'manual').catch((error) => {
      console.error('Unable to enqueue Microsoft synchronization', {
        accountId,
        type: error instanceof Error ? error.name : typeof error,
      })
    }))
    return microsoftPrivateJson({ queued: true }, 202)
  } catch (error) {
    return microsoftResponseError(error)
  }
}

export async function listMicrosoftFolders(
  env: Env,
  user: SessionUser,
  accountId: string,
  request: Request,
  ip: string,
): Promise<Response> {
  let account: MicrosoftAccount | undefined
  try {
    const store = new MicrosoftAccountStore(env, user.id)
    account = await store.get(accountId)
    if (new URL(request.url).searchParams.get('refresh') === '1') {
      await claimMicrosoftValidationAttempt(env, user.id, ip)
      await refreshMicrosoftFolders(env, account)
    }
    return microsoftPrivateJson({ folders: await store.folders(accountId) })
  } catch (error) {
    if (account) await recordRemoteFailure(env, account, error)
    return accountErrorResponse(error, account?.authMode)
  }
}
