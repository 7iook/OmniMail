import {
  AlertCircle,
  ArrowLeft,
  Check,
  Eye,
  EyeOff,
  Inbox,
  KeyRound,
  LoaderCircle,
  Mail,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { api, type LinuxDoMailAccount, type LinuxDoMailMessage } from '../lib/api'
import { errorMessage } from '../lib/errorMessage'
import { parseICloudSender } from '../lib/icloudSender'
import { t } from '../lib/i18n'
import { DangerConfirmDialog } from './DangerConfirmDialog'
import { ICloudMessageBody } from './ICloudMessageBody'

function Spinner({ size = 17 }: { size?: number }) {
  return <LoaderCircle className="spin" size={size} aria-hidden="true" />
}

function Empty({ icon, title, description }: {
  icon: ReactNode
  title: string
  description: string
}) {
  return <div className="icloud-empty"><span>{icon}</span><h3>{title}</h3><p>{description}</p></div>
}

function ConnectForm({ saving, error, onConnect }: {
  saving: boolean
  error: string
  onConnect: (username: string, password: string) => Promise<void>
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    await onConnect(username, password)
  }
  return (
    <div className="linuxdo-connect-shell">
      <form className="linuxdo-connect-card" onSubmit={(event) => void submit(event)}>
        <span className="linuxdo-connect-symbol"><Mail size={24} aria-hidden="true" /></span>
        <div className="linuxdo-connect-heading">
          <p className="eyebrow">LINUX DO · IMAP</p>
          <h2>{t('连接 Linux DO 邮箱')}</h2>
          <p>{t('使用完整邮箱地址登录，只读取 INBOX 中最近的邮件。')}</p>
        </div>
        <label htmlFor="linuxdo-mail-username">
          <span>{t('邮箱用户名')}</span>
          <input id="linuxdo-mail-username" type="email" required maxLength={254}
            autoComplete="section-linuxdo username" placeholder="name@linux.do"
            value={username} onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label htmlFor="linuxdo-mail-password">
          <span>{t('密码或认证令牌')}</span>
          <span className="linuxdo-password-field">
            <input id="linuxdo-mail-password" type={showPassword ? 'text' : 'password'} required
              maxLength={512} autoComplete="section-linuxdo current-password"
              aria-describedby="linuxdo-mail-password-help" value={password}
              onChange={(event) => setPassword(event.target.value)} />
            <button type="button" onClick={() => setShowPassword((shown) => !shown)}
              aria-label={t(showPassword ? '隐藏密码' : '显示密码')}>
              {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </span>
        </label>
        <p id="linuxdo-mail-password-help" className="linuxdo-connect-note">
          <ShieldCheck size={15} aria-hidden="true" />
          {t('官方建议在认证令牌页面生成专用令牌；凭据会在 Worker 内加密，保存后不会回传。')}
        </p>
        {error && <p className="inline-error" role="alert"><AlertCircle size={15} />{error}</p>}
        <button className="button button--primary" disabled={saving}>
          {saving ? <Spinner /> : <KeyRound size={16} />}
          {t(saving ? '正在验证…' : '验证并连接')}
        </button>
      </form>
    </div>
  )
}

function MessageReader({ message, loading, remoteImagesEnabled, onBack }: {
  message: LinuxDoMailMessage | null
  loading: boolean
  remoteImagesEnabled: boolean
  onBack: () => void
}) {
  if (loading) {
    return <div className="reader-state reader-state--loading" role="status">
      <Spinner size={23} />{t('正在从 Linux DO Mail 获取邮件…')}
    </div>
  }
  if (!message) {
    return <div className="reader-state reader-state--empty">
      <span className="reader-empty-symbol"><Mail size={29} /></span>
      <h2>{t('选择一封 Linux DO 邮件')}</h2>
    </div>
  }
  const sender = parseICloudSender(message.from)
  const senderLabel = sender.name || sender.address || t('未知发件人')
  return (
    <article className="icloud-reader">
      <header className="reader-toolbar">
        <button className="icon-button mobile-back" type="button" onClick={onBack}
          aria-label={t('返回邮件列表')}><ArrowLeft size={18} /></button>
        <h2 className="reader-toolbar__title">{t('Linux DO 邮件')}</h2>
        <span className="icloud-source-badge is-imap">{t('IMAP 只读')}</span>
      </header>
      <div className="reader-content icloud-reader-content">
        <div className="icloud-reader-heading">
          <h1>{message.subject || t('无主题')}</h1>
          <div className="icloud-reader-sender">
            <span>{senderLabel.slice(0, 1).toUpperCase()}</span>
            <p><strong>{senderLabel}</strong>
              {sender.name && sender.address && <small title={sender.address}>{`<${sender.address}>`}</small>}
              {message.to && <small>{t('收件：{address}', { address: message.to })}</small>}
            </p>
            {message.date && <time>{new Date(message.date).toLocaleString()}</time>}
          </div>
        </div>
        <div className="icloud-reader-body">
          <ICloudMessageBody message={message} remoteImagesEnabled={remoteImagesEnabled} />
        </div>
      </div>
    </article>
  )
}

export function LinuxDoMailWorkspace({ remoteImagesEnabled }: {
  remoteImagesEnabled: boolean
}) {
  const [enabled, setEnabled] = useState(true)
  const [account, setAccount] = useState<LinuxDoMailAccount | null>(null)
  const [messages, setMessages] = useState<LinuxDoMailMessage[]>([])
  const [opened, setOpened] = useState<LinuxDoMailMessage | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [messageLoading, setMessageLoading] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [action, setAction] = useState<'verify' | 'disconnect' | ''>('')
  const [disconnectOpen, setDisconnectOpen] = useState(false)
  const [error, setError] = useState('')
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')
  const inboxController = useRef<AbortController | null>(null)
  const messageController = useRef<AbortController | null>(null)

  const loadAccount = useCallback(async () => {
    try {
      const result = await api.linuxDoMailAccount()
      setEnabled(result.enabled)
      setAccount(result.account)
    } catch (loadError) {
      setError(errorMessage(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadInbox = useCallback(async () => {
    if (!account) return
    inboxController.current?.abort()
    const controller = new AbortController()
    inboxController.current = controller
    setSyncing(true); setError('')
    try {
      const result = await api.linuxDoMailInbox(controller.signal)
      setMessages(result.messages)
    } catch (loadError) {
      if (!controller.signal.aborted) setError(errorMessage(loadError))
    } finally {
      if (!controller.signal.aborted) setSyncing(false)
    }
  }, [account])

  useEffect(() => { void loadAccount() }, [loadAccount])
  useEffect(() => { if (account) void loadInbox() }, [account?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { inboxController.current?.abort(); messageController.current?.abort() }, [])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 3000)
    return () => window.clearTimeout(timer)
  }, [notice])

  async function connect(username: string, password: string) {
    setConnecting(true); setFormError('')
    try {
      const result = await api.connectLinuxDoMail(username, password)
      setAccount(result.account)
      setNotice(t('Linux DO 邮箱已连接'))
    } catch (connectError) {
      setFormError(errorMessage(connectError))
    } finally { setConnecting(false) }
  }

  async function verify() {
    setAction('verify'); setError('')
    try {
      await api.verifyLinuxDoMail()
      await loadAccount()
      setNotice(t('账号验证成功'))
    } catch (verifyError) {
      setError(errorMessage(verifyError))
      await loadAccount()
    } finally { setAction('') }
  }

  async function disconnect() {
    setAction('disconnect'); setError('')
    try {
      await api.disconnectLinuxDoMail()
      setAccount(null); setMessages([]); setOpened(null); setDisconnectOpen(false)
      setNotice(t('Linux DO 邮箱已断开'))
    } catch (disconnectError) {
      setError(errorMessage(disconnectError))
    } finally { setAction('') }
  }

  async function openMessage(message: LinuxDoMailMessage) {
    messageController.current?.abort()
    const controller = new AbortController()
    messageController.current = controller
    setOpened(message); setMessageLoading(true); setError('')
    try {
      const result = await api.linuxDoMailMessage(message.id, controller.signal)
      if (!controller.signal.aborted) setOpened(result.message)
    } catch (openError) {
      if (!controller.signal.aborted) setError(errorMessage(openError))
    } finally {
      if (!controller.signal.aborted) setMessageLoading(false)
    }
  }

  const closeMessage = () => {
    messageController.current?.abort(); setOpened(null); setMessageLoading(false)
  }

  return (
    <div className={`icloud-mail-view linuxdo-mail-view${opened ? ' has-selection' : ''}`}>
      <section className="list-pane icloud-list-pane page-content-enter">
        <header className="list-header icloud-list-header">
          <div><p className="eyebrow">LINUX DO · MAIL</p><h1>Linux DO</h1></div>
          {account && <div className="list-header__actions">
            <span className={`linuxdo-status is-${account.status}`}>
              {account.status === 'active' ? <ShieldCheck size={13} /> : <AlertCircle size={13} />}
              {t(account.status === 'active' ? '已连接' : '需要验证')}
            </span>
            <div className="icloud-header-action-buttons">
              <button className="icon-button" type="button" disabled={Boolean(action)}
                onClick={() => void verify()} aria-label={t('验证账号')} data-tooltip={t('验证账号')}>
                {action === 'verify' ? <Spinner /> : <ShieldCheck size={17} />}
              </button>
              <button className="icon-button" type="button" disabled={syncing}
                onClick={() => void loadInbox()} aria-label={t('刷新收件箱')} data-tooltip={t('刷新收件箱')}>
                {syncing ? <Spinner /> : <RefreshCw size={17} />}
              </button>
              <button className="icon-button linuxdo-disconnect" type="button"
                onClick={() => setDisconnectOpen(true)} aria-label={t('断开账号')} data-tooltip={t('断开账号')}>
                <Unplug size={17} />
              </button>
            </div>
          </div>}
        </header>

        {error && <p className="list-error" role="alert"><AlertCircle size={15} />{error}</p>}
        {loading ? <div className="icloud-loading"><Spinner size={22} />{t('正在读取 Linux DO Mail 配置…')}</div>
          : !enabled ? <Empty icon={<KeyRound size={24} />} title={t('Linux DO Mail 功能尚未启用')}
            description={t('在 Worker Variables & Secrets 中配置至少 32 字节的 LINUX_DO_MAIL_CREDENTIALS_KEY，然后重新部署。')} />
          : !account ? <ConnectForm saving={connecting} error={formError} onConnect={connect} />
          : syncing && !messages.length ? <div className="icloud-loading"><Spinner />{t('正在读取收件箱…')}</div>
          : messages.length ? <div className="message-list-shell"><div className="message-list" role="listbox" aria-label={t('Linux DO 邮件列表')}>
            {messages.map((message) => {
              const active = opened?.id === message.id
              const sender = parseICloudSender(message.from)
              return <article className={`message-row${message.isRead === false ? ' is-unread' : ''}${active ? ' is-selected' : ''}`}
                role="option" aria-selected={active} key={message.id}>
                <button className="message-row__main" type="button" onClick={() => void openMessage(message)}>
                  <span className="message-row__top"><strong>{sender.name || sender.address || t('未知发件人')}</strong>
                    <time>{message.date ? new Date(message.date).toLocaleDateString() : ''}</time></span>
                  <span className="message-row__subject"><span className="message-row__subject-text">{message.subject || t('无主题')}</span></span>
                  <span className="message-row__preview">{message.preview || t('暂无正文预览')}</span>
                </button>
                {message.isRead === false && <span className="message-row__unread-dot" aria-hidden="true" />}
              </article>
            })}
          </div></div> : <Empty icon={<Inbox size={24} />} title={t('暂无 Linux DO 邮件')}
            description={t('INBOX 中暂时没有邮件，或账号凭据需要重新验证。')} />}
      </section>

      <main className="reader-pane icloud-reader-pane">
        <MessageReader message={opened} loading={messageLoading}
          remoteImagesEnabled={remoteImagesEnabled} onBack={closeMessage} />
      </main>

      {disconnectOpen && account && <DangerConfirmDialog icon={Unplug}
        eyebrow="LINUX DO MAIL" title={t('断开 Linux DO 邮箱？')}
        description={t('账号 {username} 将从 OmniMail 中移除。', { username: account.username })}
        impactTitle={t('已保存的密文会被删除')}
        impactDescription={t('Linux DO 邮箱本身和服务器上的邮件不会受到影响。')}
        confirmLabel={t(action === 'disconnect' ? '正在断开…' : '断开账号')}
        busy={action === 'disconnect'} onCancel={() => setDisconnectOpen(false)}
        onConfirm={() => void disconnect()} />}
      {notice && <div className="toast" role="status"><Check size={16} />{notice}</div>}
    </div>
  )
}
