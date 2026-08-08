import {
  AlertCircle,
  ArrowLeft,
  AtSign,
  Check,
  Copy,
  ExternalLink,
  Inbox,
  LoaderCircle,
  LogOut,
  MailPlus,
  RefreshCw,
  SendToBack,
  Settings,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { OmniLogo } from '../../src/components/OmniLogo'
import type {
  AppConfig,
  ManagedDomain,
  MailboxAddress,
  MessageDetail,
  MessageSummary,
  User,
} from '../../src/lib/api-types'
import { safeEmailDocument } from './email-document'
import {
  type AuthStatus,
  type ExtensionSettings,
  type InboxResult,
  sendExtensionMessage,
} from './protocol'

type View = 'generate' | 'inbox' | 'settings'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。'
}

function randomLocalPart(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return `omni-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  return new Intl.DateTimeFormat('zh-CN', date.toDateString() === today.toDateString()
    ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: 'short', day: 'numeric' }).format(date)
}

function senderName(message: MessageSummary): string {
  return message.senderName || message.senderAddress || '未知发件人'
}

export function PanelApp() {
  const [view, setView] = useState<View>(() => location.hash === '#inbox' ? 'inbox' : 'generate')
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [settings, setSettings] = useState<ExtensionSettings>({ floatingEnabled: true })
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [mailboxes, setMailboxes] = useState<MailboxAddress[]>([])
  const [domains, setDomains] = useState<ManagedDomain[]>([])
  const [messages, setMessages] = useState<MessageSummary[]>([])
  const [selectedMailbox, setSelectedMailbox] = useState('')
  const [selectedMessage, setSelectedMessage] = useState<MessageDetail | null>(null)
  const [domain, setDomain] = useState('')
  const [generatedAddress, setGeneratedAddress] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const enabledDomains = useMemo(() => domains.filter((item) => item.isActive), [domains])
  const canGenerate = Boolean(auth?.user && (
    ['super_admin', 'admin'].includes(auth.user.role) || auth.user.canCreateMailboxes
  ))

  const loadMessages = useCallback(async (mailbox = selectedMailbox, quiet = false) => {
    quiet ? setRefreshing(true) : setLoading(true)
    setError('')
    try {
      const result = await sendExtensionMessage<InboxResult>({
        type: 'api:messages', mailbox: mailbox || undefined,
      })
      setMessages(result.messages)
    } catch (loadError) {
      setError(errorText(loadError))
    } finally {
      setLoading(false)
      setRefreshing(false)
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
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 2400)
    return () => window.clearTimeout(timer)
  }, [notice])

  async function login(input: { apiOrigin: string; email: string; password: string; mfaCode: string }) {
    setLoading(true)
    setError('')
    try {
      const nextAuth = await sendExtensionMessage<AuthStatus>({ type: 'auth:login', ...input })
      setAuth(nextAuth)
      await loadAuthenticatedData()
    } catch (loginError) {
      setError(errorText(loginError))
    } finally {
      setLoading(false)
    }
  }

  async function logout() {
    setLoading(true)
    try {
      await sendExtensionMessage({ type: 'auth:logout' })
      setAuth((current) => ({ apiOrigin: current?.apiOrigin || '', authenticated: false, user: null }))
      setMailboxes([])
      setMessages([])
      setSelectedMessage(null)
    } finally {
      setLoading(false)
    }
  }

  async function generateMailbox() {
    if (!domain || generating) return
    setGenerating(true)
    setError('')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const address = `${randomLocalPart()}@${domain}`
        const result = await sendExtensionMessage<{ mailbox: MailboxAddress }>({
          type: 'api:create-mailbox', address,
        })
        setGeneratedAddress(result.mailbox.address)
        await loadMailboxData()
        setSelectedMailbox(result.mailbox.address)
        await chrome.storage.local.set({ lastMailbox: result.mailbox.address })
        setNotice('邮箱已生成')
        setGenerating(false)
        return
      } catch (generateError) {
        if (attempt < 2 && /已经|属于|占用/.test(errorText(generateError))) continue
        setError(errorText(generateError))
        break
      }
    }
    setGenerating(false)
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
    setSelectedMailbox(address)
    setSelectedMessage(null)
    await chrome.storage.local.set({ lastMailbox: address })
    await loadMessages(address)
  }

  async function openMessage(message: MessageSummary) {
    setDetailLoading(true)
    setError('')
    try {
      const result = await sendExtensionMessage<{ message: MessageDetail; thread: MessageSummary[] }>({
        type: 'api:message', id: message.id,
      })
      setSelectedMessage(result.message)
      if (!message.isRead) {
        void sendExtensionMessage({ type: 'api:mark-read', id: message.id })
        setMessages((items) => items.map((item) => item.id === message.id
          ? { ...item, isRead: true }
          : item))
      }
    } catch (loadError) {
      setError(errorText(loadError))
    } finally {
      setDetailLoading(false)
    }
  }

  async function toggleFloating(enabled: boolean) {
    setSettings({ floatingEnabled: enabled })
    try {
      await sendExtensionMessage({ type: 'settings:set-floating', enabled })
      setNotice(enabled ? '已启用网页悬浮按钮' : '已关闭网页悬浮按钮')
    } catch (settingsError) {
      setSettings({ floatingEnabled: !enabled })
      setError(errorText(settingsError))
    }
  }

  if (!auth?.authenticated) {
    return <LoginView apiOrigin={auth?.apiOrigin || ''} busy={loading} error={error} onLogin={login} />
  }

  return (
    <div className="panel-shell">
      <nav className="panel-nav" aria-label="OmniMail 功能">
        <div className="panel-brand" title={config?.appName || 'OmniMail'}><OmniLogo size={23} /></div>
        <NavButton active={view === 'generate'} icon={<MailPlus />} label="生成" onClick={() => setView('generate')} />
        <NavButton active={view === 'inbox'} icon={<Inbox />} label="收件" onClick={() => setView('inbox')} />
        <NavButton active={view === 'settings'} icon={<Settings />} label="设置" onClick={() => setView('settings')} />
      </nav>

      <main className="panel-main">
        {error && <div className="panel-alert" role="alert"><AlertCircle size={15} /><span>{error}</span><button type="button" onClick={() => setError('')}>关闭</button></div>}
        {view === 'generate' && (
          <GenerateView
            domains={enabledDomains}
            domain={domain}
            generatedAddress={generatedAddress}
            fallbackAddress={selectedMailbox || mailboxes.find((item) => item.isPrimary)?.address || ''}
            canGenerate={canGenerate}
            busy={generating}
            onDomain={setDomain}
            onGenerate={generateMailbox}
            onCopy={copyAddress}
            onFill={fillAddress}
          />
        )}
        {view === 'inbox' && (
          <InboxView
            messages={messages}
            mailboxes={mailboxes.filter((item) => item.isActive)}
            mailbox={selectedMailbox}
            selected={selectedMessage}
            loading={loading || detailLoading}
            refreshing={refreshing}
            onMailbox={changeMailbox}
            onRefresh={() => loadMessages(selectedMailbox, true)}
            onSelect={openMessage}
            onBack={() => setSelectedMessage(null)}
          />
        )}
        {view === 'settings' && (
          <SettingsView
            auth={auth}
            settings={settings}
            onToggleFloating={toggleFloating}
            onOpenWeb={() => void chrome.tabs.create({ url: auth.apiOrigin })}
            onLogout={logout}
          />
        )}
      </main>
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
  onLogin: (input: { apiOrigin: string; email: string; password: string; mfaCode: string }) => void
}) {
  const [site, setSite] = useState(apiOrigin)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  return (
    <main className="login-view">
      <div className="login-logo"><OmniLogo size={30} /></div>
      <p className="eyebrow">OMNIMAIL FLOAT</p>
      <h1>连接你的邮箱</h1>
      <p className="login-copy">登录后即可在其他网页生成邮箱并收取邮件。</p>
      <form onSubmit={(event) => {
        event.preventDefault()
        onLogin({ apiOrigin: site, email, password, mfaCode })
      }}>
        <label htmlFor="omnimail-site">OmniMail 地址</label>
        <input id="omnimail-site" type="url" required placeholder="https://mail.example.com" value={site} onChange={(event) => setSite(event.target.value)} />
        <label htmlFor="omnimail-email">登录邮箱</label>
        <input id="omnimail-email" type="email" required autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} />
        <label htmlFor="omnimail-password">密码</label>
        <input id="omnimail-password" type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
        <label htmlFor="omnimail-mfa">二次验证码 <span>如已启用</span></label>
        <input id="omnimail-mfa" inputMode="numeric" autoComplete="one-time-code" maxLength={12} value={mfaCode} onChange={(event) => setMfaCode(event.target.value)} />
        {error && <p className="login-error" role="alert"><AlertCircle size={15} />{error}</p>}
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={17} /> : <AtSign size={17} />}
          {busy ? '正在连接…' : '连接 OmniMail'}
        </button>
      </form>
      <p className="login-security">令牌仅保存在本次浏览器会话中，网页无法读取。</p>
    </main>
  )
}

function GenerateView({ domains, domain, generatedAddress, fallbackAddress, canGenerate, busy, onDomain, onGenerate, onCopy, onFill }: {
  domains: ManagedDomain[]
  domain: string
  generatedAddress: string
  fallbackAddress: string
  canGenerate: boolean
  busy: boolean
  onDomain: (domain: string) => void
  onGenerate: () => void
  onCopy: (address: string) => void
  onFill: (address: string) => void
}) {
  const address = generatedAddress || fallbackAddress
  return (
    <section className="panel-page">
      <header className="page-heading"><p className="eyebrow">QUICK MAILBOX</p><h1>快速生成邮箱</h1><p>选择域名后，系统会创建一个未占用的随机地址。</p></header>
      <div className="page-card">
        <label htmlFor="mail-domain">邮箱域名</label>
        <select id="mail-domain" value={domain} onChange={(event) => onDomain(event.target.value)} disabled={busy || !canGenerate}>
          {domains.map((item) => <option key={item.name} value={item.name}>@{item.name}</option>)}
        </select>
        <div className="address-preview"><span>生成格式</span><strong>omni-随机字符@{domain || 'domain'}</strong></div>
        <button className="primary-button" type="button" disabled={busy || !domain || !canGenerate} onClick={onGenerate}>
          {busy ? <LoaderCircle className="spin" size={17} /> : <MailPlus size={17} />}
          {busy ? '正在生成…' : '一键生成邮箱'}
        </button>
        {!canGenerate && <p className="permission-note">当前账户没有创建邮箱的权限。</p>}
      </div>
      {address && <div className="page-card address-result"><span>{generatedAddress ? '刚刚生成' : '当前邮箱'}</span><strong>{address}</strong><div><button type="button" onClick={() => onCopy(address)}><Copy size={15} />复制</button><button type="button" onClick={() => onFill(address)}><SendToBack size={15} />填入网页</button></div></div>}
    </section>
  )
}

function InboxView({ messages, mailboxes, mailbox, selected, loading, refreshing, onMailbox, onRefresh, onSelect, onBack }: {
  messages: MessageSummary[]
  mailboxes: MailboxAddress[]
  mailbox: string
  selected: MessageDetail | null
  loading: boolean
  refreshing: boolean
  onMailbox: (address: string) => void
  onRefresh: () => void
  onSelect: (message: MessageSummary) => void
  onBack: () => void
}) {
  if (selected) {
    return (
      <article className="message-reader">
        <button className="back-button" type="button" onClick={onBack}><ArrowLeft size={16} />返回收件箱</button>
        <header><h1>{selected.subject || '（无主题）'}</h1><p>{senderName(selected)} · {formatDate(selected.date)}</p><span>发送至 {selected.mailboxAddress}</span></header>
        <iframe
          title="邮件正文"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          srcDoc={safeEmailDocument(selected.html, selected.text)}
        />
      </article>
    )
  }
  return (
    <section className="inbox-page">
      <header className="inbox-toolbar">
        <div><p className="eyebrow">INBOX</p><h1>收件箱</h1></div>
        <button className="icon-button" type="button" title="刷新邮件" aria-label="刷新邮件" disabled={refreshing} onClick={onRefresh}><RefreshCw className={refreshing ? 'spin' : ''} size={17} /></button>
      </header>
      <label className="mailbox-filter" htmlFor="inbox-mailbox"><span className="sr-only">筛选邮箱</span><select id="inbox-mailbox" value={mailbox} onChange={(event) => onMailbox(event.target.value)}><option value="">全部邮箱</option>{mailboxes.map((item) => <option key={item.address} value={item.address}>{item.address}</option>)}</select></label>
      {loading && !messages.length ? <div className="empty-state"><LoaderCircle className="spin" size={20} />正在读取邮件…</div> : (
        <div className="message-list">
          {messages.map((message) => (
            <button className={!message.isRead ? 'is-unread' : ''} type="button" key={message.id} onClick={() => onSelect(message)}>
              <span className="unread-dot" /><span className="message-copy"><strong>{senderName(message)}</strong><b>{message.subject || '（无主题）'}</b><small>{message.preview || '暂无预览'}</small></span><time>{formatDate(message.date)}</time>
            </button>
          ))}
          {!messages.length && <div className="empty-state"><Inbox size={23} /><strong>还没有邮件</strong><span>新邮件到达后会自动出现在这里。</span></div>}
        </div>
      )}
    </section>
  )
}

function SettingsView({ auth, settings, onToggleFloating, onOpenWeb, onLogout }: {
  auth: AuthStatus
  settings: ExtensionSettings
  onToggleFloating: (enabled: boolean) => void
  onOpenWeb: () => void
  onLogout: () => void
}) {
  return (
    <section className="panel-page settings-page">
      <header className="page-heading"><p className="eyebrow">SETTINGS</p><h1>扩展设置</h1><p>管理悬浮入口和当前 OmniMail 会话。</p></header>
      <div className="page-card setting-row"><div><strong>网页悬浮按钮</strong><span>在普通 HTTP/HTTPS 网页显示入口</span></div><input aria-label="网页悬浮按钮" type="checkbox" checked={settings.floatingEnabled} onChange={(event) => onToggleFloating(event.target.checked)} /></div>
      <div className="page-card account-card"><span>当前账户</span><strong>{auth.user?.displayName}</strong><small>{auth.user?.email}</small><small>{auth.apiOrigin}</small></div>
      <button className="secondary-button" type="button" onClick={onOpenWeb}><ExternalLink size={16} />打开完整网页端</button>
      <button className="danger-button" type="button" onClick={onLogout}><LogOut size={16} />退出扩展登录</button>
    </section>
  )
}
