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

const reply = {
  ...message,
  id: 'reply-1',
  direction: 'outgoing',
  status: 'sent',
  folder: 'sent',
  senderName: 'Owner',
  senderAddress: 'inbox@example.com',
  recipients: ['sender@example.net'],
  preview: 'Thanks from OmniMail.',
  date: message.date + 1000,
}

type MockState = {
  messageRequests: number
  conditionalRequests: number
  failed: boolean
  version: number
  messageVisible: boolean
  refreshInterval: number
  subject: string
  adminUserStatus: 'active' | 'disabled'
}

function mockState(refreshInterval = 30, subject = message.subject): MockState {
  return {
    messageRequests: 0,
    conditionalRequests: 0,
    failed: true,
    version: 1,
    messageVisible: true,
    refreshInterval,
    subject,
    adminUserStatus: 'active',
  }
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function mockApp(page: Page, state = mockState()) {
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
      registrationProtectionReady: false, turnstileSiteKey: '', mailRefreshInterval: state.refreshInterval,
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
    if (path === '/api/messages/message-1' && request.method() === 'PATCH') {
      const input = request.postDataJSON() as { folder?: string }
      if (input.folder === 'trash') state.messageVisible = false
      state.version += 1
      return json(route, { ok: true })
    }
    if (path === '/api/messages/message-1' && request.method() === 'GET') return json(route, {
      message: {
        ...message, messageId: '<message-1@example.net>', inReplyTo: null, references: null,
        cc: [], text: 'Visit https://example.com',
        html: '<p><a href="https://example.com/account">Visit account</a></p>', attachments: [],
      },
      thread: [message, reply],
    })
    if (path === '/api/messages/reply-1') return json(route, {
      message: {
        ...reply, messageId: null, inReplyTo: '<message-1@example.net>',
        references: '<message-1@example.net>', cc: [], text: 'Thanks from OmniMail.',
        html: '', attachments: [],
      },
      thread: [message, reply],
    })
    if (path === '/api/messages/bulk' && request.method() === 'PATCH') {
      const input = request.postDataJSON() as { ids: string[]; action: string }
      if (input.action === 'trash' || input.action === 'delete') state.messageVisible = false
      state.version += 1
      return json(route, { ok: true, updatedCount: input.ids.length })
    }
    if (path === '/api/messages') {
      state.messageRequests += 1
      const requestedVersion = url.searchParams.get('version')
      if (requestedVersion !== null) state.conditionalRequests += 1
      if (requestedVersion === String(state.version)) {
        return json(route, { unchanged: true, version: state.version })
      }
      return json(route, {
        unchanged: false, version: state.version,
        messages: state.messageVisible ? [{ ...message, subject: state.subject }] : [],
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
    if (path === '/api/admin/users' && request.method() === 'GET') {
      return json(route, {
        users: [{
          id: 'managed-user-1',
          email: 'test11@snipxn.com',
          displayName: 'Test User',
          role: 'user',
          status: state.adminUserStatus,
          mailboxLimit: 1,
          mailboxCount: 1,
          storageQuotaBytes: 1024 ** 3,
          storageUsedBytes: 2048,
          canCreateMailboxes: false,
          canReply: false,
          temporaryExpiresAt: null,
          createdAt: 1_700_000_000,
          updatedAt: 1_700_000_000,
        }],
        totals: {
          total: 1,
          active: state.adminUserStatus === 'active' ? 1 : 0,
          disabled: state.adminUserStatus === 'disabled' ? 1 : 0,
        },
        page: { hasMore: false, nextCursor: null, limit: 50 },
      })
    }
    if (path === '/api/admin/users/managed-user-1' && request.method() === 'PATCH') {
      const input = request.postDataJSON() as {
        status: 'active' | 'disabled'
        role: 'admin' | 'user' | 'temporary'
        mailboxLimit: number
        storageQuotaMiB: number
        canCreateMailboxes: boolean
        canReply: boolean
      }
      state.adminUserStatus = input.status
      return json(route, {
        user: {
          id: 'managed-user-1',
          email: 'test11@snipxn.com',
          displayName: 'Test User',
          role: input.role,
          status: input.status,
          mailboxLimit: input.mailboxLimit,
          mailboxCount: 1,
          storageQuotaBytes: input.storageQuotaMiB * 1024 ** 2,
          storageUsedBytes: 2048,
          canCreateMailboxes: input.canCreateMailboxes,
          canReply: input.canReply,
          temporaryExpiresAt: null,
          createdAt: 1_700_000_000,
          updatedAt: 1_700_000_001,
        },
      })
    }
    if (path === '/api/admin/invites' && request.method() === 'GET') {
      return json(route, {
        invites: [{
          id: 'invite-1',
          domain: 'example.com',
          expiresAt: Math.floor(Date.now() / 1000) + 86400,
          multiUse: false,
          useCount: 0,
          addressMode: 'self_selected',
          assignedAddress: null,
          accountLifetimeHours: 24,
          mailboxLimit: 1,
          canCreateMailboxes: false,
          canReply: false,
          createdAt: Math.floor(Date.now() / 1000),
          state: 'active',
        }],
        page: { hasMore: false, nextCursor: null, limit: 30 },
      })
    }
    if (path === '/api/admin/invites/invite-1/revoke' && request.method() === 'PATCH') {
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

test('users can apply a bulk action to selected messages', async ({ page }) => {
  await mockApp(page)
  await page.goto('/')
  await expect(page.getByRole('checkbox', { name: '选择邮件：Welcome to OmniMail' })).toHaveCount(0)
  await page.getByRole('button', { name: '批量操作' }).click()
  await page.getByRole('checkbox', { name: '选择邮件：Welcome to OmniMail' }).check()
  await page.getByRole('button', { name: '移入垃圾箱' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('您可以在自动清理前恢复')
  await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused()
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(page.getByText('Welcome to OmniMail')).toBeVisible()
  await page.getByRole('button', { name: '移入垃圾箱' }).click()
  await dialog.getByRole('button', { name: '移入垃圾箱' }).click()
  await expect(page.getByText('这里还是空的')).toBeVisible()
})

test('single-message deletion requires confirmation', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 })
  await mockApp(page)
  await page.goto('/')
  await page.getByText('Welcome to OmniMail').click()
  await page.getByRole('button', { name: '移入垃圾箱' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByRole('heading')).toHaveText('将这封邮件移入垃圾箱？')
  expect(await page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true)
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(page.getByRole('heading', { name: 'Welcome to OmniMail' })).toBeVisible()
  await page.getByRole('button', { name: '移入垃圾箱' }).click()
  await dialog.getByRole('button', { name: '移入垃圾箱' }).click()
  await expect(page.getByText('这里还是空的')).toBeVisible()
})

test('permanent bulk deletion explains that it cannot be undone', async ({ page }) => {
  await mockApp(page)
  await page.goto('/')
  await page.getByRole('button', { name: '垃圾箱' }).click()
  await page.getByRole('button', { name: '批量操作' }).click()
  await page.getByRole('checkbox', { name: '选择邮件：Welcome to OmniMail' }).check()
  await page.getByRole('button', { name: '永久删除所选邮件' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('此操作无法撤销')
  await expect(dialog.getByRole('button', { name: '永久删除' })).toBeVisible()
})

test('bulk controls remain usable at common responsive widths', async ({ page }) => {
  await mockApp(page)
  await page.goto('/')
  await page.getByRole('button', { name: '批量操作' }).click()
  await page.getByRole('checkbox', { name: '选择邮件：Welcome to OmniMail' }).check()
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(page.getByRole('button', { name: '移入垃圾箱' })).toBeVisible()
    expect(await page.evaluate(() => (
      document.documentElement.scrollWidth <= document.documentElement.clientWidth
    ))).toBe(true)
  }
})

test('long subjects wrap to two stable lines without horizontal overflow', async ({ page }) => {
  const subject = 'Secure link to log in to Claude.ai | 2026-07-28 09:52:24'
  await page.setViewportSize({ width: 375, height: 900 })
  await mockApp(page, mockState(30, subject))
  await page.goto('/')
  const title = page.locator('.message-row__subject-text')
  await expect(title).toHaveText(subject)
  const metrics = await title.evaluate((element) => {
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight)
    return {
      height: element.getBoundingClientRect().height,
      lineHeight,
      scrollHeight: element.scrollHeight,
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }
  })
  expect(metrics.height).toBeGreaterThan(metrics.lineHeight * 1.5)
  expect(metrics.height).toBeLessThanOrEqual(metrics.lineHeight * 2.1)
  expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.height + 1)
  expect(metrics.pageOverflow).toBe(false)
  await expect(page.locator('.message-row__main')).toHaveAttribute('data-tooltip', subject)
})

test('tooltips finish their exit animation before unmounting', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await mockApp(page)
  await page.goto('/')
  await page.getByRole('button', { name: '刷新邮件' }).hover()
  const tooltip = page.locator('.omni-tooltip')
  await expect(tooltip).toHaveAttribute('data-state', 'open')
  await page.evaluate(() => {
    const events: string[] = []
    ;(window as typeof window & { __tooltipExitEvents?: string[] }).__tooltipExitEvents = events
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes' && record.target instanceof HTMLElement) {
          events.push(record.target.dataset.state || '')
        }
        if (record.type === 'childList' && [...record.removedNodes].some((node) => (
          node instanceof Element && node.matches('.omni-tooltip')
        ))) {
          events.push('removed')
        }
      }
    }).observe(document.body, {
      attributes: true,
      attributeFilter: ['data-state'],
      childList: true,
      subtree: true,
    })
  })
  await page.locator('.search-field').hover()
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __tooltipExitEvents?: string[] }).__tooltipExitEvents
  ))).toEqual(['closing', 'removed'])
})

test('related messages are available as a conversation thread', async ({ page }) => {
  await mockApp(page)
  await page.goto('/')
  await page.getByText('Welcome to OmniMail').click()
  await expect(page.getByText('会话中 2 封邮件')).toBeVisible()
  await page.getByRole('button', { name: /发给 sender@example.net/ }).click()
  await expect(page.locator('.plain-body')).toHaveText('Thanks from OmniMail.')
})

test('visible tabs share one automatic refresh leader', async ({ page, context }) => {
  const state = mockState(5)
  await mockApp(page, state)
  const secondPage = await context.newPage()
  await mockApp(secondPage, state)
  await Promise.all([page.goto('/'), secondPage.goto('/')])
  await expect(page.getByText('Welcome to OmniMail')).toBeVisible()
  await expect(secondPage.getByText('Welcome to OmniMail')).toBeVisible()
  await secondPage.waitForTimeout(800)
  const before = state.conditionalRequests
  await secondPage.waitForTimeout(5200)
  expect(state.conditionalRequests - before).toBe(1)
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

test('disabling a user uses the in-app safety dialog', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 })
  await mockApp(page)
  await page.goto('/')
  await page.getByRole('button', { name: '用户' }).click()
  await page.getByRole('button', { name: /Test User/ }).click()
  await page.getByRole('checkbox', { name: /封禁账户/ }).check()
  await page.getByRole('button', { name: '保存权限' }).click()

  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByRole('heading')).toHaveText('封禁 test11@snipxn.com？')
  await expect(dialog).toContainText('所有现有会话都将失效')
  await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused()
  expect(await page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true)

  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: '保存权限' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '确认封禁' }).click()
  await expect(page.getByText('账户已封禁')).toBeVisible()
})

test('invitation lifecycle has a dedicated responsive admin page', async ({ page }) => {
  await mockApp(page)
  await page.goto('/')
  await page.getByRole('button', { name: '邀请' }).click()
  await expect(page.getByRole('heading', { name: '邀请管理' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '最近邀请' })).toBeVisible()
  const expiry = page.locator('.invite-expiry')
  await expect(expiry).toHaveCSS('white-space', 'nowrap')
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '撤销' }).click()
  await expect(page.getByText('已撤销')).toBeVisible()
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => (
      document.documentElement.scrollWidth <= document.documentElement.clientWidth
    ))).toBe(true)
  }
})
