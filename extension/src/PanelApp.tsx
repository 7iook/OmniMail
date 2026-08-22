import {
  AlertCircle,
  Check,
  ExternalLink,
  Inbox,
  LoaderCircle,
  LogOut,
  MailPlus,
  Settings,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { OmniLogo } from '../../src/components/OmniLogo'
import type {
  AppConfig,
  ManagedDomain,
  MailboxAddress,
  MessageDetail,
  MessageSummary,
} from '../../src/lib/api-types'
import { useAutoRefresh } from '../../src/lib/useAutoRefresh'
import {
  randomMailboxLocalPart,
  validMailboxLocalPart,
} from '../../src/lib/mailboxAddress'
import { GenerateView } from './PanelGenerate'
import { InboxView } from './PanelInbox'
import type { MailSource } from './PanelMailSourceTabs'
import { PanelScrollbar } from './PanelScrollbar'
import { PanelThemeSettings } from './PanelThemeSettings'
import {
  type AuthStatus,
  type ExtensionSettings,
  type InboxResult,
  type ThemePreference,
  sendExtensionMessage,
} from './protocol'
import { setPanelTheme } from './theme'
import { usePanelICloud } from './usePanelICloud'

type View = 'generate' | 'inbox' | 'settings'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。'
}

export function PanelApp() {
  const mainRef = useRef<HTMLElement>(null)
  const messageRequestId = useRef(0)
  const detailRequestId = useRef(0)
  const [view, setView] = useState<View>(() => location.hash === '#inbox' ? 'inbox' : 'generate')
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [settings, setSettings] = useState<ExtensionSettings>({
    floatingEnabled: true,
    theme: 'system',
  })
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [mailboxes, setMailboxes] = useState<MailboxAddress[]>([])
  const [domains, setDomains] = useState<ManagedDomain[]>([])
  const [messages, setMessages] = useState<MessageSummary[]>([])
  const [selectedMailbox, setSelectedMailbox] = useState('')
  const [selectedMessage, setSelectedMessage] = useState<MessageDetail | null>(null)
  const [domain, setDomain] = useState('')
  const [localPart, setLocalPart] = useState('')
  const [generatedAddress, setGeneratedAddress] = useState('')
  const [generateSource, setGenerateSource] = useState<MailSource>('omnimail')
  const [inboxSource, setInboxSource] = useState<MailSource>('omnimail')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const iCloud = usePanelICloud({
    active: (view === 'generate' && generateSource === 'icloud')
      || (view === 'inbox' && inboxSource === 'icloud'),
    authorized: Boolean(auth?.iCloudAuthorized),
    enabled: Boolean(config?.iCloudEnabled),
    onError: setError,
    onNotice: setNotice,
  })

  const enabledDomains = useMemo(() => domains.filter((item) => item.isActive), [domains])
  const canGenerate = Boolean(auth?.user && (
    ['super_admin', 'admin'].includes(auth.user.role) || auth.user.canCreateMailboxes
  ))
  const currentMailbox = selectedMailbox || mailboxes.find((item) => item.isPrimary)?.address || ''
  const generateAddress = generatedAddress || currentMailbox
  const generateMessages = messages.filter((message) => message.mailboxAddress === generateAddress)

  const loadMessages = useCallback(async (mailbox = selectedMailbox, quiet = false) => {
    const requestId = ++messageRequestId.current
    quiet ? setRefreshing(true) : setLoading(true)
    setError('')
    try {
      const result = await sendExtensionMessage<InboxResult>({
        type: 'api:messages', mailbox: mailbox || undefined,
      })
      if (requestId === messageRequestId.current) setMessages(result.messages)
    } catch (loadError) {
      if (requestId === messageRequestId.current) setError(errorText(loadError))
    } finally {
      if (requestId === messageRequestId.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [selectedMailbox])

  const loadMailboxData = useCallback(async () => {
    const [mailboxResult, domainResult] = await Promise.all([
      sendExtensionMessage<{ mailboxes: MailboxAddress[] }>({ type: 'api:mailboxes' }),
      sendExtensionMessage<{ domains: ManagedDomain[] }>({ type: 'api:domains' }),
    ])
    setMailboxes(mailboxResult.mailboxes)
    setDomains(domainResult.domains)
    setDomain((current) => domainResult.domains.some((item) => item.isActive && item.name === current)
      ? current
      : domainResult.domains.find((item) => item.isActive)?.name || '')
    return mailboxResult.mailboxes
  }, [])

  const loadAuthenticatedData = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [nextConfig, nextMailboxes] = await Promise.all([
        sendExtensionMessage<AppConfig>({ type: 'api:config' }),
        loadMailboxData(),
      ])
      setConfig(nextConfig)
      const saved = await chrome.storage.local.get(['lastMailbox'])
      const savedMailbox = typeof saved.lastMailbox === 'string' ? saved.lastMailbox : ''
      const nextMailbox = nextMailboxes.some((item) => item.address === savedMailbox)
        ? savedMailbox
        : ''
      setSelectedMailbox(nextMailbox)
      await loadMessages(nextMailbox)
    } catch (loadError) {
      setError(errorText(loadError))
    } finally {
      setLoading(false)
    }
  }, [loadMailboxData, loadMessages])

  useEffect(() => {
    let active = true
    Promise.all([
      sendExtensionMessage<AuthStatus>({ type: 'auth:status' }),
      sendExtensionMessage<ExtensionSettings>({ type: 'settings:get' }),
    ]).then(([nextAuth, nextSettings]) => {
      if (!active) return
      setAuth(nextAuth)
      setSettings(nextSettings)
      if (nextAuth.authenticated) void loadAuthenticatedData()
      else setLoading(false)
    }).catch((loadError) => {
      if (active) {
        setError(errorText(loadError))
        setLoading(false)
      }
    })
    return () => { active = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handleAuthStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== 'session' || (!changes.refreshToken && !changes.user)) return
      void sendExtensionMessage<AuthStatus>({ type: 'auth:status' }).then((nextAuth) => {
        setAuth(nextAuth)
        if (nextAuth.authenticated) return
        detailRequestId.current += 1
        messageRequestId.current += 1
        setMailboxes([])
        setDomains([])
        setMessages([])
        setSelectedMessage(null)
        setLoading(false)
      }).catch((authError) => setError(errorText(authError)))
    }
    chrome.storage.onChanged.addListener(handleAuthStorageChange)
    return () => chrome.storage.onChanged.removeListener(handleAuthStorageChange)
  }, [])
  useEffect(() => () => {
    messageRequestId.current += 1
    detailRequestId.current += 1
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 2400)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
  }, [generateSource, inboxSource, view])

  const refreshMailbox = view === 'generate' ? generateAddress : selectedMailbox
  const omniMailVisible = (view === 'generate' && generateSource === 'omnimail')
    || (view === 'inbox' && inboxSource === 'omnimail')
  useAutoRefresh(
    config?.mailRefreshInterval ?? 0,
    () => loadMessages(refreshMailbox, true),
    Boolean(auth?.authenticated && config?.mailRefreshInterval && omniMailVisible),
    false,
  )

  async function login(input: { apiOrigin: string }) {
    setLoading(true)
    setError('')
    try {
      const nextAuth = await sendExtensionMessage<AuthStatus>({ type: 'auth:authorize', ...input })
      setAuth(nextAuth)
      await loadAuthenticatedData()
    } catch (loginError) {
      setError(errorText(loginError))
    } finally {
      setLoading(false)
    }
  }

  async function logout() {
    messageRequestId.current += 1
    detailRequestId.current += 1
    setLoading(true)
    try {
      await sendExtensionMessage({ type: 'auth:logout' })
      setAuth((current) => ({
        apiOrigin: current?.apiOrigin || '',
        authenticated: false,
        iCloudAuthorized: false,
        user: null,
      }))
      setMailboxes([])
      setMessages([])
      setSelectedMessage(null)
    } finally {
      setLoading(false)
    }
  }

  async function generateMailbox() {
    if (!domain || generating) return
    const requestedLocalPart = localPart.trim().toLowerCase()
    if (requestedLocalPart && !validMailboxLocalPart(requestedLocalPart)) {
      setError('邮箱前缀支持字母、数字、点、下划线、加号和连字符，长度为 1–64 个字符。')
      return
    }
    setGenerating(true)
    setError('')
    const maximumAttempts = requestedLocalPart ? 1 : 3
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      try {
        const address = `${requestedLocalPart
          || randomMailboxLocalPart(config?.randomMailboxPrefix || '')}@${domain}`
        const result = await sendExtensionMessage<{ mailbox: MailboxAddress }>({
          type: 'api:create-mailbox', address,
        })
        setLocalPart('')
        setGeneratedAddress(result.mailbox.address)
        await loadMailboxData()
        setSelectedMailbox(result.mailbox.address)
        await chrome.storage.local.set({ lastMailbox: result.mailbox.address })
        await loadMessages(result.mailbox.address, true)
        setNotice('邮箱已生成')
        setGenerating(false)
        return
      } catch (generateError) {
        if (attempt < maximumAttempts - 1 && /已经|属于|占用/.test(errorText(generateError))) continue
        setError(errorText(generateError))
        break
      }
    }
    setGenerating(false)
  }

  async function generateICloudAlias(label: string): Promise<string> {
    const address = await iCloud.createAlias(label)
    if (address) {
      window.requestAnimationFrame(() => {
        const panel = mainRef.current
        panel?.scrollTo({
          top: panel.scrollHeight,
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'auto'
            : 'smooth',
        })
      })
    }
    return address
  }

  function openICloudWeb() {
    if (!auth?.apiOrigin) return
    void chrome.tabs.create({ url: new URL('/icloud', auth.apiOrigin).toString() })
  }

  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address)
      setNotice('邮箱地址已复制')
    } catch {
      setError('无法访问剪贴板，请手动复制。')
    }
  }

  async function fillAddress(address: string) {
    try {
      await sendExtensionMessage({ type: 'page:fill-email', email: address })
      setNotice('已填入当前网页')
    } catch (fillError) {
      setError(errorText(fillError))
    }
  }

  async function changeMailbox(address: string) {
    detailRequestId.current += 1
    setSelectedMailbox(address)
    setGeneratedAddress('')
    setSelectedMessage(null)
    await chrome.storage.local.set({ lastMailbox: address })
    await loadMessages(address)
  }

  async function openMessage(message: MessageSummary) {
    const requestId = ++detailRequestId.current
    setDetailLoading(true)
    setError('')
    try {
      const result = await sendExtensionMessage<{ message: MessageDetail; thread: MessageSummary[] }>({
        type: 'api:message', id: message.id,
      })
      if (requestId !== detailRequestId.current) return
      setSelectedMessage(result.message)
      if (!message.isRead) {
        try {
          await sendExtensionMessage({ type: 'api:mark-read', id: message.id })
          setMessages((items) => items.map((item) => item.id === message.id
            ? { ...item, isRead: true }
            : item))
        } catch (readError) {
          if (requestId === detailRequestId.current) setError(errorText(readError))
        }
      }
    } catch (loadError) {
      if (requestId === detailRequestId.current) setError(errorText(loadError))
    } finally {
      if (requestId === detailRequestId.current) setDetailLoading(false)
    }
  }

  async function toggleFloating(enabled: boolean) {
    setSettings((current) => ({ ...current, floatingEnabled: enabled }))
    try {
      await sendExtensionMessage({ type: 'settings:set-floating', enabled })
      setNotice(enabled ? '已启用网页悬浮按钮' : '已关闭网页悬浮按钮')
    } catch (settingsError) {
      setSettings((current) => ({ ...current, floatingEnabled: !enabled }))
      setError(errorText(settingsError))
    }
  }

  async function changeTheme(theme: ThemePreference) {
    const previous = settings.theme
    setSettings((current) => ({ ...current, theme }))
    setPanelTheme(theme)
    try {
      await sendExtensionMessage({ type: 'settings:set-theme', theme })
      setNotice(theme === 'system'
        ? '主题已设为跟随系统'
        : '已切换为' + (theme === 'light' ? '亮色' : '暗色') + '主题')
    } catch (settingsError) {
      setSettings((current) => ({ ...current, theme: previous }))
      setPanelTheme(previous)
      setError(errorText(settingsError))
    }
  }

  if (!auth?.authenticated) {
    return <div className="panel-content login-scroll-shell">
      <main className="panel-main" ref={mainRef}>
        <LoginView apiOrigin={auth?.apiOrigin || ''} busy={loading} error={error} onLogin={login} />
      </main>
      <PanelScrollbar scrollRef={mainRef} />
    </div>
  }

  return (
    <div className="panel-shell">
      <nav className="panel-nav" aria-label="OmniMail 功能">
        <div className="panel-brand" title={config?.appName || 'OmniMail'}><OmniLogo size={23} /></div>
        <NavButton active={view === 'generate'} icon={<MailPlus />} label="生成" onClick={() => setView('generate')} />
        <NavButton active={view === 'inbox'} icon={<Inbox />} label="收件" onClick={() => setView('inbox')} />
        <NavButton active={view === 'settings'} icon={<Settings />} label="设置" onClick={() => setView('settings')} />
      </nav>

      <div className="panel-content">
        <main className="panel-main" ref={mainRef}>
          {error && <div className="panel-alert" role="alert"><AlertCircle size={15} /><span>{error}</span><button type="button" onClick={() => setError('')}>关闭</button></div>}
          <div className="panel-view" key={view}>
          {view === 'generate' && (
            <GenerateView
              source={generateSource}
              domains={enabledDomains}
              domain={domain}
              localPart={localPart}
              generatedAddress={generatedAddress}
              fallbackAddress={currentMailbox}
              messages={generateMessages}
              canGenerate={canGenerate}
              busy={generating}
              mailLoading={loading}
              refreshing={refreshing}
              refreshInterval={config?.mailRefreshInterval ?? 0}
              randomMailboxPrefix={config?.randomMailboxPrefix || ''}
              iCloudEnabled={config?.iCloudEnabled ?? false}
              iCloudAuthorized={auth.iCloudAuthorized}
              iCloudAccounts={iCloud.accounts}
              iCloudAccountId={iCloud.accountId}
              iCloudAliases={iCloud.aliases}
              iCloudSelectedAlias={iCloud.selectedAlias}
              iCloudBusy={loading}
              iCloudCreating={iCloud.creating}
              iCloudLoadingAccounts={iCloud.loadingAccounts}
              iCloudLoadingAliases={iCloud.loadingAliases}
              onSource={setGenerateSource}
              onDomain={setDomain}
              onLocalPart={setLocalPart}
              onGenerate={generateMailbox}
              onICloudAccount={(accountId) => void iCloud.selectAccount(accountId)}
              onICloudAlias={iCloud.selectAlias}
              onICloudGenerate={generateICloudAlias}
              onICloudOpenWeb={openICloudWeb}
              onICloudReauthorize={() => void login({ apiOrigin: auth.apiOrigin })}
              onICloudRetry={() => void iCloud.loadAccounts()}
              onICloudRetryAliases={() => void iCloud.loadAliases()}
              onCopy={copyAddress}
              onFill={fillAddress}
              onRefresh={() => loadMessages(generateAddress, true)}
              onSelect={(message) => {
                setInboxSource('omnimail')
                setView('inbox')
                void openMessage(message)
              }}
            />
          )}
          {view === 'inbox' && (
            <InboxView
              source={inboxSource}
              messages={messages}
              mailboxes={mailboxes.filter((item) => item.isActive)}
              mailbox={selectedMailbox}
              selected={selectedMessage}
              loading={loading || detailLoading}
              refreshing={refreshing}
              iCloudEnabled={config?.iCloudEnabled ?? false}
              iCloudAuthorized={auth.iCloudAuthorized}
              iCloudAccounts={iCloud.accounts}
              iCloudAccountId={iCloud.accountId}
              iCloudAliases={iCloud.aliases}
              iCloudPreferredAlias={iCloud.selectedAlias}
              iCloudLoadingAccounts={iCloud.loadingAccounts}
              iCloudLoadingAliases={iCloud.loadingAliases}
              onSource={setInboxSource}
              onICloudAccount={(accountId) => void iCloud.selectAccount(accountId)}
              onICloudOpenWeb={openICloudWeb}
              onICloudReauthorize={() => void login({ apiOrigin: auth.apiOrigin })}
              onMailbox={changeMailbox}
              onRefresh={() => loadMessages(selectedMailbox, true)}
              onSelect={openMessage}
              onBack={() => { detailRequestId.current += 1; setSelectedMessage(null) }}
            />
          )}
          {view === 'settings' && (
            <SettingsView
              auth={auth}
              settings={settings}
              onToggleFloating={toggleFloating}
              onTheme={(theme) => void changeTheme(theme)}
              onOpenWeb={() => void chrome.tabs.create({ url: auth.apiOrigin })}
              onLogout={logout}
            />
          )}
          </div>
        </main>
        <PanelScrollbar scrollRef={mainRef} />
      </div>
      {notice && <div className="panel-toast" role="status"><Check size={15} />{notice}</div>}
    </div>
  )
}

function NavButton({ active, icon, label, onClick }: {
  active: boolean; icon: React.ReactNode; label: string; onClick: () => void
}) {
  return (
    <button className={active ? 'is-active' : ''} type="button" aria-current={active ? 'page' : undefined} onClick={onClick}>
      {icon}<span>{label}</span>
    </button>
  )
}

function LoginView({ apiOrigin, busy, error, onLogin }: {
  apiOrigin: string
  busy: boolean
  error: string
  onLogin: (input: { apiOrigin: string }) => void
}) {
  const [site, setSite] = useState(apiOrigin)
  return (
    <section className="login-view">
      <div className="login-logo"><OmniLogo size={30} /></div>
      <p className="eyebrow">OMNIMAIL FLOAT</p>
      <h1>连接你的邮箱</h1>
      <p className="login-copy">前往你的 OmniMail 网站验证身份并确认授权，扩展不会读取密码。</p>
      <form onSubmit={(event) => {
        event.preventDefault()
        onLogin({ apiOrigin: site })
      }}>
        <label htmlFor="omnimail-site">OmniMail 地址</label>
        <input id="omnimail-site" type="url" required placeholder="https://mail.example.com" value={site} onChange={(event) => setSite(event.target.value)} />
        {error && <p className="login-error" role="alert"><AlertCircle size={15} />{error}</p>}
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={17} /> : <ExternalLink size={17} />}
          {busy ? '等待网站授权…' : '前往 OmniMail 授权'}
        </button>
      </form>
      <p className="login-security">授权完成后会安全保存登录，关闭浏览器后仍可自动恢复。</p>
    </section>
  )
}

function SettingsView({ auth, settings, onToggleFloating, onTheme, onOpenWeb, onLogout }: {
  auth: AuthStatus
  settings: ExtensionSettings
  onToggleFloating: (enabled: boolean) => void
  onTheme: (theme: ThemePreference) => void
  onOpenWeb: () => void
  onLogout: () => void
}) {
  return (
    <section className="panel-page settings-page">
      <header className="page-heading"><p className="eyebrow">SETTINGS</p><h1>扩展设置</h1><p>管理外观、悬浮入口和当前 OmniMail 会话。</p></header>
      <div className="page-card setting-row"><div><strong>网页悬浮按钮</strong><span>在普通 HTTP/HTTPS 网页显示入口</span></div><input aria-label="网页悬浮按钮" type="checkbox" checked={settings.floatingEnabled} onChange={(event) => onToggleFloating(event.target.checked)} /></div>
      <PanelThemeSettings value={settings.theme} onChange={onTheme} />
      <div className="page-card account-card"><span>当前账户</span><strong>{auth.user?.displayName}</strong><small>{auth.user?.email}</small><small>{auth.apiOrigin}</small></div>
      <button className="secondary-button" type="button" onClick={onOpenWeb}><ExternalLink size={16} />打开完整网页端</button>
      <button className="danger-button" type="button" onClick={onLogout}><LogOut size={16} />退出扩展登录</button>
    </section>
  )
}
