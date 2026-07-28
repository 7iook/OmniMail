import { expect, type Page, type Route, test } from '@playwright/test'

const user = {
  id: 'user-1',
  email: 'owner@example.com',
  displayName: 'Owner',
  role: 'super_admin',
  mailboxLimit: 100,
  storageQuotaBytes: 5 * 1024 ** 3,
  storageUsedBytes: 2048,
  canCreateMailboxes: true,
  canReply: true,
  temporaryExpiresAt: null,
}

const message = {
  id: 'message-1',
  mailboxAddress: 'inbox@example.com',
  direction: 'incoming',
  status: 'ready',
  folder: 'inbox',
  senderName: 'Example Sender',
  senderAddress: 'sender@example.net',
  recipients: ['inbox@example.com'],
  subject: 'Welcome to OmniMail',
  preview: 'Open the secure link.',
  date: Date.now(),
  attachmentCount: 0,
  isRead: true,
  isStarred: false,
  processingError: null,
  purgeAfter: null,
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function mockApp(page: Page) {
  const state = { messageRequests: 0, failed: true }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(() => {
    localStorage.setItem('omnimail.deployment-guide.v1', 'seen')
    localStorage.setItem('omnimail-locale', 'zh-CN')
  })
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path === '/api/config') return json(route, {
      appName: 'OmniMail', setupComplete: true, replyEnabled: false,
      registrationEnabled: false, registrationDomainPolicy: { mode: 'blocklist', domains: [] },
      registrationProtectionReady: false, turnstileSiteKey: '', mailRefreshInterval: 30,
      remoteImagesEnabled: false, superAdminEmail: user.email,
      setupRequirements: { databaseReady: true, storageReady: true, queueReady: true,
        superAdminReady: true, setupTokenReady: false },
    })
    if (path === '/api/session') return json(route, { user })
    if (path === '/api/mailboxes') return json(route, { mailboxes: [
      { address: 'inbox@example.com', domain: 'example.com', isPrimary: true, isActive: true },
    ] })
    if (path === '/api/domains') return json(route, { domains: [
      { name: 'example.com', isActive: true, mailboxCount: 1, createdAt: 1, updatedAt: 1 },
    ] })
    if (path === '/api/messages/message-1') return json(route, { message: {
      ...message, messageId: '<message-1@example.net>', inReplyTo: null, references: null,
      cc: [], text: 'Visit https://example.com',
      html: '<p><a href="https://example.com/account">Visit account</a></p>', attachments: [],
    } })
    if (path === '/api/messages') {
      state.messageRequests += 1
      if (url.searchParams.get('version') === '1') {
        return json(route, { unchanged: true, version: 1 })
      }
      return json(route, {
        unchanged: false, version: 1, messages: [message],
        counts: { unread: 0, starred: 0, sent: 0, trash: 0 },
        page: { hasMore: false, nextCursor: null, limit: 30 },
      })
    }
    if (path === '/api/admin/statistics') return json(route, {
      days: 30, generatedAt: Math.floor(Date.now() / 1000),
      summary: { totalReceived: 1, periodReceived: 1, todayReceived: 1, uniqueSenders: 1 },
      daily: Array.from({ length: 30 }, (_, index) => ({ day: 1_700_000_000 + index * 86400,
        count: index === 29 ? 1 : 0 })),
      sourceDomains: [{ domain: 'example.net', count: 1 }],
      topSenders: [{ address: 'sender@example.net', name: 'Example Sender', count: 1 }],
      platform: {
        refreshInterval: 30,
        workerRequests: { estimatedPerVisibleTab: 2880, dailyLimit: 100000 },
        d1RowsRead: { estimatedPerVisibleTab: 89280, dailyLimit: 5000000 },
        queueOperations: { estimatedToday: 3, dailyLimit: 10000 },
        r2Storage: { estimatedPrimaryBytes: 2048, freeBytes: 10 * 1024 ** 3 },
      },
      storage: {
        messageCount: 1, usedBytes: 2048, attachmentCount: 0, attachmentBytes: 0,
        trashCount: 0, trashBytes: 0, failedCount: state.failed ? 1 : 0,
        failedBytes: state.failed ? 2048 : 0, userCount: 1,
        quotaBytes: 5 * 1024 ** 3, quotaUsedBytes: 2048, unlimitedUsers: 0,
        byUser: [], byMailbox: [],
      },
    })
    if (path === '/api/admin/failed-messages' && request.method() === 'GET') {
      return json(route, state.failed ? { total: 1, messages: [{
        id: 'failed-1', mailboxAddress: 'inbox@example.com', senderName: '',
        senderAddress: 'broken@example.net', subject: 'Broken MIME', error: 'MIME parse failed',
        attempts: 3, lastFailedAt: Date.now(), size: 2048, canRetry: true,
      }] } : { total: 0, messages: [] })
    }
    if (path === '/api/admin/failed-messages/failed-1/retry' && request.method() === 'POST') {
      state.failed = false
      return json(route, { ok: true })
    }
    return json(route, { error: `Unhandled test route: ${request.method()} ${path}` }, 500)
  })
  return state
}

test('reselecting the inbox quietly refreshes without hiding the list', async ({ page }) => {
  const state = await mockApp(page)
  await page.goto('/')
  await expect(page.getByText('Welcome to OmniMail')).toBeVisible()
  const requestsBeforeReselect = state.messageRequests
  await page.getByRole('button', { name: '收件箱' }).click()
  await expect.poll(() => state.messageRequests).toBeGreaterThan(requestsBeforeReselect)
  await expect(page.getByText('Welcome to OmniMail')).toBeVisible()
  await expect(page.getByText('正在读取邮件')).toHaveCount(0)
})

test('email links open the safety dialog instead of navigating the iframe', async ({ page }) => {
  await mockApp(page)
  await page.goto('/')
  await page.getByText('Welcome to OmniMail').click()
  const link = page.frameLocator('iframe').getByRole('link', { name: 'Visit account' })
  await link.click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('example.com')
  await expect(dialog.getByRole('button', { name: '复制链接' })).toBeVisible()
  await expect(page).toHaveURL('http://127.0.0.1:4173/')
})

test('administrators can review usage estimates and retry failed mail', async ({ page }) => {
  await mockApp(page)
  await page.goto('/')
  await page.getByRole('button', { name: '统计' }).click()
  await expect(page.getByRole('heading', { name: 'Cloudflare 免费额度参考' })).toBeVisible()
  await expect(page.getByText('Broken MIME')).toBeVisible()
  await page.getByRole('button', { name: '重新处理' }).click()
  await expect(page.getByText('当前没有失败邮件')).toBeVisible()
})
