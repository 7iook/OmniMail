import { expect, type Route, test } from '@playwright/test'
import { user } from './omnimail-fixtures'

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

test('lists recent drafts and resumes editing one', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('omnimail.deployment-guide.v1', 'seen')
    localStorage.setItem('omnimail-locale', 'zh-CN')
  })
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/config') return json(route, {
      appName: 'OmniMail', setupComplete: true, replyEnabled: true,
      registrationEnabled: false, registrationAvailable: false,
      registrationMethod: 'password', linuxDoLoginEnabled: false,
      registrationDomainPolicy: { mode: 'blocklist', domains: [] },
      registrationProtectionReady: false, turnstileSiteKey: '',
      mailRefreshInterval: 30, remoteImagesEnabled: false,
      unassignedMailEnabled: false, superAdminEmail: user.email,
      setupRequirements: { databaseReady: true, storageReady: true, queueReady: true,
        superAdminReady: true, setupTokenReady: false },
    })
    if (path === '/api/session') return json(route, { user })
    if (path === '/api/mailboxes') return json(route, { mailboxes: [{
      address: 'inbox@example.com', domain: 'example.com', isPrimary: true, isActive: true,
    }] })
    if (path === '/api/domains') return json(route, { domains: [] })
    if (path === '/api/drafts' && request.method() === 'GET') return json(route, {
      limit: 5,
      drafts: [{
        id: 'draft-1', mailboxAddress: 'inbox@example.com', to: 'friend@example.net',
        subject: 'Travel details', preview: 'My unfinished note', updatedAt: Date.now(),
        attachmentCount: 1, attachmentBytes: 1024,
      }],
    })
    if (path === '/api/drafts/draft-1' && request.method() === 'GET') return json(route, {
      draft: {
        id: 'draft-1', mailboxAddress: 'inbox@example.com', to: 'friend@example.net',
        subject: 'Travel details', text: 'My unfinished note', createdAt: 1,
        updatedAt: Date.now(), attachments: [{
          id: 'file-1', filename: 'ticket.pdf', contentType: 'application/pdf', size: 1024,
        }],
      },
    })
    return json(route, { error: `Unhandled test route: ${request.method()} ${path}` }, 404)
  })

  await page.goto('/mail/drafts')
  await expect(page.getByRole('heading', { name: '草稿箱' })).toBeVisible()
  await expect(page.getByText('已保存 1/5 封草稿')).toBeVisible()
  await page.getByRole('button', { name: '继续编辑草稿：Travel details' }).click()

  const dialog = page.getByRole('dialog', { name: '编辑草稿' })
  await expect(dialog.getByLabel('收件人')).toHaveValue('friend@example.net')
  await expect(dialog.getByLabel('主题')).toHaveValue('Travel details')
  await expect(dialog.getByText('ticket.pdf')).toBeVisible()
})
