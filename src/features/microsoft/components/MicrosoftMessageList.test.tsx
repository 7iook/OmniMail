import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { MicrosoftMessageSummary } from '../../../shared/api'
import { MicrosoftMessageList } from './MicrosoftMessageList'

const account = { id: 'microsoft-1', name: 'Work', email: 'user@outlook.com', status: 'active' as const }
const accountsList = [{
  id: 'microsoft-1', name: 'Work', email: 'user@outlook.com', authMode: 'oauth2' as const,
  clientIdMasked: '0000••••0000', authority: 'common', status: 'active' as const,
  lastSyncedAt: null, nextSyncAt: 0, lastErrorCode: '', lastErrorAt: null,
  createdAt: 0, hasCredential: true as const,
}]

function message(overrides: Partial<MicrosoftMessageSummary> = {}): MicrosoftMessageSummary {
  return {
    id: 'message-1', account, folderPath: 'INBOX', uidValidity: 1, remoteId: '2',
    senderName: 'Sender', senderAddress: 'sender@example.com', recipients: [], cc: [],
    subject: 'Subject', preview: '', date: 1, sentAt: null, sizeBytes: 10,
    isRead: true, isStarred: false, hasAttachments: false, ...overrides,
  }
}

const basePage = { hasMore: false, nextCursor: null, limit: 50 }
const noop = () => undefined

describe('Microsoft Q1 — Junk Email label in the aggregate view', () => {
  it('labels a Junk Email row as 「垃圾邮件」 in the aggregate ("全部 Microsoft") view', () => {
    const html = renderToStaticMarkup(<MicrosoftMessageList enabled loading={false}
      accounts={accountsList} accountId="" searchQuery="" messages={[message({ folderPath: 'Junk Email' })]}
      selectedId={null} page={basePage} loadingMore={false}
      onSelect={noop} onLoadMore={noop} onAddAccount={noop} />)
    expect(html).toContain('垃圾邮件')
    expect(html).toContain('icloud-source-badge')
  })

  it('does not label an INBOX row in the aggregate view', () => {
    const html = renderToStaticMarkup(<MicrosoftMessageList enabled loading={false}
      accounts={accountsList} accountId="" searchQuery="" messages={[message({ folderPath: 'INBOX' })]}
      selectedId={null} page={basePage} loadingMore={false}
      onSelect={noop} onLoadMore={noop} onAddAccount={noop} />)
    expect(html).not.toContain('垃圾邮件')
  })

  it('never labels a row once the user is browsing a single account/folder, even the Junk one', () => {
    const html = renderToStaticMarkup(<MicrosoftMessageList enabled loading={false}
      accounts={accountsList} accountId="microsoft-1" searchQuery="" messages={[message({ folderPath: 'Junk Email' })]}
      selectedId={null} page={basePage} loadingMore={false}
      onSelect={noop} onLoadMore={noop} onAddAccount={noop} />)
    expect(html).not.toContain('垃圾邮件')
  })

  it('matches the folder path case-insensitively, mirroring the backend\'s `upper(folder_path)` aggregate filter', () => {
    const html = renderToStaticMarkup(<MicrosoftMessageList enabled loading={false}
      accounts={accountsList} accountId="" searchQuery="" messages={[message({ folderPath: 'JUNK EMAIL' })]}
      selectedId={null} page={basePage} loadingMore={false}
      onSelect={noop} onLoadMore={noop} onAddAccount={noop} />)
    expect(html).toContain('垃圾邮件')
  })
})
