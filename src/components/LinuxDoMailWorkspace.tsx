import {
  AlertCircle,
  ArrowLeft,
  Check,
  CircleAlert,
  CircleCheck,
  Clock3,
  Eye,
  EyeOff,
  Inbox,
  KeyRound,
  LoaderCircle,
  Mail,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  SquarePen,
  Unplug,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { api, type LinuxDoMailAccount, type LinuxDoMailMessage } from '../lib/api'
import { errorMessage } from '../lib/errorMessage'
import { parseICloudSender } from '../lib/icloudSender'
import { t } from '../lib/i18n'
import { DangerConfirmDialog } from './DangerConfirmDialog'
import { ICloudMessageBody } from './ICloudMessageBody'
import { LinuxDoMailAccountDialog } from './LinuxDoMailAccountDialog'
import {
  LinuxDoMailComposeDialog,
  type LinuxDoMailComposeInput,
} from './LinuxDoMailComposeDialog'
import { LinuxDoMailSearchField } from './LinuxDoMailSearchField'

function Spinner({ size = 17 }: { size?: number }) {
  return <LoaderCircle className="spin" size={size} aria-hidden="true" />
}

function DeliveryStatus({ message }: { message: LinuxDoMailMessage }) {
  const status = message.status || 'processing'
  const Icon = status === 'sent' ? CircleCheck : status === 'failed' ? CircleAlert : Clock3
  const label = status === 'sent' ? '已发送' : status === 'failed' ? '发送失败' : '排队中'
  return <span className={`linuxdo-delivery-status is-${status}`}>
    <Icon size={12} aria-hidden="true" />{t(label)}
  </span>
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
      <div className="linuxdo-connect-panel">
        <section className="linuxdo-connect-intro" aria-labelledby="linuxdo-connect-intro-title">
          <span className="linuxdo-connect-brand"><Mail size={22} aria-hidden="true" /></span>
          <p className="eyebrow">LINUX DO · MAIL</p>
          <h2 id="linuxdo-connect-intro-title">{t('专注处理每一封 Linux DO 邮件')}</h2>
          <p>{t('连接后即可在 OmniMail 中收件、搜索，并通过官方 SMTP 安全发信。')}</p>
          <div className="linuxdo-connect-features">
            <span><Inbox size={17} aria-hidden="true" /><span>
              <strong>{t('服务器端收件')}</strong>
              <small>{t('直接读取 INBOX，不搬移服务器邮件。')}</small>
            </span></span>
            <span><Search size={17} aria-hidden="true" /><span>
              <strong>{t('完整邮件搜索')}</strong>
              <small>{t('搜索主题、联系人和正文。')}</small>
            </span></span>
            <span><Send size={17} aria-hidden="true" /><span>
              <strong>{t('官方 SMTP 发信')}</strong>
              <small>{t('始终使用已验证的 Linux DO 地址发送。')}</small>
            </span></span>
          </div>
        </section>

        <form className="linuxdo-connect-card" onSubmit={(event) => void submit(event)}>
          <div className="linuxdo-connect-heading">
            <span className="linuxdo-connect-symbol"><KeyRound size={20} aria-hidden="true" /></span>
            <span><p className="eyebrow">LINUX DO · IMAP</p>
              <h2>{t('连接 Linux DO 邮箱')}</h2></span>
          </div>
          <p className="linuxdo-connect-description">
            {t('使用完整的 @linux.do 地址和密码或认证令牌。')}
          </p>
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
            {t('建议使用可撤销的专用认证令牌；凭据只会加密保存在 Worker 中。')}
          </p>
          {error && <p className="inline-error" role="alert"><AlertCircle size={15} />{error}</p>}
          <button className="button button--primary" disabled={saving}>
            {saving ? <Spinner /> : <KeyRound size={16} />}
            {t(saving ? '正在验证…' : '验证并连接')}
          </button>
        </form>
      </div>
    </div>
  )
}

function MessageReader({ message, folder, loading, remoteImagesEnabled, onBack }: {
  message: LinuxDoMailMessage | null
  folder: 'inbox' | 'sent'
  loading: boolean
  remoteImagesEnabled: boolean
  onBack: () => void
}) {
  const outgoing = folder === 'sent' || message?.direction === 'outgoing'
  if (loading) {
    return <div className="reader-state reader-state--loading" role="status">
      <Spinner size={23} />{t(outgoing ? '正在读取已发送邮件…' : '正在从 Linux DO Mail 获取邮件…')}
    </div>
  }
  if (!message) {
    return <div className="reader-state reader-state--empty">
      <span className="reader-empty-symbol">{outgoing ? <Send size={29} /> : <Mail size={29} />}</span>
      <h2>{t(outgoing ? '选择一封已发送邮件' : '选择一封 Linux DO 邮件')}</h2>
    </div>
  }
  const sender = parseICloudSender(message.from)
  const senderLabel = outgoing
    ? message.to || t('未知收件人')
    : sender.name || sender.address || t('未知发件人')
  return (
    <article className="icloud-reader">
      <header className="reader-toolbar">
        <button className="icon-button mobile-back" type="button" onClick={onBack}
          aria-label={t('返回邮件列表')}><ArrowLeft size={18} /></button>
        <h2 className="reader-toolbar__title">{t(outgoing ? '已发送邮件' : 'Linux DO 邮件')}</h2>
        {outgoing ? <DeliveryStatus message={message} />
          : <span className="icloud-source-badge is-imap">{t('IMAP 只读')}</span>}
      </header>
      <div className="reader-content icloud-reader-content">
        <div className="icloud-reader-heading">
          <h1>{message.subject || t('无主题')}</h1>
          <div className="icloud-reader-sender">
            <span>{senderLabel.slice(0, 1).toUpperCase()}</span>
            <p><strong>{senderLabel}</strong>
              {!outgoing && sender.name && sender.address
                && <small title={sender.address}>{`<${sender.address}>`}</small>}
              {outgoing
                ? <small>{t('发件：{address}', { address: message.from })}</small>
                : message.to && <small>{t('收件：{address}', { address: message.to })}</small>}
            </p>
            {message.date && <time>{new Date(message.date).toLocaleString()}</time>}
          </div>
        </div>
        {outgoing && message.status === 'failed' && message.processingError
          && <p className="linuxdo-sent-error" role="status">
            <CircleAlert size={16} aria-hidden="true" />
            <span><strong>{t('发送失败')}</strong><small>{message.processingError}</small></span>
          </p>}
        <div className="icloud-reader-body">
          <ICloudMessageBody message={message} remoteImagesEnabled={remoteImagesEnabled} />
        </div>
      </div>
    </article>
  )
}

export function LinuxDoMailWorkspace({ remoteImagesEnabled, canSend }: {
  remoteImagesEnabled: boolean
  canSend: boolean
}) {
  const [enabled, setEnabled] = useState(true)
  const [account, setAccount] = useState<LinuxDoMailAccount | null>(null)
  const [folder, setFolder] = useState<'inbox' | 'sent'>('inbox')
  const [searchInput, setSearchInput] = useState('')
  const [query, setQuery] = useState('')
  const [messages, setMessages] = useState<LinuxDoMailMessage[]>([])
  const [opened, setOpened] = useState<LinuxDoMailMessage | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [messageLoading, setMessageLoading] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [action, setAction] = useState<'verify' | 'update' | 'send' | 'disconnect' | ''>('')
  const [composeOpen, setComposeOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [disconnectOpen, setDisconnectOpen] = useState(false)
  const [error, setError] = useState('')
  const [formError, setFormError] = useState('')
  const [accountError, setAccountError] = useState('')
  const [composeError, setComposeError] = useState('')
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

  const loadMessages = useCallback(async () => {
    if (!account) return
    inboxController.current?.abort()
    const controller = new AbortController()
    inboxController.current = controller
    setSyncing(true); setError('')
    try {
      const result = folder === 'sent'
        ? await api.linuxDoMailSent(query, controller.signal)
        : await api.linuxDoMailInbox(query, controller.signal)
      setMessages(result.messages)
    } catch (loadError) {
      if (!controller.signal.aborted) setError(errorMessage(loadError))
    } finally {
      if (!controller.signal.aborted) setSyncing(false)
    }
  }, [account, folder, query])

  useEffect(() => { void loadAccount() }, [loadAccount])
  useEffect(() => { if (account) void loadMessages() }, [account?.id, folder, query]) // eslint-disable-line react-hooks/exhaustive-deps
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
    setAction('verify'); setAccountError('')
    try {
      await api.verifyLinuxDoMail()
      await loadAccount()
      setNotice(t('账号验证成功'))
    } catch (verifyError) {
      setAccountError(errorMessage(verifyError))
      await loadAccount()
    } finally { setAction('') }
  }

  async function disconnect() {
    setAction('disconnect'); setError('')
    try {
      await api.disconnectLinuxDoMail()
      setAccount(null); setFolder('inbox'); setSearchInput(''); setQuery('')
      setMessages([]); setOpened(null); setDisconnectOpen(false)
      setNotice(t('Linux DO 邮箱已断开'))
    } catch (disconnectError) {
      setError(errorMessage(disconnectError))
    } finally { setAction('') }
  }

  async function updateCredential(password: string) {
    setAction('update'); setAccountError('')
    try {
      const result = await api.updateLinuxDoMailCredential(password)
      setAccount(result.account); setAccountOpen(false)
      setNotice(t('认证令牌已更新'))
    } catch (updateError) {
      setAccountError(errorMessage(updateError))
    } finally { setAction('') }
  }

  async function sendMessage(input: LinuxDoMailComposeInput) {
    setAction('send'); setComposeError('')
    try {
      await api.sendLinuxDoMail(input)
      setComposeOpen(false)
      setNotice(t('邮件已加入发送队列'))
      if (folder === 'sent') await loadMessages()
    } catch (sendError) {
      setComposeError(errorMessage(sendError))
    } finally { setAction('') }
  }

  async function openMessage(message: LinuxDoMailMessage) {
    messageController.current?.abort()
    const controller = new AbortController()
    messageController.current = controller
    setOpened(message); setMessageLoading(true); setError('')
    try {
      const result = message.direction === 'outgoing'
        ? await api.linuxDoMailSentMessage(message.id, controller.signal)
        : await api.linuxDoMailMessage(message.id, controller.signal)
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

  function selectFolder(nextFolder: 'inbox' | 'sent') {
    if (nextFolder === folder) return
    closeMessage()
    inboxController.current?.abort()
    setMessages([])
    setError('')
    setFolder(nextFolder)
  }

  function submitSearch() {
    const nextQuery = searchInput.trim()
    if (!nextQuery) return
    closeMessage()
    inboxController.current?.abort()
    setMessages([])
    setError('')
    if (nextQuery === query) void loadMessages()
    else setQuery(nextQuery)
  }

  function clearSearch() {
    closeMessage()
    inboxController.current?.abort()
    setSearchInput('')
    setMessages([])
    setError('')
    if (query) setQuery('')
    else void loadMessages()
  }

  return (
    <div className={`icloud-mail-view linuxdo-mail-view${!account ? ' is-onboarding' : ''}${opened ? ' has-selection' : ''}`}>
      <section className="list-pane icloud-list-pane page-content-enter">
        <header className="list-header icloud-list-header">
          <div><p className="eyebrow">LINUX DO · MAIL</p><h1>Linux DO</h1></div>
          {account && <div className="list-header__actions">
            <span className={`linuxdo-status is-${account.status}`}>
              {account.status === 'active' ? <ShieldCheck size={13} /> : <AlertCircle size={13} />}
              {t(account.status === 'active' ? '已连接' : '需要验证')}
            </span>
            <div className="icloud-header-action-buttons">
              <button className="button button--primary compose-trigger" type="button"
                disabled={Boolean(action) || !canSend}
                onClick={() => { setComposeError(''); setComposeOpen(true) }}
                aria-label={t('新建 Linux DO 邮件')}
                data-tooltip={t(canSend ? '新建 Linux DO 邮件' : '当前账户没有发信权限。')}>
                <SquarePen size={17} />
              </button>
              <button className="icon-button" type="button" disabled={Boolean(action)}
                onClick={() => { setAccountError(''); setAccountOpen(true) }}
                aria-label={t('管理 Linux DO 账号')} data-tooltip={t('管理 Linux DO 账号')}>
                <Settings2 size={17} />
              </button>
              <button className="icon-button" type="button" disabled={syncing}
                onClick={() => void loadMessages()}
                aria-label={t(folder === 'sent' ? '刷新已发送' : '刷新收件箱')}
                data-tooltip={t(folder === 'sent' ? '刷新已发送' : '刷新收件箱')}>
                {syncing ? <Spinner /> : <RefreshCw size={17} />}
              </button>
            </div>
          </div>}
        </header>

        {account && <div className="linuxdo-folder-switch" role="group" aria-label={t('邮箱文件夹')}>
          <button type="button" className={folder === 'inbox' ? 'is-active' : ''}
            aria-pressed={folder === 'inbox'} onClick={() => selectFolder('inbox')}>
            <Inbox size={15} aria-hidden="true" /><span>{t('收件箱')}</span>
          </button>
          <button type="button" className={folder === 'sent' ? 'is-active' : ''}
            aria-pressed={folder === 'sent'} onClick={() => selectFolder('sent')}>
            <Send size={15} aria-hidden="true" /><span>{t('已发送')}</span>
          </button>
        </div>}

        {account && <LinuxDoMailSearchField value={searchInput} folder={folder} loading={syncing}
          onChange={setSearchInput} onSubmit={submitSearch} onClear={clearSearch} />}

        {error && <p className="list-error" role="alert"><AlertCircle size={15} />{error}</p>}
        {loading ? <div className="icloud-loading"><Spinner size={22} />{t('正在读取 Linux DO Mail 配置…')}</div>
          : !enabled ? <Empty icon={<KeyRound size={24} />} title={t('Linux DO Mail 功能尚未启用')}
            description={t('在 Worker Variables & Secrets 中配置至少 32 字节的 LINUX_DO_MAIL_CREDENTIALS_KEY，然后重新部署。')} />
          : !account ? <ConnectForm saving={connecting} error={formError} onConnect={connect} />
          : syncing && !messages.length ? <div className="icloud-loading"><Spinner />
            {t(query ? '正在搜索邮件…'
              : folder === 'sent' ? '正在读取已发送邮件…' : '正在读取收件箱…')}</div>
          : messages.length ? <div className="message-list-shell"><div className="message-list" role="listbox"
            aria-label={t(folder === 'sent' ? 'Linux DO 已发送邮件列表' : 'Linux DO 邮件列表')}>
            {messages.map((message) => {
              const active = opened?.id === message.id
              const sender = parseICloudSender(message.from)
              const outgoing = message.direction === 'outgoing'
              return <article className={`message-row${message.isRead === false ? ' is-unread' : ''}${active ? ' is-selected' : ''}`}
                role="option" aria-selected={active} key={message.id}>
                <button className="message-row__main" type="button" onClick={() => void openMessage(message)}>
                  <span className="message-row__top"><strong>{outgoing
                    ? message.to || t('未知收件人')
                    : sender.name || sender.address || t('未知发件人')}</strong>
                    <time>{message.date ? new Date(message.date).toLocaleDateString() : ''}</time></span>
                  <span className="message-row__subject">
                    <span className="message-row__subject-text">{message.subject || t('无主题')}</span>
                    {outgoing && <DeliveryStatus message={message} />}
                  </span>
                  <span className="message-row__preview">{message.preview || t('暂无正文预览')}</span>
                </button>
                {message.isRead === false && <span className="message-row__unread-dot" aria-hidden="true" />}
              </article>
            })}
          </div></div> : query
            ? <Empty icon={<Search size={24} />} title={t('未找到相关邮件')}
              description={t('请尝试更换关键词，或清除搜索查看最近邮件。')} />
            : folder === 'sent'
            ? <Empty icon={<Send size={24} />} title={t('暂无已发送邮件')}
              description={t('通过 Linux DO 写信后，排队和投递状态会显示在这里。')} />
            : <Empty icon={<Inbox size={24} />} title={t('暂无 Linux DO 邮件')}
              description={t('INBOX 中暂时没有邮件，或账号凭据需要重新验证。')} />}
      </section>

      {account && <main className="reader-pane icloud-reader-pane">
        <MessageReader message={opened} folder={folder} loading={messageLoading}
          remoteImagesEnabled={remoteImagesEnabled} onBack={closeMessage} />
      </main>}

      {accountOpen && account && <LinuxDoMailAccountDialog
        account={account} action={action === 'verify' || action === 'update' ? action : ''}
        error={accountError} onCancel={() => setAccountOpen(false)} onVerify={verify}
        onUpdateCredential={updateCredential}
        onRequestDisconnect={() => { setAccountOpen(false); setDisconnectOpen(true) }} />}
      {composeOpen && account && <LinuxDoMailComposeDialog
        username={account.username} busy={action === 'send'} error={composeError}
        onCancel={() => setComposeOpen(false)} onSubmit={sendMessage} />}
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
