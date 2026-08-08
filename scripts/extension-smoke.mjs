import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

const extensionPath = resolve('dist-extension')
const profilePath = await mkdtemp(resolve(tmpdir(), 'omnimail-extension-'))
const screenshotPath = resolve('test-results', 'extension-smoke.png')
const user = {
  id: 'user-1', email: 'owner@example.com', displayName: 'Owner', role: 'super_admin',
  mailboxLimit: 20, storageQuotaBytes: 1024, storageUsedBytes: 0,
  canCreateMailboxes: true, canReply: true, canTranslate: true, temporaryExpiresAt: null,
}
const mailboxes = [{
  address: 'inbox@example.com', domain: 'example.com', isPrimary: true, isActive: true,
}]
const message = {
  id: 'message-1', mailboxAddress: 'inbox@example.com', direction: 'incoming',
  status: 'ready', folder: 'inbox', senderName: 'OmniMail Test',
  senderAddress: 'sender@example.net', recipients: ['inbox@example.com'],
  subject: 'Your verification code', preview: 'Code 123456', date: Date.now(),
  attachmentCount: 0, isRead: false, isStarred: false, processingError: null,
  deliveryStatus: null, purgeAfter: null,
}
let exchangeBody = null

async function requestBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString() || '{}')
}

function json(response, body, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><head><title>Extension Smoke</title></head>
        <body style="font:16px system-ui;padding:40px;background:#f7f7f8">
          <h1>Registration form</h1><label>Email <input type="email" /></label>
        </body></html>`)
      return
    }
    if (url.pathname === '/extension/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri') || ''
      const state = url.searchParams.get('state') || ''
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><head><title>Authorize OmniMail Float</title></head>
        <body style="font:16px system-ui;padding:40px;background:#f7f7f8">
          <main><h1>授权浏览器扩展</h1><p>OmniMail Float 希望连接你的账户。</p>
          <button id="allow" style="padding:12px 20px">允许访问</button></main>
          <script>document.querySelector('#allow').onclick = () => {
            location.assign(${JSON.stringify(`${redirectUri}?code=om_ac_${'a'.repeat(43)}&state=${state}`)})
          }</script>
        </body></html>`)
      return
    }
    if (url.pathname === '/api/auth/extension/exchange') {
      exchangeBody = await requestBody(request)
      json(response, {
        accessToken: 'om_at_smoke_access_token_1234567890', expiresIn: 900,
        refreshToken: 'om_rt_smoke_refresh_token_1234567890', refreshExpiresIn: 2592000,
        user,
      })
      return
    }
    if (url.pathname === '/api/auth/token/refresh') {
      json(response, {
        accessToken: 'om_at_refreshed_access_token_123456', expiresIn: 900,
        refreshToken: 'om_rt_refreshed_refresh_token_123456', refreshExpiresIn: 2592000,
        user,
      })
      return
    }
    if (url.pathname === '/api/auth/token/revoke') {
      json(response, { ok: true })
      return
    }
    if (url.pathname === '/api/config') {
      json(response, { appName: 'OmniMail', mailRefreshInterval: 30 })
      return
    }
    if (url.pathname === '/api/domains') {
      json(response, { domains: [{
        name: 'example.com', isActive: true, mailboxCount: mailboxes.length,
        createdAt: 1, updatedAt: 1,
      }] })
      return
    }
    if (url.pathname === '/api/mailboxes' && request.method === 'GET') {
      json(response, { mailboxes })
      return
    }
    if (url.pathname === '/api/mailboxes' && request.method === 'POST') {
      const body = await requestBody(request)
      const mailbox = {
        address: body.address, domain: body.address.split('@')[1],
        isPrimary: false, isActive: true,
      }
      mailboxes.push(mailbox)
      json(response, { mailbox }, 201)
      return
    }
    if (url.pathname === '/api/messages') {
      json(response, {
        unchanged: false, version: 1, messages: [message],
        counts: { unread: 1, starred: 0, drafts: 0, sent: 0, trash: 0 },
        page: { hasMore: false, nextCursor: null, limit: 30 },
      })
      return
    }
    if (url.pathname === '/api/messages/message-1' && request.method === 'GET') {
      json(response, {
        message: {
          ...message, messageId: '<message-1@example.net>', inReplyTo: null,
          references: null, cc: [], text: 'Your code is 123456.',
          html: '<p>Your code is <strong>123456</strong>.</p>', attachments: [],
        },
        thread: [message],
      })
      return
    }
    if (url.pathname === '/api/messages/message-1' && request.method === 'PATCH') {
      json(response, { ok: true })
      return
    }
    json(response, { error: 'Not found' }, 404)
  } catch (error) {
    json(response, { error: error instanceof Error ? error.message : 'Server error' }, 500)
  }
})

await new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen)
  server.listen(0, '127.0.0.1', resolveListen)
})

const address = server.address()
assert(address && typeof address === 'object')
let context
try {
  context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  })
  const serviceWorker = context.serviceWorkers()[0]
    || await context.waitForEvent('serviceworker', { timeout: 10_000 })
  assert.match(serviceWorker.url(), /^chrome-extension:\/\/[a-p]{32}\/background\.js$/)

  const page = await context.newPage()
  await page.goto(`http://localhost:${address.port}`)
  await page.waitForTimeout(500)
  const cdp = await context.newCDPSession(page)
  await cdp.send('DOM.enable')
  const { nodes } = await cdp.send('DOM.getFlattenedDocument', { depth: -1, pierce: true })
  const floatButton = nodes.find((node) => {
    const attributes = node.attributes || []
    const classIndex = attributes.indexOf('class')
    return node.nodeName === 'BUTTON'
      && classIndex >= 0
      && attributes[classIndex + 1]?.split(/\s+/).includes('omnimail-float-button')
  })
  assert(floatButton?.nodeId, 'floating button was not injected')

  const box = await cdp.send('DOM.getBoxModel', { nodeId: floatButton.nodeId })
  const [x1, y1, , , x3, y3] = box.model.content
  const x = (x1 + x3) / 2
  const y = (y1 + y3) / 2
  const panelFramePromise = page.waitForEvent('framenavigated', {
    predicate: (frame) => frame !== page.mainFrame() && frame.url().endsWith('/panel.html'),
    timeout: 10_000,
  })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })

  const panelFrame = await panelFramePromise
  await panelFrame.getByRole('heading', { name: '连接你的邮箱' }).waitFor()
  const loginButton = panelFrame.getByRole('button', { name: '前往 OmniMail 授权' })
  await loginButton.click({ trial: true })
  await page.mouse.move(20, 20)
  await page.waitForTimeout(220)
  const buttonState = await loginButton.evaluate((button) => ({
    disabled: button.disabled,
    background: getComputedStyle(button).backgroundColor,
  }))
  assert.deepEqual(buttonState, {
    disabled: false,
    background: 'rgb(29, 29, 31)',
  })

  const apiOrigin = `http://127.0.0.1:${address.port}`
  await panelFrame.getByLabel('OmniMail 地址').fill(apiOrigin)
  const authorizationPagePromise = context.waitForEvent('page', {
    predicate: (candidate) => candidate.url().includes('/extension/authorize'),
    timeout: 10_000,
  })
  await loginButton.click()
  const authorizationPage = await authorizationPagePromise
  await authorizationPage.getByRole('heading', { name: '授权浏览器扩展' }).waitFor()
  await authorizationPage.getByRole('button', { name: '允许访问' }).click()
  await panelFrame.getByRole('heading', { name: '快速生成邮箱' }).waitFor()
  assert.equal(exchangeBody.clientId, serviceWorker.url().split('/')[2])
  assert.match(exchangeBody.codeVerifier, /^[A-Za-z0-9_-]{43}$/)

  await panelFrame.getByRole('button', { name: '一键生成邮箱' }).click()
  await panelFrame.getByText('邮箱已生成').waitFor()
  const generatedAddress = mailboxes.at(-1).address
  assert.match(generatedAddress, /^omni-[a-f0-9]{12}@example\.com$/)
  await panelFrame.getByRole('button', { name: '填入网页' }).click()
  await page.getByLabel('Email').waitFor()
  assert.equal(await page.getByLabel('Email').inputValue(), generatedAddress)

  await panelFrame.getByRole('button', { name: '收件' }).click()
  await panelFrame.getByText('Your verification code').waitFor()
  await panelFrame.getByText('Your verification code').click()
  await panelFrame.getByRole('heading', { name: 'Your verification code' }).waitFor()
  await panelFrame.frameLocator('iframe[title="邮件正文"]').getByText('123456').waitFor()
  await mkdir(resolve('test-results'), { recursive: true })
  await page.screenshot({ path: screenshotPath })
  console.log(`Extension smoke test passed: ${screenshotPath}`)
} finally {
  await context?.close()
  await new Promise((resolveClose) => server.close(resolveClose))
  await rm(profilePath, { recursive: true, force: true })
}
