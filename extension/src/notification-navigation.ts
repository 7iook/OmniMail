export interface NotificationTab {
  id?: number
  windowId?: number
  url?: string
}

export interface NotificationBrowser {
  listTabs(urlPattern: string): Promise<NotificationTab[]>
  activateTab(tabId: number): Promise<void>
  focusWindow(windowId: number): Promise<void>
  createTab(url: string): Promise<void>
  clearNotification(notificationId: string): Promise<void>
}

function inboxTarget(value: unknown): { destination: string; urlPattern: string } | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    const localHttp = url.protocol === 'http:'
      && ['localhost', '127.0.0.1'].includes(url.hostname)
    if (url.protocol !== 'https:' && !localHttp) return null
    if (url.username || url.password) return null
    return {
      destination: new URL('/mail/inbox', url.origin).toString(),
      urlPattern: `${url.protocol}//${url.hostname}/*`,
    }
  } catch {
    return null
  }
}

function isInboxTab(tab: NotificationTab, destination: string): boolean {
  if (!tab.url) return false
  try {
    const current = new URL(tab.url)
    const target = new URL(destination)
    return current.origin === target.origin
      && current.pathname.replace(/\/+$/, '') === target.pathname
  } catch {
    return false
  }
}

export async function handleNotificationClick(
  notificationId: string,
  apiOrigin: unknown,
  browser: NotificationBrowser,
): Promise<void> {
  try {
    const target = inboxTarget(apiOrigin)
    if (!target) return
    const existing = (await browser.listTabs(target.urlPattern))
      .find((tab) => isInboxTab(tab, target.destination))
    if (existing?.id !== undefined) {
      await browser.activateTab(existing.id)
      if (existing.windowId !== undefined) await browser.focusWindow(existing.windowId)
      return
    }
    await browser.createTab(target.destination)
  } finally {
    await browser.clearNotification(notificationId)
  }
}

export async function handleChromeNotificationClick(notificationId: string): Promise<void> {
  let settings: { apiOrigin?: unknown }
  try {
    settings = await chrome.storage.local.get(['apiOrigin'])
  } catch {
    await chrome.notifications.clear(notificationId)
    return
  }
  await handleNotificationClick(notificationId, settings.apiOrigin, {
    listTabs: (urlPattern) => chrome.tabs.query({ url: urlPattern }),
    activateTab: async (tabId) => { await chrome.tabs.update(tabId, { active: true }) },
    focusWindow: async (windowId) => { await chrome.windows.update(windowId, { focused: true }) },
    createTab: async (url) => { await chrome.tabs.create({ url }) },
    clearNotification: async (id) => { await chrome.notifications.clear(id) },
  }).catch(() => {})
}
