import type { Env } from '../../app/types'
import { ImapConnectionError } from '../../platform/imap/imap-errors'
import { MicrosoftGraphClient } from './microsoft-graph'
import { microsoftGraphTransport } from './microsoft-graph-transport'
import type { MicrosoftImapClient } from './microsoft-imap'
import { microsoftImapTransport } from './microsoft-imap-transport'
import { MicrosoftStoreError } from './microsoft-store'
import { refreshMicrosoftToken } from './microsoft-token'
import { microsoftAccessToken } from './microsoft-token-manager'
import type { MicrosoftMailTransport } from './microsoft-transport'
import {
  microsoftTransportFailure,
  MicrosoftTransportUnavailableError,
  type MicrosoftTransportFailure,
} from './microsoft-transport-errors'
import type {
  MicrosoftAccount,
  MicrosoftPreferredTransport,
  MicrosoftTransport,
} from './microsoft-types'

export { MicrosoftTransportUnavailableError }

/**
 * A mailbox that is not in the database yet.
 *
 * Import validates credentials before inserting the row, so there is no account
 * id to lease a cached token against and no row to write stickiness to. The
 * cascade accepts this shape as well as a stored account — which is what lets
 * both entry points share one resolver instead of import growing its own copy
 * (invariant I-1).
 */
export interface MicrosoftImportCandidate {
  email: string
  authority: string
  clientId: string
  refreshToken: string
}

export interface MicrosoftRotatedCredential {
  refreshToken: string
  accessToken: string
  accessTokenExpiresAt: number | null
}

export interface MicrosoftResolvedTransport {
  transport: MicrosoftMailTransport
  /** Which channel actually worked. Import persists this on the new row. */
  preferredTransport: MicrosoftTransport
  /**
   * Rotated credentials, present for an import candidate once a token exchange
   * happened. Absent only when no exchange ran (test seams), in which case the
   * pasted refresh token is still the live one.
   */
  credential?: MicrosoftRotatedCredential
}

type Target =
  | { kind: 'account'; account: MicrosoftAccount }
  | {
    kind: 'candidate'
    candidate: MicrosoftImportCandidate
    rotated?: MicrosoftRotatedCredential
  }

/** Test seam: replaces both channel factories. `null` restores the real ones. */
interface TransportFactories {
  graph: (env: Env, target: Target) => Promise<MicrosoftMailTransport>
  imap: (env: Env, target: Target) => Promise<MicrosoftMailTransport>
}

let factories: TransportFactories | null = null

export function __setMicrosoftTransportFactories(value: TransportFactories | null): void {
  factories = value
}

async function imapClientFor(
  target: Target,
  credential: string,
): Promise<MicrosoftImapClient> {
  const email = target.kind === 'account'
    ? target.account.normalizedEmail : target.candidate.email
  const { MicrosoftImapClient } = await import('./microsoft-imap')
  return new MicrosoftImapClient(email, 'oauth2', credential)
}

/**
 * An access token for one channel.
 *
 * A stored account goes through the token manager, which owns the lease and the
 * per-transport cipher columns. A candidate cannot: with no row there is nothing
 * to lease, so it refreshes directly and hands the rotated values back for the
 * caller to persist alongside the new row.
 */
async function accessToken(
  env: Env,
  target: Target,
  transport: MicrosoftTransport,
  force = false,
): Promise<string> {
  if (target.kind === 'account') {
    return await microsoftAccessToken(env, target.account, { transport, force })
  }
  const result = await refreshMicrosoftToken({
    authority: target.candidate.authority,
    clientId: target.candidate.clientId,
    refreshToken: target.candidate.refreshToken,
    transport,
  })
  // The refresh token rotates on every exchange, so the newest one is the one
  // that must be stored: persisting the pasted value would leave a dead account.
  target.candidate.refreshToken = result.refreshToken
  const expiresAt = Math.floor(Date.now() / 1_000) + result.expiresIn
  target.rotated = {
    refreshToken: result.refreshToken,
    // Only the IMAP token belongs in `access_token_cipher`; a Graph token stored
    // there would later be handed to an IMAP caller, which always 401s (I-4).
    accessToken: transport === 'imap' ? result.accessToken : target.rotated?.accessToken ?? '',
    accessTokenExpiresAt: transport === 'imap'
      ? expiresAt : target.rotated?.accessTokenExpiresAt ?? null,
  }
  return result.accessToken
}

/**
 * Opens the IMAP channel, retrying once with a forced token refresh.
 *
 * This is the pre-Graph cascade, unchanged: a 400/401 from the IMAP handshake is
 * usually a stale access token rather than a dead credential, so one forced
 * refresh is tried before the channel is judged unusable.
 */
async function openImapClient(env: Env, target: Target): Promise<MicrosoftImapClient> {
  let remote = await imapClientFor(target, await accessToken(env, target, 'imap'))
  try {
    await remote.open()
    return remote
  } catch (error) {
    await remote.close()
    if (!(error instanceof ImapConnectionError)
      || (error.status !== 400 && error.status !== 401)) {
      throw error
    }
    remote = await imapClientFor(target, await accessToken(env, target, 'imap', true))
    try {
      await remote.open()
      return remote
    } catch (retryError) {
      await remote.close()
      throw retryError
    }
  }
}

async function imapTransport(env: Env, target: Target): Promise<MicrosoftMailTransport> {
  // Already opened, so the forced-refresh retry stays in one place rather than
  // being repeated per transport.
  return microsoftImapTransport(await openImapClient(env, target))
}

async function graphTransport(env: Env, target: Target): Promise<MicrosoftMailTransport> {
  const transport = microsoftGraphTransport(new MicrosoftGraphClient({
    accessToken: await accessToken(env, target, 'graph'),
  }))
  // Graph has no handshake, so the adapter's probe is what proves the channel.
  // Without this the cascade would accept a dead channel as working.
  await transport.open()
  return transport
}

/**
 * The order to try channels in.
 *
 * `unknown` leads with Graph: measured working for all 20 credentials in the RCA,
 * the same ones IMAP refuses. A recorded transport leads so a later sync reuses
 * what worked instead of probing again.
 */
function order(preferred: MicrosoftPreferredTransport): MicrosoftTransport[] {
  return preferred === 'imap' ? ['imap', 'graph'] : ['graph', 'imap']
}

/**
 * Records which channel won, only if the stored value still matches what we read.
 *
 * Conditional on purpose: two concurrent syncs must not overwrite each other's
 * finding. Losing that race is not an error — the fetch already succeeded and the
 * next sync re-derives the hint — so a zero-row update is accepted silently.
 *
 * Exported for the two paths where the row is written by something other than
 * the cascade itself (import's INSERT and credential update's reset both leave
 * `unknown` behind), so the write-back SQL still exists in exactly one place.
 */
export async function recordMicrosoftPreferredTransport(
  env: Env,
  account: MicrosoftAccount,
  winner: MicrosoftTransport,
): Promise<void> {
  const previous = account.preferredTransport
  if (previous === winner) return
  try {
    const result = await env.DB.prepare(
      `UPDATE microsoft_imap_accounts
          SET preferred_transport = ?, updated_at = ?
        WHERE id = ? AND preferred_transport = ?`,
    ).bind(winner, Math.floor(Date.now() / 1_000), account.id, previous).run()
    if (result.meta.changes) account.preferredTransport = winner
  } catch (error) {
    // Stickiness is an optimisation; failing to store it must not fail a fetch
    // that already worked.
    console.error('Unable to record Microsoft preferred transport', {
      accountId: account.id,
      type: error instanceof Error ? error.name : typeof error,
    })
  }
}

function attempt(
  env: Env,
  target: Target,
  transport: MicrosoftTransport,
): Promise<MicrosoftMailTransport> {
  if (factories) return factories[transport](env, target)
  return transport === 'graph' ? graphTransport(env, target) : imapTransport(env, target)
}

/**
 * The single transport cascade.
 *
 * Every path that needs a Microsoft mailbox arrives here — scheduled sync, folder
 * refresh, manual refresh, message read, verify, import and credential update.
 * Whether a failure may move to the other channel is decided by
 * {@link microsoftTransportFailure}, never by a condition written at a call site.
 */
async function cascade(env: Env, target: Target): Promise<MicrosoftResolvedTransport> {
  if (target.kind === 'account' && target.account.authMode !== 'oauth2') {
    throw new MicrosoftStoreError(
      409, 'password_auth_removed', 'Microsoft 密码 LOGIN 已停用，请断开后使用 OAuth2 重新连接。',
    )
  }
  const preferred = target.kind === 'account'
    ? target.account.preferredTransport : 'unknown'
  const sequence = order(preferred)
  const attempts: MicrosoftTransportFailure[] = []

  for (const channel of sequence) {
    try {
      const transport = await attempt(env, target, channel)
      if (target.kind === 'account') {
        await recordMicrosoftPreferredTransport(env, target.account, channel)
      }
      return {
        transport,
        preferredTransport: channel,
        ...(target.kind === 'candidate' && target.rotated
          ? { credential: target.rotated } : {}),
      }
    } catch (error) {
      const failure = microsoftTransportFailure(error, channel)
      attempts.push(failure)
      // Only an authorisation-class failure is evidence this channel cannot serve
      // the mailbox. Throttling and transient faults are re-raised untouched, so
      // the retry-after seconds reach scheduling and stickiness stays put.
      if (!failure.mayTryOtherTransport) throw error
    }
  }
  throw new MicrosoftTransportUnavailableError(attempts)
}

/** Resolves a transport for a stored account, recording the winner. */
export async function resolveMicrosoftTransport(
  env: Env,
  account: MicrosoftAccount,
): Promise<MicrosoftResolvedTransport> {
  return await cascade(env, { kind: 'account', account })
}

/**
 * Resolves a transport for a mailbox that is not stored yet.
 *
 * Used by import and credential update. The winner comes back in
 * `preferredTransport` for the caller to persist on the row, since there is no
 * row to conditionally update yet.
 */
export async function openMicrosoftTransport(
  env: Env,
  candidate: MicrosoftImportCandidate,
): Promise<MicrosoftResolvedTransport> {
  return await cascade(env, { kind: 'candidate', candidate })
}
