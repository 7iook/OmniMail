import { expect, test } from '@playwright/test'
import { message, user } from './omnimail-fixtures'

test('mailbox rows copy addresses without changing the current scope', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 })
  await page.addInitScript(() => {
    localStorage.setItem('omnimail.deployment-guide.v1', 'seen')
    localStorage.setItem('omnimail-locale', 'zh-CN')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          localStorage.setItem('omnimail-test-copied', value)
        },
      },
    })
  })
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    const responses: Record<string, unknown> = {
      '/api/config': {
        appName: 'OmniMail', setupComplete: true, replyEnabled: false,
        registrationEnabled: false, registrationAvailable: false,
        registrationMethod: 'password', linuxDoLoginEnabled: false,
        registrationDomainPolicy: { mode: 'blocklist', domains: [] },
        registrationProtectionReady: false, turnstileSiteKey: '',
        mailRefreshInterval: 30, remoteImagesEnabled: false,
        unassignedMailEnabled: false, superAdminEmail: user.email,
        setupRequirements: {
          databaseReady: true, storageReady: true, queueReady: true,
          superAdminReady: true, setupTokenReady: false,
        },
      },
      '/api/session': { user },
      '/api/mailboxes': {
        mailboxes: [{
          address: 'inbox@example.com', domain: 'example.com',
          isPrimary: true, isActive: true,
        }],
      },
      '/api/domains': {
        domains: [{
          name: 'example.com', isActive: true, mailboxCount: 1,
          createdAt: 1, updatedAt: 1,
        }],
      },
      '/api/messages': {
        unchanged: false, version: 1, messages: [message],
        counts: { unread: 0, starred: 0, sent: 0, trash: 0 },
        page: { hasMore: false, nextCursor: null, limit: 30 },
      },
    }
    const body = responses[path]
    return route.fulfill({
      status: body ? 200 : 404,
      contentType: 'application/json',
      body: JSON.stringify(body || { error: 'Not found' }),
    })
  })
  await page.goto('/')
  const trigger = page.getByRole('button', { name: /^当前邮箱/ })
  await trigger.click()
  const panel = page.locator('.mailbox-switcher__panel')
  const backdrop = page.locator('.switcher-backdrop')
  await expect(backdrop).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(backdrop).toHaveCSS('backdrop-filter', 'none')
  const copy = page.getByRole('button', { name: '复制邮箱地址：inbox@example.com' })
  await expect(copy).toBeVisible()
  const geometry = await copy.evaluate((element) => ({
    copyRight: element.getBoundingClientRect().right,
    rowRight: element.parentElement?.getBoundingClientRect().right || 0,
  }))
  expect(geometry.copyRight).toBeLessThanOrEqual(geometry.rowRight)
  await copy.click()
  await expect(panel).toHaveAttribute('data-state', 'open')
  await expect(page.getByRole('status')).toHaveText('已复制：inbox@example.com')
  await expect(trigger).toContainText('所有邮箱')
  expect(await page.evaluate(
    () => localStorage.getItem('omnimail-test-copied'),
  )).toBe('inbox@example.com')
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  )).toBe(true)
})
