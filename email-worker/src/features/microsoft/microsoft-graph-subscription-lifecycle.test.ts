import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../app/types'
import { teardownMicrosoftGraphSubscriptions } from './microsoft-graph-subscription-lifecycle'
import type { MicrosoftAccount, MicrosoftGraphSubscription } from './microsoft-types'

// review3 re-review Important #1: a rejected row's `subscription_id` is now
// `null` (0038), never a sentinel string sent to Graph as though it were
// real. This is the test the finding named as missing:
// "rebuild/teardown/non-Graph cleanup — Tests: rejected null row → no remote
// call in rebuild/teardown/non-Graph cleanup". `microsoft-graph-reconcile.
// test.ts` covers rebuild and non-Graph cleanup; this file covers teardown,
// which previously had no dedicated test at all.

const { microsoftAccessToken } = vi.hoisted(() => ({ microsoftAccessToken: vi.fn() }))
vi.mock('./microsoft-token-manager', () => ({ microsoftAccessToken }))

const { removeMock, forAccountMock } = vi.hoisted(() => ({
  removeMock: vi.fn(async () => undefined),
  forAccountMock: vi.fn(async (): Promise<MicrosoftGraphSubscription[]> => []),
}))
vi.mock('./microsoft-graph-subscriptions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./microsoft-graph-subscriptions')>()
  return {
    ...actual,
    MicrosoftGraphSubscriptionClient: vi.fn().mockImplementation(function FakeClient() {
      return { remove: removeMock }
    }),
  }
})
vi.mock('./microsoft-graph-subscription-store', () => ({
  MicrosoftGraphSubscriptionStore: vi.fn().mockImplementation(function FakeStore() {
    return { forAccount: forAccountMock, remove: vi.fn(async () => undefined) }
  }),
}))

function account(overrides: Partial<MicrosoftAccount> = {}): MicrosoftAccount {
  return {
    id: 'acct-1',
    userId: 'user-1',
    name: 'Work',
    providedEmail: 'user@outlook.com',
    normalizedEmail: 'user@outlook.com',
    authMode: 'oauth2',
    preferredTransport: 'graph',
    clientId: 'client',
    authority: 'common',
    refreshToken: 'refresh',
    accessToken: '',
    password: '',
    accessTokenExpiresAt: null,
    graphAccessTokenExpiresAt: null,
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
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function subscriptionRow(overrides: Partial<MicrosoftGraphSubscription> = {}): MicrosoftGraphSubscription {
  return {
    id: 'row-1',
    accountId: 'acct-1',
    folderPath: 'INBOX',
    subscriptionId: 'graph-sub-1',
    clientStateHash: 'hash',
    expiresAt: 0,
    status: 'active',
    failureCount: 0,
    nextAttemptAt: 0,
    refreshState: 'idle',
    refreshPending: false,
    refreshStateAt: 0,
    lastNotifiedAt: null,
    lastErrorCode: '',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('teardownMicrosoftGraphSubscriptions (re-review Important #1: null-id rows)', () => {
  beforeEach(() => {
    microsoftAccessToken.mockReset().mockResolvedValue('graph-token')
    removeMock.mockReset().mockResolvedValue(undefined)
    forAccountMock.mockReset()
  })

  it('sends no remote DELETE for a rejected row with subscriptionId: null', async () => {
    forAccountMock.mockResolvedValue([
      subscriptionRow({ id: 'row-null', subscriptionId: null, status: 'rejected' }),
    ])
    const env = {} as Env

    await teardownMicrosoftGraphSubscriptions(env, account(), { dropLocalRows: true })

    expect(removeMock).not.toHaveBeenCalled()
  })

  it('still sends a remote DELETE for a row that does carry a real subscriptionId', async () => {
    forAccountMock.mockResolvedValue([subscriptionRow({ id: 'row-real', subscriptionId: 'graph-sub-1' })])
    const env = {} as Env

    await teardownMicrosoftGraphSubscriptions(env, account(), { dropLocalRows: true })

    expect(removeMock).toHaveBeenCalledWith('graph-sub-1')
  })

  it('a mix of null and real ids only calls remove for the real one', async () => {
    forAccountMock.mockResolvedValue([
      subscriptionRow({ id: 'row-null', folderPath: 'INBOX', subscriptionId: null, status: 'rejected' }),
      subscriptionRow({ id: 'row-real', folderPath: 'Junk Email', subscriptionId: 'graph-sub-2' }),
    ])
    const env = {} as Env

    await teardownMicrosoftGraphSubscriptions(env, account(), { dropLocalRows: true })

    expect(removeMock).toHaveBeenCalledTimes(1)
    expect(removeMock).toHaveBeenCalledWith('graph-sub-2')
  })

  it('a password-mode account never attempts a remote call regardless of subscriptionId', async () => {
    forAccountMock.mockResolvedValue([subscriptionRow({ subscriptionId: 'graph-sub-1' })])
    const env = {} as Env

    await teardownMicrosoftGraphSubscriptions(env, account({ authMode: 'password' }), { dropLocalRows: true })

    expect(removeMock).not.toHaveBeenCalled()
    expect(microsoftAccessToken).not.toHaveBeenCalled()
  })
})
