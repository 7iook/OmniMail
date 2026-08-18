import { expect, type Page, type Route, test } from '@playwright/test'

function json(route: Route, body: unknown) {
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
}

async function mockICloud(page: Page, options: { hasAppPassword?: boolean } = {}) {
  const hasAppPassword = options.hasAppPassword ?? true
  const aliases = [{
    email: 'shop@icloud.com', anonymousId: 'alias-1', label: 'Shopping', active: true,
  }]
  const inboxAliases: string[] = []
  await page.addInitScript(() => {
    localStorage.setItem('omnimail.deployment-guide.v1', 'seen')
    localStorage.setItem('omnimail-locale', 'zh-CN')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => undefined },
    })
  })
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path === '/api/config') return json(route, {
      appName: 'OmniMail', setupComplete: true, replyEnabled: false,
      iCloudEnabled: true, registrationEnabled: false, registrationAvailable: false,
      registrationMethod: 'password', linuxDoLoginEnabled: false,
      registrationDomainPolicy: { mode: 'blocklist', domains: [] },
      registrationProtectionReady: false, turnstileSiteKey: '', mailRefreshInterval: 0,
      remoteImagesEnabled: true, unassignedMailEnabled: false, superAdminEmail: '',
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
    if (path === '/api/remote-images') return route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="32"><rect width="120" height="32" rx="6" fill="#24292f"/><text x="60" y="21" text-anchor="middle" fill="white">GitHub</text></svg>',
    })
    if (path === '/api/icloud/accounts') return json(route, { accounts: [{
      id: 'icloud-1', name: 'Personal', realEmail: 'owner@example.com',
      icloudEmail: 'owner@icloud.com', host: 'icloud.com', status: 'active',
      aliasTotal: 1, aliasActive: 1, lastValidated: '2026-08-13T00:00:00.000Z',
      lastError: '', createdAt: '2026-08-13T00:00:00.000Z',
      hasCookies: true, hasAppPassword,
    }] })
    if (path === '/api/icloud/aliases' && request.method() === 'POST') {
      const input = request.postDataJSON() as { label: string }
      const alias = {
        email: 'new-alias@icloud.com', anonymousId: 'alias-2',
        label: input.label, active: true,
      }
      aliases.push(alias)
      return json(route, { alias })
    }
    if (path === '/api/icloud/aliases') return json(route, { aliases })
    if (path === '/api/icloud/inbox') {
      const alias = url.searchParams.get('alias') || ''
      inboxAliases.push(alias)
      return json(route, { method: hasAppPassword ? 'imap' : 'web', messages: [{
      id: '42', from: 'Store <store@example.com>', to: alias || 'shop@icloud.com',
      subject: 'Your receipt', date: '2026-08-13T00:00:00.000Z',
      preview: 'Thanks for your order.', body: 'Thanks for your order.', html: '',
    }] })
    }
    if (path === '/api/icloud/inbox/42') return json(route, { message: {
      id: '42', from: 'Store <store@example.com>', to: 'shop@icloud.com',
      subject: 'Your receipt', date: '2026-08-13T00:00:00.000Z',
      preview: 'Thanks for your order.', body: 'Full receipt body.',
      html: '<html><body><img src="https://github.com/logo.png" alt="GitHub"><h1>Full receipt body.</h1><p><a href="https://github.com/account_verifications">Open receipt</a></p><script>document.body.textContent="unsafe"</script></body></html>',
    } })
    return route.abort()
  })
  return { inboxAliases }
}

test('iCloud workspace is available to a regular user and reads a message', async ({ page }) => {
  await page.setViewportSize({ width: 2048, height: 1150 })
  await mockICloud(page)
  await page.goto('/icloud')

  await expect(page.getByRole('heading', { name: 'iCloud', exact: true })).toBeVisible()
  await expect(page.getByText('Personal')).toBeVisible()
  await expect(page.getByText('Your receipt')).toBeVisible()
  await expect(page.getByText('IMAP 完整邮件')).toBeVisible()
  const addAccount = page.getByRole('button', { name: '添加 iCloud 账号' })
  await addAccount.hover()
  await expect(page.getByRole('tooltip')).toHaveText('添加 iCloud 账号')

  await addAccount.click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.locator('.icloud-modal-backdrop')).toHaveClass(/is-visible/)
  await expect(page.getByRole('dialog').getByRole('textbox', { name: '账号名称' }))
    .toBeFocused()
  const region = page.getByRole('dialog').getByRole('combobox', { name: 'iCloud 区域' })
  await expect(region).toContainText('全球')
  await region.click()
  const regionOptions = page.getByRole('listbox', { name: 'iCloud 区域' })
  await expect(regionOptions).toBeVisible()
  await regionOptions.getByRole('option', { name: /中国大陆/ }).click()
  await expect(region).toContainText('中国大陆')
  await region.press('ArrowDown')
  await expect(regionOptions.getByRole('option', { name: /中国大陆/ })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(regionOptions).toBeHidden()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.icloud-modal-backdrop')).not.toHaveClass(/is-visible/)
  await expect(page.getByRole('dialog')).toBeHidden()

  await page.getByRole('button', { name: /当前 iCloud.*Personal/ }).click()
  const scopeDialog = page.getByRole('dialog', { name: '选择查看范围' })
  await expect(scopeDialog).toBeVisible()
  await scopeDialog.getByRole('button', { name: '复制邮箱地址：shop@icloud.com' }).click()
  await expect(page.getByRole('status')).toContainText('已复制：shop@icloud.com')
  await expect(scopeDialog).toBeVisible()
  await scopeDialog.getByRole('button', { name: /Shopping/ }).click()
  await page.getByRole('button', { name: '复制', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('已复制：shop@icloud.com')

  await page.getByRole('button', { name: /Your receipt/ }).click()
  const messageFrame = page.frameLocator('iframe[title^="邮件正文"]')
  await expect(messageFrame.getByRole('heading', { name: 'Full receipt body.' })).toBeVisible()
  await expect(messageFrame.getByRole('img', { name: 'GitHub' })).toHaveJSProperty('naturalWidth', 120)
  await expect(messageFrame.getByText('unsafe')).toHaveCount(0)
  await messageFrame.getByRole('link', { name: 'Open receipt' }).click()
  const externalLink = page.getByRole('alertdialog')
  await expect(externalLink).toContainText('github.com')
  await externalLink.getByRole('button', { name: '取消' }).click()
  await page.setViewportSize({ width: 375, height: 812 })
  await expect(page.getByRole('button', { name: '返回邮件列表' })).toBeVisible()
  await page.getByRole('button', { name: '返回邮件列表' }).click()
  await expect(page.locator('iframe[title^="邮件正文"]')).toBeHidden()
  await expect(page.getByRole('button', { name: /Your receipt/ })).toBeVisible()
})

test('explains Cookie summary mode before an app-specific password is configured', async ({ page }) => {
  await mockICloud(page, { hasAppPassword: false })
  await page.goto('/icloud')

  await expect(page.getByText('Web 摘要', { exact: true })).toBeVisible()
  await expect(page.getByText('配置应用专用密码后可读取完整正文')).toBeVisible()
  await expect(page.getByRole('button', { name: '配置', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /Your receipt/ }).click()
  await expect(page.getByText('当前显示 iCloud Web 摘要')).toBeVisible()
})

test('opens the newly created Hide My Email address', async ({ page }) => {
  const state = await mockICloud(page)
  await page.goto('/icloud')

  await page.getByRole('button', { name: '创建隐藏邮箱' }).click()
  const dialog = page.getByRole('dialog', { name: '创建隐藏邮箱' })
  await dialog.getByRole('textbox', { name: '用途标签' }).fill('New service')
  await dialog.getByRole('button', { name: '创建', exact: true }).click()

  await expect(page.locator('.icloud-list-context'))
    .toContainText('new-alias@icloud.com')
  await expect.poll(() => state.inboxAliases.at(-1)).toBe('new-alias@icloud.com')
})
