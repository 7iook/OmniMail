import { expect, type Page, type Route, test } from '@playwright/test'
import { message, user } from './omnimail-fixtures'

function json(route: Route, body: unknown) {
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
}

async function mockUnreadInbox(page: Page) {
  const messages = [
    { ...message, id: 'read-message', subject: 'Already read', isRead: true },
    { ...message, id: 'unread-message', subject: 'Needs attention', isRead: false },
  ]
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(() => {
    localStorage.setItem('omnimail.deployment-guide.v1', 'seen')
    localStorage.setItem('omnimail-locale', 'zh-CN')
  })
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/config') return json(route, {
      appName: 'OmniMail', setupComplete: true, replyEnabled: false,
      registrationEnabled: false, registrationAvailable: false,
      registrationMethod: 'password', linuxDoLoginEnabled: false,
      registrationDomainPolicy: { mode: 'blocklist', domains: [] },
      registrationProtectionReady: false, turnstileSiteKey: '', mailRefreshInterval: 0,
      remoteImagesEnabled: false, unassignedMailEnabled: false, superAdminEmail: user.email,
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
    if (path === '/api/messages') return json(route, {
      unchanged: false, version: 1, messages,
      counts: { unread: 1, starred: 0, drafts: 0, sent: 0, trash: 0 },
      page: { hasMore: false, nextCursor: null, limit: 30 },
    })
    return route.abort()
  })
}

test('inbox unread filter and row indicator clearly distinguish unread mail', async ({ page }) => {
  await mockUnreadInbox(page)
  await page.goto('/')

  const unreadRow = page.locator('.message-row', { hasText: 'Needs attention' })
  const readRow = page.locator('.message-row', { hasText: 'Already read' })
  await expect(unreadRow.locator('.message-row__unread-dot')).toBeVisible()
  await expect(readRow.locator('.message-row__unread-dot')).toHaveCount(0)
  const timeBox = await unreadRow.locator('time').boundingBox()
  const dotBox = await unreadRow.locator('.message-row__unread-dot').boundingBox()
  expect(dotBox?.x || 0).toBeGreaterThanOrEqual((timeBox?.x || 0) + (timeBox?.width || 0))

  const filter = page.getByRole('button', { name: '仅看未读' })
  await expect(filter).toHaveAttribute('aria-pressed', 'false')
  await filter.click()
  await expect(filter).toHaveAttribute('aria-pressed', 'true')
  await expect(unreadRow).toBeVisible()
  await expect(readRow).toBeHidden()
})
