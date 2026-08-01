import { expect, type Route, test } from '@playwright/test'
import { message, user } from './omnimail-fixtures'

function json(route: Route, body: unknown) {
  return route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

test('slow remote images do not block readable email content', async ({ page }) => {
  let proxiedImageSource = ''
  let releaseRemoteImage!: () => void
  const remoteImageGate = new Promise<void>((resolve) => {
    releaseRemoteImage = resolve
  })

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.addInitScript(() => {
    localStorage.setItem('omnimail.deployment-guide.v1', 'seen')
    localStorage.setItem('omnimail-locale', 'zh-CN')
  })
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/config') return json(route, {
      appName: 'OmniMail', setupComplete: true, replyEnabled: false,
      registrationEnabled: false, registrationAvailable: false,
      registrationMethod: 'password', linuxDoLoginEnabled: false,
      registrationDomainPolicy: { mode: 'blocklist', domains: [] },
      registrationProtectionReady: false, turnstileSiteKey: '',
      mailRefreshInterval: 30, remoteImagesEnabled: true,
      unassignedMailEnabled: false, superAdminEmail: user.email,
      setupRequirements: {
        databaseReady: true, storageReady: true, queueReady: true,
        superAdminReady: true, setupTokenReady: false,
      },
    })
    if (path === '/api/session') return json(route, { user })
    if (path === '/api/mailboxes') return json(route, { mailboxes: [{
      address: 'inbox@example.com', domain: 'example.com',
      isPrimary: true, isActive: true,
    }] })
    if (path === '/api/domains') return json(route, { domains: [] })
    if (path === '/api/draft') return json(route, { draft: null })
    if (path === '/api/messages/message-1') return json(route, {
      message: {
        ...message, messageId: null, inReplyTo: null, references: null,
        cc: [], text: 'Readable before the image',
        html: `
          <style>
            @media (prefers-color-scheme: dark) {
              .content { color: white !important; }
            }
          </style>
          <div class="content" style="background:#fff">
            Readable before the image
            <img src="http://assets.vodafone.co.uk/slow.gif" alt="Slow image">
          </div>`,
        attachments: [],
      },
      thread: [message],
    })
    if (path === '/api/messages') return json(route, {
      unchanged: false, version: 1, messages: [message],
      counts: { unread: 0, starred: 0, sent: 0, trash: 0 },
      page: { hasMore: false, nextCursor: null, limit: 30 },
    })
    if (path === '/api/remote-images') {
      proxiedImageSource = new URL(request.url()).searchParams.get('url') ?? ''
      await remoteImageGate
      return route.fulfill({
        contentType: 'image/gif',
        body: Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64'),
      })
    }
    return route.fulfill({ status: 500, body: `Unhandled route: ${path}` })
  })

  try {
    await page.goto('/')
    await page.getByText('Welcome to OmniMail').click()
    const content = page.frameLocator('iframe').locator('.content')
    await expect(content).toBeVisible()
    await expect(content).toHaveCSS('color', 'rgb(34, 34, 34)')
    await expect(content).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    const reader = page.locator('.reader-content')
    await expect(reader).not.toHaveClass(/is-scrollbar-active/)
    await reader.hover()
    await page.mouse.wheel(0, 120)
    await expect(reader).toHaveClass(/is-scrollbar-active/)
    await expect(reader).not.toHaveClass(/is-scrollbar-active/, { timeout: 2_000 })
    await expect.poll(() => proxiedImageSource).toBe(
      'https://assets.vodafone.co.uk/slow.gif',
    )
    releaseRemoteImage()
    await expect.poll(() => content.locator('img').evaluate((image) => (
      (image as HTMLImageElement).naturalWidth
    ))).toBe(1)
  } finally {
    releaseRemoteImage()
  }
})

test('translates a message and switches back to the original', async ({ page }) => {
  let requestedTarget = ''
  await page.addInitScript(() => {
    localStorage.setItem('omnimail.deployment-guide.v1', 'seen')
    localStorage.setItem('omnimail-locale', 'zh-CN')
  })
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/config') return json(route, {
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
    })
    if (path === '/api/session') return json(route, { user })
    if (path === '/api/mailboxes') return json(route, { mailboxes: [{
      address: 'inbox@example.com', domain: 'example.com',
      isPrimary: true, isActive: true,
    }] })
    if (path === '/api/domains') return json(route, { domains: [] })
    if (path === '/api/draft') return json(route, { draft: null })
    if (path === '/api/messages/message-1/translation') {
      requestedTarget = request.postDataJSON().targetLanguage
      return json(route, { translation: {
        sourceLanguage: 'hr', targetLanguage: 'zh', cached: false,
        subject: '欢迎使用 OmniMail', text: '你的 A1 eSIM 已准备就绪。',
        html: `<html lang="zh"><body>
          <table class="translated-layout"><tr><td>
            <a href="https://example.com/activate"><strong>你的 A1 eSIM</strong></a>
            <p>你的 A1 eSIM 已准备就绪。</p>
          </td></tr></table>
        </body></html>`,
      } })
    }
    if (path === '/api/messages/message-1') return json(route, {
      message: {
        ...message, messageId: null, inReplyTo: null, references: null,
        cc: [], text: 'Tvoj A1 eSIM je spreman.',
        html: '<html lang="hr"><body><p class="original-copy">Tvoj A1 eSIM je spreman.</p></body></html>',
        attachments: [],
      },
      thread: [message],
    })
    if (path === '/api/messages') return json(route, {
      unchanged: false, version: 1, messages: [message],
      counts: { unread: 0, starred: 0, sent: 0, trash: 0 },
      page: { hasMore: false, nextCursor: null, limit: 30 },
    })
    return route.fulfill({ status: 500, body: `Unhandled route: ${path}` })
  })

  await page.goto('/')
  await page.getByText('Welcome to OmniMail').click()
  const reader = page.locator('.message-reader')
  const frame = page.locator('iframe')
  await expect(reader).not.toHaveClass(/message-reader--preparing/)
  await reader.evaluate((element) => {
    element.setAttribute('data-translation-preparing-seen', 'false')
    new MutationObserver(() => {
      if (element.classList.contains('message-reader--preparing')) {
        element.setAttribute('data-translation-preparing-seen', 'true')
      }
    }).observe(element, { attributes: true, attributeFilter: ['class'] })
  })
  const originalSourceDocument = await frame.getAttribute('srcdoc')
  await page.getByRole('button', { name: '翻译为 简体中文' }).click()

  await expect(page.locator('.message-heading h1')).toHaveText('欢迎使用 OmniMail')
  const translatedFrame = page.frameLocator('iframe')
  await expect(translatedFrame.locator('table.translated-layout')).toBeVisible()
  await expect(translatedFrame.locator('strong')).toHaveText('你的 A1 eSIM')
  await expect(translatedFrame.locator('a')).toHaveAttribute(
    'data-omnimail-href',
    'https://example.com/activate',
  )
  await expect(frame).toHaveAttribute('srcdoc', originalSourceDocument ?? '')
  await expect(reader).toHaveAttribute('data-translation-preparing-seen', 'false')
  expect(requestedTarget).toBe('zh')

  await page.getByRole('button', { name: '显示原文' }).click()
  await expect(page.locator('.message-heading h1')).toHaveText('Welcome to OmniMail')
  await expect(page.frameLocator('iframe').locator('.original-copy')).toContainText(
    'Tvoj A1 eSIM je spreman.',
  )
  await expect(frame).toHaveAttribute('srcdoc', originalSourceDocument ?? '')
  await expect(reader).toHaveAttribute('data-translation-preparing-seen', 'false')
})
