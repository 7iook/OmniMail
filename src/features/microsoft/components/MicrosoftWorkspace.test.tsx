import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MicrosoftAccountDialog } from './MicrosoftAccountDialog'
import { MicrosoftReader } from './MicrosoftReader'
import { MicrosoftWorkspace } from './MicrosoftWorkspace'

describe('Microsoft workspace safety and accessibility boundaries', () => {
  it('shows the deployment recovery path without removing the workspace layout', () => {
    const html = renderToStaticMarkup(
      <MicrosoftWorkspace enabled={false} remoteImagesEnabled={false} />,
    )
    expect(html).toContain('MICROSOFT_CREDENTIALS_KEY')
    expect(html).toContain('MICROSOFT_MAIL_ENABLED')
    expect(html).toContain('microsoft-list-pane')
    expect(html).toContain('选择一封 Microsoft 邮件')
  })

  it('opens an accessible OAuth2-first connection dialog', () => {
    const html = renderToStaticMarkup(<MicrosoftAccountDialog accounts={[]}
      onClose={() => undefined} onChanged={async () => undefined} />)
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('OAuth2')
    expect(html).toContain('class="microsoft-auth-select"')
    expect(html).toContain('role="combobox"')
    expect(html).toContain('aria-haspopup="listbox"')
    expect(html).toContain('Refresh token')
    expect(html).not.toContain('access_token_cipher')
  })

  it('labels the message reader as read-only and exposes attachment downloads', () => {
    const account = {
      id: 'microsoft-1', name: 'Work', email: 'user@outlook.com', status: 'active' as const,
    }
    const summary = {
      id: 'message-1', account, folderPath: 'INBOX', uidValidity: 1, uid: 2,
      senderName: 'Sender', senderAddress: 'sender@example.com', recipients: [], cc: [],
      subject: 'Subject', preview: '', date: 1, sentAt: null, sizeBytes: 10,
      isRead: false, isStarred: false, hasAttachments: true,
    }
    const html = renderToStaticMarkup(<MicrosoftReader selected={summary}
      message={{ ...summary, from: 'Sender <sender@example.com>', to: 'user@outlook.com',
        cc: '', date: '2026-08-25T00:00:00.000Z', body: 'Body', html: '', attachments: [{
          partId: '0', filename: 'report.pdf', contentType: 'application/pdf', size: 10,
          contentId: null, disposition: 'attachment',
        }] }} loading={false} error="" remoteImagesEnabled={false}
      onBack={() => undefined} onRetry={() => undefined} />)
    expect(html).toContain('IMAP · 只读')
    expect(html).toContain('不会标记已读')
    expect(html).toContain('/api/microsoft/accounts/microsoft-1/messages/message-1/attachments/0')
  })
})
