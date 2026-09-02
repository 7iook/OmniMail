import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { MicrosoftAccount } from '../../../shared/api'
import { MicrosoftAccountDialog } from './MicrosoftAccountDialog'
import { MicrosoftReader } from './MicrosoftReader'
import {
  autoRefreshOffNotice, microsoftPollingEnabled, MicrosoftWorkspace, pushDegradedNotice,
} from './MicrosoftWorkspace'

function microsoftAccount(overrides: Partial<MicrosoftAccount> = {}): MicrosoftAccount {
  return {
    id: 'microsoft-1', name: 'Work', email: 'user@outlook.com', authMode: 'oauth2',
    clientIdMasked: '0000••••0000', authority: 'common', status: 'active',
    lastSyncedAt: null, nextSyncAt: 0, lastErrorCode: '', lastErrorAt: null,
    createdAt: 0, hasCredential: true, ...overrides,
  }
}

describe('Microsoft workspace safety and accessibility boundaries', () => {
  it('shows the deployment recovery path without removing the workspace layout', () => {
    const html = renderToStaticMarkup(
      <MicrosoftWorkspace enabled={false} remoteImagesEnabled={false} mailRefreshInterval={30} />,
    )
    expect(html).toContain('MICROSOFT_CREDENTIALS_KEY')
    expect(html).toContain('MICROSOFT_MAIL_ENABLED')
    expect(html).toContain('microsoft-list-pane')
    expect(html).toContain('选择一封 Microsoft 邮件')
    expect(html).not.toContain('正文和附件只在打开时读取')
  })

  it('opens an accessible OAuth2-only connection dialog', () => {
    const html = renderToStaticMarkup(<MicrosoftAccountDialog accounts={[]}
      onClose={() => undefined} onChanged={async () => undefined} />)
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('OAuth2')
    expect(html).toContain('仅支持 OAuth2')
    expect(html).not.toContain('role="combobox"')
    expect(html).toContain('Refresh token')
    expect(html).not.toContain('access_token_cipher')
  })

  it('renders the message without a persistent permission notice and exposes attachments', () => {
    const account = {
      id: 'microsoft-1', name: 'Work', email: 'user@outlook.com', status: 'active' as const,
    }
    const summary = {
      id: 'message-1', account, folderPath: 'INBOX', uidValidity: 1, remoteId: '2',
      senderName: 'Sender', senderAddress: 'sender@example.com', recipients: [], cc: [],
      subject: 'Subject', preview: '', date: 1, sentAt: null, sizeBytes: 10,
      isRead: false, isStarred: false, hasAttachments: true,
    }
    const html = renderToStaticMarkup(<MicrosoftReader selected={summary}
      message={{ ...summary, isRead: true, from: 'Sender <sender@example.com>', to: 'user@outlook.com',
        cc: '', date: '2026-08-25T00:00:00.000Z', body: 'Body', html: '', attachments: [{
          partId: '0', filename: 'report.pdf', contentType: 'application/pdf', size: 10,
          contentId: null, disposition: 'attachment',
        }] }} loading={false} error="" remoteImagesEnabled={false}
      onBack={() => undefined} onRetry={() => undefined} />)
    // D-1: the source badge names the provider, not the transport, since the
    // same reader serves Graph- and IMAP-connected accounts.
    expect(html).toContain('icloud-source-badge is-imap">Microsoft<')
    expect(html).not.toContain('>IMAP<')
    expect(html).not.toContain('仅允许已读状态写入')
    expect(html).not.toContain('gmail-readonly-note')
    expect(html).toContain('/api/microsoft/accounts/microsoft-1/messages/message-1/attachments/0')
  })
})

describe('Microsoft §12.7 A1 — fixed 5s polling gate', () => {
  it('polls only while the workspace feature is enabled and the global interval is not explicitly off', () => {
    expect(microsoftPollingEnabled(true, 30)).toBe(true)
    expect(microsoftPollingEnabled(true, 5)).toBe(true)
    expect(microsoftPollingEnabled(true, 120)).toBe(true)
    // 0 is the admin's explicit "off", not "use the global cadence instead".
    expect(microsoftPollingEnabled(true, 0)).toBe(false)
    expect(microsoftPollingEnabled(false, 30)).toBe(false)
  })

  it('shows the off note only when enabled but the global interval is explicitly 0', () => {
    expect(autoRefreshOffNotice(true, 0)).toBe('自动刷新已关闭')
    expect(autoRefreshOffNotice(true, 30)).toBe('')
    expect(autoRefreshOffNotice(false, 0)).toBe('')
  })

  it('renders the off note near the list header when the global interval is 0', () => {
    const html = renderToStaticMarkup(
      <MicrosoftWorkspace enabled remoteImagesEnabled={false} mailRefreshInterval={0} />,
    )
    expect(html).toContain('自动刷新已关闭')
  })

  it('does not render the off note when the global interval polls normally', () => {
    const html = renderToStaticMarkup(
      <MicrosoftWorkspace enabled remoteImagesEnabled={false} mailRefreshInterval={30} />,
    )
    expect(html).not.toContain('自动刷新已关闭')
  })
})

describe('Microsoft §12.7 Q3 — degraded push notice', () => {
  it('shows the notice only when at least one listed account is degraded', () => {
    expect(pushDegradedNotice([microsoftAccount({ pushStatus: 'degraded' })]))
      .toBe('实时推送暂不可用，正在按 5 分钟同步')
    expect(pushDegradedNotice([microsoftAccount({ pushStatus: 'active' })])).toBe('')
    expect(pushDegradedNotice([microsoftAccount({ pushStatus: 'off' })])).toBe('')
    expect(pushDegradedNotice([microsoftAccount({ pushStatus: undefined })])).toBe('')
    expect(pushDegradedNotice([])).toBe('')
  })
})
