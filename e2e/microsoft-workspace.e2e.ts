import { expect, type Page, type Route, test } from '@playwright/test'

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function prepare(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('omnimail.deployment-guide.v1', 'seen')
    localStorage.setItem('omnimail-locale', 'zh-CN')
  })
}

async function shell(route: Route, path: string) {
  if (path === '/api/config') {
    await json(route, {
      appName: 'OmniMail', setupComplete: true, replyEnabled: false,
      iCloudEnabled: false, iCloudWorkspaceEnabled: false,
      linuxDoMailWorkspaceEnabled: false, gmailEnabled: false, gmailWorkspaceEnabled: false,
      microsoftEnabled: true, microsoftWorkspaceEnabled: true,
      registrationEnabled: false, registrationAvailable: false,
      registrationMethod: 'password', linuxDoLoginEnabled: false,
      registrationDomainPolicy: { mode: 'blocklist', domains: [] },
      registrationProtectionReady: false, turnstileSiteKey: '', mailRefreshInterval: 0,
      remoteImagesEnabled: false, unassignedMailEnabled: false,
      officialExtensionEnabled: false, randomMailboxPrefix: '', superAdminEmail: '',
      setupRequirements: { databaseReady: true, storageReady: true, queueReady: true,
        superAdminReady: true, setupTokenReady: false },
    })
    return true
  }
  if (path === '/api/session') {
    await json(route, { user: {
      id: 'user-1', email: 'user@example.com', displayName: 'User', role: 'user',
      mailboxLimit: 1, storageQuotaBytes: 1024, storageUsedBytes: 0,
      canCreateMailboxes: false, canReply: false, canTranslate: false,
      temporaryExpiresAt: null,
    } })
    return true
  }
  if (path === '/api/mailboxes') { await json(route, { mailboxes: [] }); return true }
  if (path === '/api/domains') { await json(route, { domains: [] }); return true }
  return false
}

const account = {
  id: 'microsoft-1', name: '工作 Outlook', email: 'user@outlook.com',
  authMode: 'oauth2', clientIdMasked: '0000••••0000', authority: 'common',
  status: 'active', lastSyncedAt: 1_787_486_400, nextSyncAt: 1_787_486_700,
  lastErrorCode: '', lastErrorAt: null, createdAt: 1_787_486_400, hasCredential: true,
}

const message = {
  id: 'message-1', account: {
    id: account.id, name: account.name, email: account.email, status: account.status,
  },
  folderPath: 'INBOX', uidValidity: 42, uid: 7,
  senderName: 'Microsoft', senderAddress: 'security@microsoft.com',
  recipients: ['user@outlook.com'], cc: [], subject: '安全提醒', preview: '',
  date: 1_787_486_400, sentAt: 1_787_486_400, sizeBytes: 2048,
  isRead: false, isStarred: false, hasAttachments: true,
}

test('previews Microsoft OAuth2 formats without echoing secrets', async ({ page }) => {
  await prepare(page)
  const imports: unknown[] = []
  let connected = false
  await page.route('**://*/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (await shell(route, path)) return
    if (path === '/api/microsoft/accounts' && request.method() === 'GET') {
      return json(route, { enabled: true, accounts: connected ? [account] : [] })
    }
    if (path === '/api/microsoft/messages') {
      return json(route, { messages: [], page: { hasMore: false, nextCursor: null, limit: 50 }, folderPath: 'INBOX' })
    }
    if (path === '/api/microsoft/accounts/import' && request.method() === 'POST') {
      const body = request.postDataJSON() as { accounts: unknown[] }
      await new Promise((resolve) => setTimeout(resolve, 80))
      imports.push(...body.accounts)
      connected = true
      return json(route, { results: body.accounts.map((_item, index) => ({
        index, status: 'accepted', account,
      })) }, 201)
    }
    return route.abort()
  })

  await page.goto('/microsoft')
  await page.getByRole('button', { name: '添加 Microsoft 账号' }).last().click()
  const dialog = page.getByRole('dialog', { name: '连接 Microsoft 邮箱' })
  await expect(dialog.getByText('仅支持 OAuth2；不再接受仅邮箱密码登录。')).toBeVisible()
  await expect(dialog.getByRole('combobox', { name: '认证方式' })).toHaveCount(0)
  await dialog.getByRole('tab', { name: '批量导入' }).click()
  const formats = dialog.locator('#microsoft-import-formats')
  await expect(formats).toContainText('email----password----refresh_token----client_id')
  await expect(formats).toContainText('email----password----client_id----refresh_token')
  expect(await formats.locator('code').allTextContents()).not.toContain('email----password')
  await expect(formats).toContainText('email--------refresh_token----client_id')
  await expect(formats).toContainText('系统按 UUID 自动识别 Client ID')
  await expect(formats).toContainText('password 会加密保存')
  const clientId = '00000000-0000-4000-8000-000000000000'
  await dialog.getByLabel('每行一个账号').fill([
    `combo@outlook.com----combination-secret----${clientId}----refresh-combo`,
    `reverse@outlook.com----reverse-secret----refresh-reverse----${clientId}`,
    `oauth@outlook.com--------refresh-oauth----${clientId}`,
  ].join('\n'))

  const preview = dialog.locator('.microsoft-import-preview')
  await expect(preview).toContainText('OAuth2 · 组合密码将加密保存')
  await expect(preview).toContainText('0000••••0000')
  await expect(preview).not.toContainText('combination-secret')
  await expect(preview).not.toContainText('reverse-secret')
  await expect(preview).not.toContainText('refresh-combo')

  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: '验证并导入 3 个账号' }).click()
  const progress = dialog.locator('.microsoft-import-progress')
  await expect(progress).toBeVisible()
  await expect(progress).toContainText('正在逐项验证 Microsoft 账号')
  await expect(progress.getByRole('progressbar')).toBeVisible()
  await expect.poll(() => imports).toHaveLength(3)
  await expect(progress).toHaveCount(0)
  expect(imports).toEqual([
    expect.objectContaining({ email: 'combo@outlook.com', authMode: 'oauth2',
      refreshToken: 'refresh-combo', clientId, password: 'combination-secret',
      persistPasswordConfirmed: true }),
    expect.objectContaining({ email: 'reverse@outlook.com', authMode: 'oauth2',
      refreshToken: 'refresh-reverse', clientId, password: 'reverse-secret',
      persistPasswordConfirmed: true }),
    expect.objectContaining({ email: 'oauth@outlook.com', authMode: 'oauth2' }),
  ])
  expect(Object.prototype.hasOwnProperty.call(imports[2], 'password')).toBe(false)
})

test('browses a Microsoft folder, refreshes read-only mail, and renders on mobile', async ({ page }) => {
  await prepare(page)
  await page.setViewportSize({ width: 375, height: 812 })
  await page.addInitScript(() => localStorage.setItem('omnimail-theme', 'dark'))
  const listQueries: string[] = []
  await page.route('**://*/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (await shell(route, path)) return
    if (path === '/api/microsoft/accounts') return json(route, { enabled: true, accounts: [account] })
    if (path === '/api/microsoft/accounts/microsoft-1/folders') return json(route, { folders: [
      { path: 'INBOX', displayName: 'Inbox', flags: ['\\Inbox'], specialUse: '\\Inbox', uidValidity: 42, lastUid: 7 },
      { path: 'Sent Items', displayName: 'Sent Items', flags: ['\\Sent'], specialUse: '\\Sent', uidValidity: 43, lastUid: 2 },
    ] })
    if (path === '/api/microsoft/messages') {
      listQueries.push(url.search)
      return json(route, {
        messages: [message], page: { hasMore: false, nextCursor: null,
          limit: Number(url.searchParams.get('limit') || 50) }, folderPath: 'INBOX',
      })
    }
    if (path === '/api/microsoft/accounts/microsoft-1/messages/message-1') {
      return json(route, { message: {
        ...message, from: 'Microsoft <security@microsoft.com>', to: 'user@outlook.com',
        cc: '', date: '2026-08-25T00:00:00.000Z', body: '只读测试正文', html: '',
        attachments: [{ partId: '0', filename: 'notice.txt', contentType: 'text/plain',
          size: 12, contentId: null, disposition: 'attachment' }],
      } })
    }
    return route.abort()
  })

  await page.goto('/microsoft')
  const scopeTrigger = page.getByRole('button', { name: /当前 Microsoft/ })
  await expect(scopeTrigger).toContainText('全部 Microsoft')
  await scopeTrigger.click()
  let scope = page.getByRole('dialog', { name: '选择 Microsoft 邮箱' })
  await scope.getByRole('button', { name: /工作 Outlook/ }).click()
  await expect(scopeTrigger).toContainText('工作 Outlook')
  await scopeTrigger.click()
  scope = page.getByRole('dialog', { name: '选择 Microsoft 邮箱' })
  await expect(scope.getByText('INBOX 约每 5 分钟定时收信；其他文件夹可手动刷新。')).toBeVisible()
  await scope.getByRole('button', { name: '200' }).click()
  await expect.poll(() => listQueries.some((query) => query.includes('limit=200'))).toBe(true)
  await page.getByRole('button', { name: '远程刷新当前文件夹' }).click()
  await expect.poll(() => listQueries.some((query) => query.includes('refresh=1'))).toBe(true)
  await page.getByText('安全提醒').click()
  await expect(page.getByText('只读测试正文')).toBeVisible()
  await expect(page.getByText(/打开邮件不会标记已读/)).toBeVisible()
  await expect(page.getByRole('link', { name: /notice.txt/ })).toHaveAttribute(
    'href', '/api/microsoft/accounts/microsoft-1/messages/message-1/attachments/0',
  )

  const workspace = page.locator('.microsoft-workspace')
  await expect(workspace).toBeVisible()
  await expect(page.locator('.microsoft-list-controls')).toHaveCount(0)
  expect(await workspace.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
})
