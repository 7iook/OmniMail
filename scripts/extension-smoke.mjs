import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

const extensionPath = resolve('dist-extension')
const previewMode = process.argv.includes('--preview')
const profilePath = await mkdtemp(resolve(tmpdir(), 'omnimail-extension-'))
const screenshotPath = resolve('test-results', 'extension-smoke.png')
const dropdownScreenshotPath = resolve('test-results', 'extension-dropdown-open.png')
const darkDropdownScreenshotPath = resolve('test-results', 'extension-dropdown-open-dark.png')
const storeAssetsPath = resolve('extension', 'store-assets')
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
      response.end(`<!doctype html><html><head><title>Acme Account</title><style>
        *{box-sizing:border-box}body{margin:0;font:15px Inter,system-ui;color:#1d1d1f;background:#f4f5f7}
        nav{height:68px;padding:0 54px;display:flex;align-items:center;justify-content:space-between;background:white;border-bottom:1px solid #e5e7eb}
        .brand{font-size:20px;font-weight:750}.nav-links{color:#6b7280;word-spacing:24px}
        main{min-height:732px;display:grid;place-items:center;padding:48px}
        section{width:460px;padding:40px;border:1px solid #e1e4e8;border-radius:18px;background:white;box-shadow:0 20px 60px #11182712}
        h1{margin:0 0 10px;font-size:30px}.copy{margin:0 0 28px;color:#6b7280;line-height:1.6}
        label{display:grid;gap:9px;font-weight:650}input{height:48px;padding:0 14px;border:1px solid #cfd4dc;border-radius:10px;font:inherit}
        .continue{width:100%;height:48px;margin-top:22px;border:0;border-radius:10px;color:white;background:#1d1d1f;font-weight:700}
      </style></head><body><nav><span class="brand">Acme</span><span class="nav-links">产品 定价 帮助</span></nav>
        <main><section><h1>创建你的账户</h1><p class="copy">填写邮箱即可开始使用。OmniMail Float 能帮你快速生成并填入一个新地址。</p>
          <label>邮箱地址<input type="email" placeholder="name@example.com" /></label><button class="continue">继续</button>
        </section></main></body></html>`)
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
      json(response, { domains: [
        'example.com', 'aicnos.com', 'cloudflare.aicnos.com', 'noetie.kdns.fr',
      ].map((name) => ({
        name, isActive: true, mailboxCount: mailboxes.filter((item) => item.domain === name).length,
        createdAt: 1, updatedAt: 1,
      })) })
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
    headless: !previewMode,
    viewport: { width: 1280, height: 800 },
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
  const nodeWithClass = (nodes, className) => nodes.find((node) => {
    const attributes = node.attributes || []
    const classIndex = attributes.indexOf('class')
    return classIndex >= 0 && attributes[classIndex + 1]?.split(/\s+/).includes(className)
  })
  const nodeAttribute = (node, name) => {
    const attributes = node.attributes || []
    const index = attributes.indexOf(name)
    return index >= 0 ? attributes[index + 1] : ''
  }
  const { nodes } = await cdp.send('DOM.getFlattenedDocument', { depth: -1, pierce: true })
  const floatButton = nodeWithClass(nodes, 'omnimail-float-button')
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
  const storedLayout = await serviceWorker.evaluate(() => chrome.storage.local.get('floatLayout'))
  assert.equal(storedLayout.floatLayout, undefined)

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
  const randomMailboxButton = panelFrame.getByRole('button', { name: '随机生成邮箱' })
  await randomMailboxButton.click({ trial: true })
  assert.deepEqual(await randomMailboxButton.evaluate((button) => ({
    background: getComputedStyle(button).backgroundColor,
    disabled: button.disabled,
  })), { background: 'rgb(29, 29, 31)', disabled: false })
  assert.equal(await panelFrame.locator('select').count(), 0)
  const domainCombobox = panelFrame.getByRole('combobox', { name: '邮箱域名' })
  await domainCombobox.click()
  await panelFrame.getByRole('listbox', { name: '邮箱域名' }).waitFor()
  await page.screenshot({ path: dropdownScreenshotPath })
  await panelFrame.getByRole('option', { name: '@example.com' }).click()
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(220)
  await panelFrame.getByRole('combobox', { name: '邮箱域名' }).click()
  await panelFrame.getByRole('listbox', { name: '邮箱域名' }).waitFor()
  await page.screenshot({ path: darkDropdownScreenshotPath })
  await panelFrame.getByRole('option', { name: '@example.com' }).click()
  await page.emulateMedia({ colorScheme: 'light' })
  await domainCombobox.press('ArrowDown')
  await domainCombobox.press('ArrowDown')
  await domainCombobox.press('Enter')
  assert.equal(await domainCombobox.textContent(), '@aicnos.com')
  await domainCombobox.click()
  await panelFrame.getByRole('option', { name: '@example.com' }).click()
  assert.equal(exchangeBody.clientId, serviceWorker.url().split('/')[2])
  assert.match(exchangeBody.codeVerifier, /^[A-Za-z0-9_-]{43}$/)
  await mkdir(storeAssetsPath, { recursive: true })
  await page.screenshot({
    path: resolve(storeAssetsPath, '01-floating-generate.jpg'),
    type: 'jpeg', quality: 94,
  })

  await panelFrame.getByLabel('邮箱前缀 可选').fill('custom-box')
  await panelFrame.getByRole('button', { name: '创建自定义邮箱' }).click()
  await panelFrame.getByText('邮箱已生成').waitFor()
  assert.equal(mailboxes.at(-1).address, 'custom-box@example.com')

  await randomMailboxButton.click()
  await panelFrame.getByText('邮箱已生成').waitFor()
  const generatedAddress = mailboxes.at(-1).address
  assert.match(generatedAddress, /^omni-[a-f0-9]{12}@example\.com$/)
  await panelFrame.getByRole('button', { name: '填入网页' }).click()
  await page.getByLabel('邮箱地址').waitFor()
  assert.equal(await page.getByLabel('邮箱地址').inputValue(), generatedAddress)

  await panelFrame.getByRole('button', { name: '收件' }).click()
  await panelFrame.getByRole('combobox', { name: '筛选邮箱' }).click()
  await panelFrame.getByRole('listbox', { name: '筛选邮箱' }).waitFor()
  await panelFrame.getByRole('option', { name: '全部邮箱' }).click()
  await panelFrame.getByText('Your verification code').waitFor()
  await page.screenshot({
    path: resolve(storeAssetsPath, '02-floating-inbox.jpg'),
    type: 'jpeg', quality: 94,
  })
  await panelFrame.getByText('Your verification code').click()
  await panelFrame.getByRole('heading', { name: 'Your verification code' }).waitFor()
  await panelFrame.frameLocator('iframe[title="邮件正文"]').getByText('123456').waitFor()
  await page.screenshot({
    path: resolve(storeAssetsPath, '03-floating-message.jpg'),
    type: 'jpeg', quality: 94,
  })

  const dockNodes = (await cdp.send('DOM.getFlattenedDocument', { depth: -1, pierce: true })).nodes
  const floatHeader = nodeWithClass(dockNodes, 'omnimail-float-header')
  assert(floatHeader?.nodeId, 'floating panel header was not found')
  const headerBox = await cdp.send('DOM.getBoxModel', { nodeId: floatHeader.nodeId })
  const [headerX1, headerY1, headerX2, , , headerY3] = headerBox.model.content
  const headerX = (headerX1 + headerX2) / 2
  const headerY = (headerY1 + headerY3) / 2
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: headerX, y: headerY, button: 'left', buttons: 1, clickCount: 1,
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: 1277, y: headerY, button: 'left', buttons: 1,
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: 1277, y: headerY, button: 'left', buttons: 0, clickCount: 1,
  })
  await page.waitForTimeout(250)

  const collapsedNodes = (await cdp.send('DOM.getFlattenedDocument', { depth: -1, pierce: true })).nodes
  const collapsedButton = nodeWithClass(collapsedNodes, 'omnimail-float-button')
  const collapsedPanel = nodeWithClass(collapsedNodes, 'omnimail-float-panel')
  assert(collapsedButton?.nodeId && collapsedPanel?.nodeId, 'docked controls were not found')
  assert.match(nodeAttribute(collapsedButton, 'class'), /\bis-docked\b/)
  assert.equal(nodeAttribute(collapsedButton, 'aria-expanded'), 'false')
  assert.doesNotMatch(nodeAttribute(collapsedPanel, 'class'), /\bis-visible\b/)
  const collapsedBox = await cdp.send('DOM.getBoxModel', { nodeId: collapsedButton.nodeId })
  const [dockX1, , dockX2] = collapsedBox.model.border
  assert.equal(Math.round(dockX2 - dockX1), 44)
  assert.equal(Math.round(dockX2), 1280)
  const dockedStorage = await serviceWorker.evaluate(() => chrome.storage.local.get('floatLayout'))
  assert.equal(dockedStorage.floatLayout.docked, true)
  assert(dockedStorage.floatLayout.panel.width >= 360)
  await page.screenshot({ path: resolve('test-results', 'extension-docked.png') })

  await page.reload()
  await page.waitForTimeout(500)
  const restoredNodes = (await cdp.send('DOM.getFlattenedDocument', { depth: -1, pierce: true })).nodes
  const restoredButton = nodeWithClass(restoredNodes, 'omnimail-float-button')
  assert(restoredButton?.nodeId, 'restored docked button was not found')
  assert.match(nodeAttribute(restoredButton, 'class'), /\bis-docked\b/)
  const restoredBox = await cdp.send('DOM.getBoxModel', { nodeId: restoredButton.nodeId })
  const [restoreX1, restoreY1, , , restoreX3, restoreY3] = restoredBox.model.content
  const restoredFramePromise = page.waitForEvent('framenavigated', {
    predicate: (candidate) => candidate !== page.mainFrame() && candidate.url().endsWith('/panel.html'),
    timeout: 10_000,
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: (restoreX1 + restoreX3) / 2, y: (restoreY1 + restoreY3) / 2,
    button: 'left', buttons: 1, clickCount: 1,
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: (restoreX1 + restoreX3) / 2, y: (restoreY1 + restoreY3) / 2,
    button: 'left', buttons: 0, clickCount: 1,
  })
  const restoredFrame = await restoredFramePromise
  await restoredFrame.getByRole('heading', { name: '快速生成邮箱' }).waitFor()
  const expandedNodes = (await cdp.send('DOM.getFlattenedDocument', { depth: -1, pierce: true })).nodes
  assert.match(nodeAttribute(nodeWithClass(expandedNodes, 'omnimail-float-panel'), 'class'), /\bis-visible\b/)
  await page.screenshot({ path: resolve('test-results', 'extension-docked-expanded.png') })
  if (previewMode) {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForTimeout(220)
    await page.bringToFront()
    console.log('OmniMail docked preview is ready. Click the right-edge tab to collapse or expand it.')
    await new Promise(() => {})
  }

  const icon = await readFile(resolve('extension', 'public', 'icons', 'icon128.png'))
  const promoPage = await context.newPage()
  await promoPage.setViewportSize({ width: 440, height: 280 })
  await promoPage.setContent(`<!doctype html><html><head><style>
    *{box-sizing:border-box}body{margin:0;width:440px;height:280px;overflow:hidden;font-family:Inter,system-ui;color:white;background:#17181b}
    main{position:relative;width:100%;height:100%;display:flex;align-items:center;padding:38px;background:radial-gradient(circle at 82% 18%,#3b82f655,transparent 42%)}
    main:after{content:'';position:absolute;right:-45px;bottom:-90px;width:260px;height:260px;border:1px solid #ffffff26;border-radius:50%}
    img{width:82px;height:82px;border-radius:24px;box-shadow:0 18px 45px #0008}
    div{margin-left:24px}h1{margin:0 0 9px;font-size:27px;letter-spacing:-.6px}p{margin:0;color:#cbd0d9;font-size:15px;line-height:1.45}
  </style></head><body><main><img src="data:image/png;base64,${icon.toString('base64')}" alt=""><div><h1>OmniMail Float</h1><p>邮箱随页面而行<br>生成 · 填入 · 收件</p></div></main></body></html>`)
  await promoPage.screenshot({
    path: resolve(storeAssetsPath, 'promo-small-440x280.jpg'),
    type: 'jpeg', quality: 95,
  })
  await promoPage.close()
  await mkdir(resolve('test-results'), { recursive: true })
  await page.screenshot({ path: screenshotPath })
  console.log(`Extension smoke test passed: ${screenshotPath}`)
} finally {
  await context?.close()
  await new Promise((resolveClose) => server.close(resolveClose))
  await rm(profilePath, { recursive: true, force: true })
}
