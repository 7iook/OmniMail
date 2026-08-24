import { expect, type Page, type Route, test } from '@playwright/test'

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function mockGmail(page: Page) {
  let account: Record<string, unknown> | null = null
  const connections: Array<{ name: string; email: string; appPassword: string }> = []
  const gmailRequests: Array<{ method: string; path: string }> = []
  const syncRequests: string[] = []
  await page.addInitScript(() => {
    localStorage.setItem('omnimail.deployment-guide.v1', 'seen')
    localStorage.setItem('omnimail-locale', 'zh-CN')
  })
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path.startsWith('/api/gmail/')) gmailRequests.push({ method: request.method(), path })
    if (path === '/api/config') return json(route, {
      appName: 'OmniMail', setupComplete: true, replyEnabled: false,
      iCloudEnabled: false, iCloudWorkspaceEnabled: true,
      linuxDoMailWorkspaceEnabled: true, gmailEnabled: true, gmailWorkspaceEnabled: true,
      registrationEnabled: false, registrationAvailable: false,
      registrationMethod: 'password', linuxDoLoginEnabled: false,
      registrationDomainPolicy: { mode: 'blocklist', domains: [] },
      registrationProtectionReady: false, turnstileSiteKey: '', mailRefreshInterval: 0,
      remoteImagesEnabled: false, unassignedMailEnabled: false,
      officialExtensionEnabled: false, randomMailboxPrefix: '', superAdminEmail: '',
      setupRequirements: { databaseReady: true, storageReady: true, queueReady: true,
        superAdminReady: true, setupTokenReady: false },
    })
    if (path === '/api/session') return json(route, { user: {
      id: 'user-1', email: 'user@example.com', displayName: 'User', role: 'user',
      mailboxLimit: 1, storageQuotaBytes: 1024, storageUsedBytes: 0,
      canCreateMailboxes: false, canReply: false, canTranslate: false,
      temporaryExpiresAt: null,
    } })
    if (path === '/api/mailboxes') return json(route, { mailboxes: [] })
    if (path === '/api/domains') return json(route, { domains: [] })
    if (path === '/api/gmail/accounts' && request.method() === 'POST') {
      connections.push(request.postDataJSON())
      account = {
        id: 'gmail-1', name: '个人 Gmail', email: 'user@gmail.com', status: 'active',
        lastSyncedAt: 1_787_486_400, nextSyncAt: 1_787_486_700,
        lastErrorCode: '', lastErrorAt: null, createdAt: 1_787_486_400,
        hasAppPassword: true,
      }
      return json(route, { account }, 201)
    }
    if (path === '/api/gmail/accounts' && request.method() === 'GET') {
      return json(route, { enabled: true, accounts: account ? [account] : [] })
    }
    if (path === '/api/gmail/messages' && request.method() === 'GET') {
      const indexed = account ? Array.from({ length: 30 }, (_, index) => ({
        id: `message-${index + 1}`, account: {
          id: 'gmail-1', name: '个人 Gmail', email: 'user@gmail.com', status: 'active',
        },
        senderName: index === 0 ? 'Google' : `Sender ${index + 1}`,
        senderAddress: index === 0 ? 'no-reply@google.com' : `sender${index + 1}@example.com`,
        recipients: ['user@gmail.com'], cc: [],
        subject: index === 0 ? '安全提醒' : `测试邮件 ${index + 1}`,
        preview: '', date: 1_787_486_400 - index * 60,
        sizeBytes: 1024, isRead: index !== 0, isStarred: false,
        hasAttachments: index === 0,
      })) : []
      const query = (url.searchParams.get('q') || '').trim().toLowerCase()
      const messages = query ? indexed.filter((message) => [
        message.senderName, message.senderAddress, message.subject, ...message.recipients,
      ].some((value) => value.toLowerCase().includes(query))) : indexed
      return json(route, {
        messages,
        page: {
          hasMore: Boolean(account) && !query,
          nextCursor: account && !query ? 'cursor-1' : null,
          limit: 30,
        },
      })
    }
    if (path === '/api/gmail/accounts/gmail-1/messages/message-1') {
      return json(route, { message: {
        id: 'message-1', account: {
          id: 'gmail-1', name: '个人 Gmail', email: 'user@gmail.com', status: 'active',
        },
        senderName: 'Google', senderAddress: 'no-reply@google.com', recipients: ['user@gmail.com'],
        subject: '安全提醒', preview: '', sizeBytes: 1024, isRead: true,
        isStarred: false, hasAttachments: true, from: 'Google <no-reply@google.com>',
        to: 'user@gmail.com', cc: '', date: '2026-08-23T12:00:00.000Z',
        body: '这是一封 Gmail 测试邮件。', html: `
          <table id="wide-table" width="900" style="width:900px;min-width:900px">
            <tr><td><div style="min-width:760px;white-space:nowrap;overflow:hidden">
              <h1 id="wide-title" style="white-space:nowrap">这是一封 Gmail 测试邮件，标题需要在窄阅读区完整换行显示。</h1>
              <img id="wide-image" width="900" height="120" alt="响应式测试图片"
                src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='900' height='120'%3E%3Crect width='900' height='120' fill='%23ddd'/%3E%3C/svg%3E">
              <div id="fixed-canvas" style="position:relative;width:900px;height:100px;overflow:hidden">
                <span>左侧内容</span><span id="right-edge"
                  style="position:absolute;left:820px;top:0;width:80px">右侧内容</span>
              </div>
            </div></td></tr>
          </table>`, attachments: [{
          partId: '0', filename: 'notice.txt', contentType: 'text/plain', size: 12,
          contentId: null, disposition: 'attachment',
        }],
      } })
    }
    if (path === '/api/gmail/accounts/gmail-1' && request.method() === 'DELETE') {
      account = null
      return json(route, { ok: true, remoteRevocationRequired: true })
    }
    if (path.endsWith('/sync')) {
      syncRequests.push(path)
      account = {
        ...(account || {}),
        lastSyncedAt: Number(account?.lastSyncedAt || 0) + 1,
        status: 'active',
      }
      return json(route, { queued: true }, 202)
    }
    if (path.endsWith('/verify')) return json(route, { ok: true, validatedAt: 1_787_486_400 })
    return route.abort()
  })
  return { connections, gmailRequests, syncRequests }
}

test('connects Gmail, marks opened mail read, and preserves controlled IMAP behavior', async ({ page }) => {
  const state = await mockGmail(page)
  await page.goto('/gmail')

  await expect(page.getByRole('button', { name: 'Gmail 邮箱' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '连接你的第一个 Gmail' })).toBeVisible()
  await page.locator('.gmail-list-state--empty')
    .getByRole('button', { name: '添加 Gmail 账号' }).click()
  const connect = page.getByRole('dialog', { name: '连接 Gmail 账号' })
  const googlePasswordLink = connect.getByRole('link', { name: '创建 Google 应用密码' })
  const connectButton = connect.getByRole('button', { name: '验证并连接' })
  await expect(googlePasswordLink).toHaveAttribute(
    'href', 'https://myaccount.google.com/apppasswords',
  )
  expect(Math.abs(
    await googlePasswordLink.evaluate((element) => element.getBoundingClientRect().top)
      - await connectButton.evaluate((element) => element.getBoundingClientRect().top),
  )).toBeLessThan(1)
  expect(await connectButton.evaluate((element) => element.getBoundingClientRect().right))
    .toBeGreaterThan(await googlePasswordLink.evaluate((element) => element.getBoundingClientRect().right))
  expect(Math.abs(
    await connectButton.evaluate((element) => element.getBoundingClientRect().right)
      - await connect.locator('.gmail-connect-actions')
        .evaluate((element) => element.getBoundingClientRect().right),
  )).toBeLessThan(1)
  await page.setViewportSize({ width: 375, height: 812 })
  expect(Math.abs(
    await googlePasswordLink.evaluate((element) => element.getBoundingClientRect().top)
      - await connectButton.evaluate((element) => element.getBoundingClientRect().top),
  )).toBeLessThan(1)
  expect(await connect.locator('.gmail-connect-actions').evaluate((element) => (
    element.scrollWidth <= element.clientWidth
  ))).toBe(true)
  await page.setViewportSize({ width: 1280, height: 720 })
  await connect.getByLabel('账号名称').fill('个人 Gmail')
  await connect.getByLabel('邮箱地址').fill('user@gmail.com')
  const password = connect.getByLabel('16 位应用专用密码')
  await password.fill('abcd efgh ijkl mnop')
  await connect.getByRole('button', { name: '验证并连接' }).click()

  await expect.poll(() => state.connections).toEqual([{
    name: '个人 Gmail', email: 'user@gmail.com', appPassword: 'abcd efgh ijkl mnop',
  }])
  const accounts = page.getByRole('dialog', { name: 'Gmail 账号管理' })
  await expect(accounts.getByText('已连接 1 个账号')).toBeVisible()
  await expect(accounts).not.toContainText('1/5')
  await accounts.getByRole('button', { name: /个人 Gmail.*管理/s }).click()
  const settings = page.getByRole('dialog', { name: '设置 个人 Gmail' })
  await expect(settings.getByText('验证邮箱连接')).toBeVisible()
  await expect(settings.getByText('更新应用专用密码')).toBeVisible()
  await settings.getByRole('button', { name: '返回' }).click()
  await page.getByRole('button', { name: '关闭' }).click()
  await expect(page.getByText('安全提醒')).toBeVisible()
  await expect(page.locator('.gmail-mail-view.icloud-mail-view')).toBeVisible()
  await expect(page.locator('.gmail-message-list .message-row')).toHaveCount(30)
  const search = page.getByRole('searchbox', { name: '搜索 Gmail 邮件' })
  await search.fill('Sender 30')
  await expect(page.locator('.gmail-message-list .message-row')).toHaveCount(1)
  await expect(page.getByText('测试邮件 30')).toBeVisible()
  await page.getByRole('button', { name: '清除搜索' }).click()
  await expect(page.locator('.gmail-message-list .message-row')).toHaveCount(30)
  await page.getByRole('button', { name: '同步全部 Gmail 账号' }).click()
  await expect.poll(() => state.syncRequests).toEqual([
    '/api/gmail/accounts/gmail-1/sync',
  ])
  await expect(page.getByRole('status')).toContainText('Gmail 同步完成')
  const scopeTrigger = page.getByRole('button', { name: /当前 Gmail.*全部 Gmail/s })
  await scopeTrigger.click()
  const scope = page.getByRole('dialog', { name: '选择 Gmail 邮箱' })
  await scope.getByRole('button', { name: /个人 Gmail.*user@gmail.com/s }).click()
  await expect(page.getByRole('button', { name: /当前 Gmail.*个人 Gmail/s })).toBeVisible()
  await expect(page.getByRole('button', { name: '同步当前 Gmail 账号' })).toBeVisible()

  const loadMore = page.getByRole('button', { name: '加载更多' })
  await expect(loadMore).not.toBeInViewport()
  await page.locator('.gmail-message-list .message-list')
    .evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await expect(loadMore).toBeInViewport()
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('abcd')

  const unreadRow = page.locator('.gmail-message-list .message-row').filter({ hasText: '安全提醒' })
  await expect(unreadRow).toHaveClass(/is-unread/)
  await page.getByRole('button', { name: /Google.*安全提醒/s }).click()
  await expect(unreadRow).not.toHaveClass(/is-unread/)
  await expect(page.locator('.gmail-reader-pane .icloud-reader')).toBeVisible()
  await expect(page.locator('.gmail-reader-pane .reader-toolbar')).toBeVisible()
  const emailFrame = page.locator('.gmail-reader-pane iframe')
  const emailDocument = page.frameLocator('.gmail-reader-pane iframe')
  await expect(emailFrame).toBeVisible()
  await expect(emailDocument.getByText(/这是一封 Gmail 测试邮件/)).toBeVisible()
  expect(await emailDocument.locator('html').evaluate((element) => (
    element.scrollWidth <= element.clientWidth
  ))).toBe(true)
  expect(await emailDocument.locator('#wide-title').evaluate((element) => (
    getComputedStyle(element).whiteSpace
  ))).toBe('normal')
  expect(await emailDocument.locator('#wide-table').evaluate((element) => (
    element.getBoundingClientRect().width <= document.body.clientWidth
  ))).toBe(true)
  expect(await emailDocument.locator('body').evaluate((element) => (
    getComputedStyle(element).transform !== 'none'
  ))).toBe(true)
  expect(await emailDocument.locator('#right-edge').evaluate((element) => (
    element.getBoundingClientRect().right <= document.documentElement.clientWidth + 1
  ))).toBe(true)
  await expect(page.getByRole('link', { name: /notice.txt/ })).toHaveAttribute(
    'href', '/api/gmail/accounts/gmail-1/messages/message-1/attachments/0',
  )
  expect(state.gmailRequests.filter(({ method, path }) => (
    method !== 'GET' && path.includes('/messages/message-1')
  ))).toEqual([])

  await page.setViewportSize({ width: 375, height: 812 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
    .toBe(true)
  const mobileWorkspaceButtons = page.locator('.folder-nav > button')
  await expect(mobileWorkspaceButtons).toHaveCount(8)
  expect(Math.min(...await mobileWorkspaceButtons.evaluateAll((buttons) => (
    buttons.map((button) => button.getBoundingClientRect().width)
  )))).toBeGreaterThanOrEqual(44)
  expect(await page.locator('.folder-nav').evaluate((element) => element.scrollWidth > element.clientWidth))
    .toBe(true)
  expect(await emailDocument.locator('html').evaluate((element) => (
    element.scrollWidth <= element.clientWidth
  ))).toBe(true)
  await expect(page.getByRole('button', { name: '返回邮件列表' })).toBeVisible()
})
