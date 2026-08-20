import {
  AlertCircle,
  ArrowLeft,
  AtSign,
  Check,
  Cloud,
  Copy,
  EyeOff,
  Inbox,
  KeyRound,
  LoaderCircle,
  Mail,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import {
  api,
  type ICloudAccount,
  type ICloudAlias,
  type ICloudHost,
  type ICloudMessage,
} from '../lib/api'
import { errorMessage } from '../lib/errorMessage'
import { parseICloudSender } from '../lib/icloudSender'
import { t } from '../lib/i18n'
import { ICloudRegionSelect } from './ICloudRegionSelect'
import { ICloudScopeSwitcher } from './ICloudScopeSwitcher'
import { ICloudMessageBody } from './ICloudMessageBody'
import { ICloudAliasBatchForm } from './ICloudAliasBatchForm'
import { DangerConfirmDialog } from './DangerConfirmDialog'

function Spinner({ size = 17 }: { size?: number }) {
  return <LoaderCircle className="spin" size={size} aria-hidden="true" />
}

function Empty({ icon, title, description, action }: {
  icon: ReactNode
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="icloud-empty">
      <span>{icon}</span><h3>{title}</h3><p>{description}</p>{action}
    </div>
  )
}

function Modal({ title, description, suspended = false, onClose, children }: {
  title: string
  description: string
  suspended?: boolean
  onClose: () => void
  children: ReactNode | ((close: () => void) => ReactNode)
}) {
  const dialogRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  const suspendedRef = useRef(suspended)
  const closeTimer = useRef<number | undefined>(undefined)
  const [visible, setVisible] = useState(false)
  onCloseRef.current = onClose
  suspendedRef.current = suspended
  function close() {
    if (closeTimer.current !== undefined) return
    setVisible(false)
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    closeTimer.current = window.setTimeout(() => onCloseRef.current(), reducedMotion ? 0 : 210)
  }
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    const enterFrame = requestAnimationFrame(() => setVisible(true))
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) || [])
    const first = dialog?.querySelector<HTMLElement>('[data-modal-autofocus]') || focusable()[0]
    first?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (suspendedRef.current) return
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (!items.length) return
      const firstItem = items[0]
      const lastItem = items.at(-1)!
      if (!dialog?.contains(document.activeElement)) {
        event.preventDefault(); (event.shiftKey ? lastItem : firstItem).focus()
      } else if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault(); lastItem.focus()
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault(); firstItem.focus()
      }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      cancelAnimationFrame(enterFrame)
      if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current)
      document.removeEventListener('keydown', keydown)
      previous?.focus()
    }
  }, [])
  return (
    <div className={`icloud-modal-backdrop${visible ? ' is-visible' : ''}`} onMouseDown={(event) => !suspended && event.target === event.currentTarget && close()}>
      <section ref={dialogRef} className="icloud-modal" role="dialog" aria-modal="true" aria-hidden={suspended || undefined} inert={suspended} aria-labelledby="icloud-modal-title" aria-describedby="icloud-modal-description">
        <header>
          <div><h2 id="icloud-modal-title">{title}</h2><p id="icloud-modal-description">{description}</p></div>
          <button className="icon-button" type="button" disabled={suspended} onClick={close} aria-label={t('关闭')}><X size={17} /></button>
        </header>
        {typeof children === 'function' ? children(close) : children}
      </section>
    </div>
  )
}

function AddAccountModal({ onClose, onCreated }: {
  onClose: () => void
  onCreated: (account: ICloudAccount) => void
}) {
  const [name, setName] = useState('')
  const [host, setHost] = useState<ICloudHost>('icloud.com')
  const [cookies, setCookies] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent, close: () => void) {
    event.preventDefault(); setSaving(true); setError('')
    try {
      const result = await api.createICloudAccount({ name, host, cookies })
      onCreated(result.account); close()
    } catch (submitError) {
      setError(t('添加失败：{error}', { error: errorMessage(submitError) }))
    } finally { setSaving(false) }
  }
  return (
    <Modal title={t('添加 iCloud 账号')} description={t('仅支持已开通 iCloud+ 且具有 Hide My Email 权限的账号；仅网页访问账号无法使用。')} onClose={onClose}>
      {(close) => <form className="icloud-form" onSubmit={(event) => void submit(event, close)}>
        <label><span>{t('账号名称')}</span><input value={name} maxLength={80} required autoFocus data-modal-autofocus onChange={(event) => setName(event.target.value)} placeholder={t('例如：个人 iCloud')} /></label>
        <div className="icloud-form-field"><span>{t('iCloud 区域')}</span><ICloudRegionSelect value={host} onChange={setHost} /></div>
        <label><span>Cookie</span><textarea value={cookies} rows={7} required onChange={(event) => setCookies(event.target.value)} placeholder="X-APPLE-WEBAUTH-TOKEN=...; X-APPLE-ID-SESSION-ID=..." /></label>
        <p className="icloud-form-note"><ShieldCheck size={15} />{t('凭据会在 Worker 内加密，保存后不会回传到浏览器。')}</p>
        <p className="icloud-form-note">{t('仅支持已开通 iCloud+ 且具有 Hide My Email 权限的账号。')}</p>
        {error && <p className="inline-error" role="alert"><AlertCircle size={15} />{t(error)}</p>}
        <footer><button className="button button--secondary" type="button" onClick={close}>{t('取消')}</button><button className="button button--primary" disabled={saving}>{saving ? <Spinner /> : <Plus size={16} />}{t('验证并添加')}</button></footer>
      </form>}
    </Modal>
  )
}

function AccountSettingsModal({ account, onClose, onChanged, onDeleted, onNotice }: {
  account: ICloudAccount
  onClose: () => void
  onChanged: () => Promise<void>
  onDeleted: () => Promise<void>
  onNotice: (message: string) => void
}) {
  const [name, setName] = useState(account.name)
  const [cookies, setCookies] = useState('')
  const [icloudEmail, setICloudEmail] = useState(account.icloudEmail)
  const [appPassword, setAppPassword] = useState('')
  const [saving, setSaving] = useState<'name' | 'cookies' | 'password' | 'delete' | ''>('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [error, setError] = useState('')
  async function saveName(event: FormEvent) {
    event.preventDefault(); setSaving('name'); setError('')
    try {
      const result = await api.updateICloudAccountName(account.id, name)
      setName(result.name)
      await onChanged(); onNotice(t('备注名称已保存'))
    } catch (saveError) { setError(errorMessage(saveError)) } finally { setSaving('') }
  }
  async function saveCookies(event: FormEvent) {
    event.preventDefault(); setSaving('cookies'); setError('')
    try { await api.updateICloudCookies(account.id, cookies); setCookies(''); await onChanged(); onNotice(t('Cookie 已更新')) }
    catch (saveError) { setError(errorMessage(saveError)) } finally { setSaving('') }
  }
  async function savePassword(event: FormEvent) {
    event.preventDefault(); setSaving('password'); setError('')
    try {
      await api.updateICloudAppPassword(account.id, icloudEmail, appPassword)
      setAppPassword(''); await onChanged(); onNotice(t('应用专用密码已更新'))
    } catch (saveError) { setError(errorMessage(saveError)) } finally { setSaving('') }
  }
  async function remove() {
    setSaving('delete'); setError('')
    try { await api.deleteICloudAccount(account.id); await onDeleted() }
    catch (deleteError) {
      setConfirmingDelete(false); setError(errorMessage(deleteError)); setSaving('')
    }
  }
  return (
    <Modal title={t('设置 {name}', { name: account.name })} description={t('修改备注名称或覆盖更新凭据；原值不会显示。')} suspended={confirmingDelete} onClose={onClose}>
      {() => <>
      <form className="icloud-form icloud-account-name-form" onSubmit={saveName}>
        <h3><Settings2 size={17} />{t('备注名称')}</h3>
        <label><span>{t('备注名称')}</span><input value={name} maxLength={80} required
          data-modal-autofocus onChange={(event) => setName(event.target.value)} /></label>
        <button className="button button--secondary" disabled={Boolean(saving) || name.trim() === account.name}>{saving === 'name' ? <Spinner /> : <Check size={16} />}{t('保存备注')}</button>
      </form>
      <div className="icloud-credential-forms">
        <form className="icloud-form" onSubmit={saveCookies}>
          <h3><EyeOff size={17} />iCloud Cookie <small>{t(account.hasCookies ? '已配置' : '未配置')}</small></h3>
          <label><span>{t('新 Cookie')}</span><textarea value={cookies} rows={5} required onChange={(event) => setCookies(event.target.value)} /></label>
          <button className="button button--secondary" disabled={Boolean(saving)}>{saving === 'cookies' ? <Spinner /> : <ShieldCheck size={16} />}{t('验证并覆盖')}</button>
        </form>
        <form className="icloud-form" onSubmit={savePassword}>
          <h3><KeyRound size={17} />{t('应用专用密码')} <small>{t(account.hasAppPassword ? '已配置' : '未配置')}</small></h3>
          <label><span>{t('iCloud 邮箱')}</span><input type="email" value={icloudEmail} required onChange={(event) => setICloudEmail(event.target.value)} placeholder="name@icloud.com" /></label>
          <label><span>{t('新应用专用密码')}</span><input type="password" value={appPassword} required autoComplete="new-password" onChange={(event) => setAppPassword(event.target.value)} /></label>
          <p className="icloud-form-note"><KeyRound size={15} />{t('应用专用密码仅绑定当前 iCloud 账号，不会与其他账号共用。')}</p>
          <button className="button button--secondary" disabled={Boolean(saving)}>{saving === 'password' ? <Spinner /> : <ShieldCheck size={16} />}{t('测试并覆盖')}</button>
        </form>
      </div>
      {error && <p className="inline-error" role="alert"><AlertCircle size={15} />{t(error)}</p>}
      <footer className="icloud-credential-danger"><span>{t('删除账号会同时删除两项密文。')}</span><button className="button icloud-danger-button" type="button" onClick={() => setConfirmingDelete(true)} disabled={Boolean(saving)}><Trash2 size={15} />{t('删除这个 iCloud 账号')}</button></footer>
      {confirmingDelete && <DangerConfirmDialog
        icon={Trash2}
        eyebrow="ICLOUD ACCOUNT"
        title={t('删除 iCloud 账号？')}
        description={t('账号“{name}”将从 OmniMail 中移除。', { name: account.name })}
        impactTitle={t('此操作无法撤销')}
        impactDescription={t('保存的 Cookie 和应用专用密码会一并删除；Apple 账号和已有隐藏邮箱不会受影响。')}
        confirmLabel={t(saving === 'delete' ? '正在删除…' : '删除账号')}
        busy={saving === 'delete'}
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => void remove()}
      />}
      </>}
    </Modal>
  )
}

function ICloudReader({ message, loading, method, remoteImagesEnabled, onBack }: {
  message: ICloudMessage | null
  loading: boolean
  method: 'imap' | 'web' | ''
  remoteImagesEnabled: boolean
  onBack: () => void
}) {
  if (loading) {
    return <div className="reader-state reader-state--loading" role="status"><Spinner size={23} />{t('正在读取完整正文…')}</div>
  }
  if (!message) {
    return <div className="reader-state reader-state--empty"><span className="reader-empty-symbol"><Mail size={29} /></span><h2>{t('选择一封 iCloud 邮件')}</h2></div>
  }
  const sender = parseICloudSender(message.from)
  const senderLabel = sender.name || sender.address || t('未知发件人')
  return (
    <article className="icloud-reader">
      <header className="reader-toolbar">
        <button className="icon-button mobile-back" type="button" onClick={onBack} aria-label={t('返回邮件列表')}><ArrowLeft size={18} /></button>
        <h2 className="reader-toolbar__title">{t('iCloud 邮件')}</h2>
        {method && <span className={`icloud-source-badge is-${method}`}>{t(method === 'imap' ? 'IMAP 完整邮件' : 'Web 摘要')}</span>}
      </header>
      <div className="reader-content icloud-reader-content">
        <div className="icloud-reader-heading">
          <h1>{message.subject || t('无主题')}</h1>
          <div className="icloud-reader-sender">
            <span>{senderLabel.slice(0, 1).toUpperCase()}</span>
            <p><strong>{senderLabel}</strong>{sender.name && sender.address && <small title={sender.address}>{sender.isHideMyEmailRelay ? t('通过 iCloud 隐藏邮箱转发') : `<${sender.address}>`}</small>}{message.to && <small>{t('收件：{address}', { address: message.to })}</small>}</p>
            {message.date && <time>{new Date(message.date).toLocaleString()}</time>}
          </div>
        </div>
        {method === 'web' && <div className="icloud-reader-web-note"><KeyRound size={15} /><span><strong>{t('当前显示 iCloud Web 摘要')}</strong>{t('配置当前账号的应用专用密码后，可读取 IMAP 完整正文。')}</span></div>}
        <div className="icloud-reader-body"><ICloudMessageBody message={message} remoteImagesEnabled={remoteImagesEnabled} /></div>
      </div>
    </article>
  )
}

export function ICloudWorkspace({ enabled, remoteImagesEnabled }: {
  enabled: boolean
  remoteImagesEnabled: boolean
}) {
  const [accounts, setAccounts] = useState<ICloudAccount[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [aliases, setAliases] = useState<ICloudAlias[]>([])
  const [selectedAlias, setSelectedAlias] = useState('')
  const [messages, setMessages] = useState<ICloudMessage[]>([])
  const [inboxMethod, setInboxMethod] = useState<'imap' | 'web' | ''>('')
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [credentials, setCredentials] = useState<ICloudAccount | null>(null)
  const [opened, setOpened] = useState<ICloudMessage | null>(null)
  const [messageLoading, setMessageLoading] = useState(false)
  const aliasRequestId = useRef(0)
  const inboxRequestId = useRef(0)
  const messageRequestId = useRef(0)
  const accountsRequestId = useRef(0)
  const accountsController = useRef<AbortController | null>(null)
  const aliasController = useRef<AbortController | null>(null)
  const inboxController = useRef<AbortController | null>(null)
  const messageController = useRef<AbortController | null>(null)
  const selected = accounts.find((account) => account.id === selectedId)
  const activeAlias = aliases.find((alias) => alias.email === selectedAlias)

  const loadAccounts = useCallback(async () => {
    if (!enabled) { setLoading(false); return }
    accountsController.current?.abort()
    const controller = new AbortController()
    accountsController.current = controller
    const current = ++accountsRequestId.current
    try {
      const result = await api.iCloudAccounts(controller.signal)
      if (current !== accountsRequestId.current) return
      setAccounts(result.accounts)
      setSelectedId((current) => result.accounts.some((item) => item.id === current) ? current : result.accounts[0]?.id || '')
      setCredentials((current) => current ? result.accounts.find((item) => item.id === current.id) || null : null)
    } catch (loadError) {
      if (current === accountsRequestId.current) setError(errorMessage(loadError))
    } finally {
      if (current === accountsRequestId.current) setLoading(false)
    }
  }, [enabled])

  const sync = useCallback(async (alias = selectedAlias) => {
    const id = selectedId
    if (!id) return
    aliasController.current?.abort()
    inboxController.current?.abort()
    const aliasAbort = new AbortController()
    aliasController.current = aliasAbort
    const aliasCurrent = ++aliasRequestId.current
    const inboxCurrent = ++inboxRequestId.current
    setSyncing(true); setError('')
    try {
      const aliasResult = await api.iCloudAliases(id, aliasAbort.signal)
      if (aliasCurrent !== aliasRequestId.current) return
      setAliases(aliasResult.aliases)
      await loadAccounts()
      if (aliasCurrent !== aliasRequestId.current || inboxCurrent !== inboxRequestId.current) return
      try {
        inboxController.current?.abort()
        const inboxAbort = new AbortController()
        inboxController.current = inboxAbort
        const inboxResult = await api.iCloudInbox(id, alias, inboxAbort.signal)
        if (inboxCurrent === inboxRequestId.current) {
          setMessages(inboxResult.messages)
          setInboxMethod(inboxResult.method)
        }
      } catch (inboxError) {
        if (inboxCurrent === inboxRequestId.current) {
          setMessages([])
          setInboxMethod('')
          setError(errorMessage(inboxError))
        }
      }
    } catch (syncError) {
      if (aliasCurrent === aliasRequestId.current) {
        setAliases([]); setMessages([]); setInboxMethod(''); setError(errorMessage(syncError))
      }
    } finally {
      if (aliasCurrent === aliasRequestId.current && inboxCurrent === inboxRequestId.current) setSyncing(false)
    }
  }, [loadAccounts, selectedAlias, selectedId])

  const loadInbox = useCallback(async () => {
    const id = selectedId
    if (!id) return
    inboxController.current?.abort()
    const inboxAbort = new AbortController()
    inboxController.current = inboxAbort
    const current = ++inboxRequestId.current
    setSyncing(true); setError('')
    try {
      const result = await api.iCloudInbox(id, selectedAlias, inboxAbort.signal)
      if (current === inboxRequestId.current) {
        setMessages(result.messages)
        setInboxMethod(result.method)
      }
    } catch (inboxError) {
      if (current === inboxRequestId.current) {
        setMessages([]); setInboxMethod(''); setError(errorMessage(inboxError))
      }
    } finally { if (current === inboxRequestId.current) setSyncing(false) }
  }, [selectedAlias, selectedId])

  useEffect(() => { void loadAccounts() }, [loadAccounts])
  useEffect(() => {
    aliasController.current?.abort(); inboxController.current?.abort()
    messageController.current?.abort(); messageRequestId.current += 1
    aliasRequestId.current += 1; inboxRequestId.current += 1
    setAliases([]); setMessages([]); setInboxMethod(''); setSelectedAlias(''); setOpened(null)
  }, [selectedId])
  useEffect(() => { if (selectedId) void sync() }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    messageController.current?.abort()
    messageRequestId.current += 1
    setOpened(null)
    setMessageLoading(false)
    if (selectedId) void loadInbox()
  }, [selectedAlias]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 3000)
    return () => window.clearTimeout(timer)
  }, [notice])
  useEffect(() => () => {
    accountsRequestId.current += 1
    aliasRequestId.current += 1
    inboxRequestId.current += 1
    messageRequestId.current += 1
    accountsController.current?.abort()
    aliasController.current?.abort()
    inboxController.current?.abort()
    messageController.current?.abort()
  }, [])

  async function aliasAction(alias: ICloudAlias, action: 'deactivate' | 'reactivate' | 'delete') {
    if (!selected) return
    if (action === 'delete' && !window.confirm(t('确定永久删除 {address} 吗？', { address: alias.email }))) return
    try {
      if (action === 'delete') await api.deleteICloudAlias(alias.anonymousId, selected.id)
      else await api.updateICloudAlias(alias.anonymousId, selected.id, action)
      if (action === 'delete' && selectedAlias === alias.email) setSelectedAlias('')
      setNotice(t(action === 'delete' ? '隐藏邮箱已删除' : action === 'deactivate' ? '隐藏邮箱已停用' : '隐藏邮箱已恢复'))
      await sync()
    } catch (actionError) { setError(errorMessage(actionError)) }
  }
  async function openMessage(message: ICloudMessage) {
    messageController.current?.abort()
    const current = ++messageRequestId.current
    setOpened(message)
    setMessageLoading(false)
    if (!selected?.hasAppPassword || !/^\d+$/.test(message.id)) return
    const controller = new AbortController()
    messageController.current = controller
    setMessageLoading(true)
    try {
      const result = await api.iCloudMessage(selected.id, message.id, controller.signal)
      if (current === messageRequestId.current) setOpened(result.message)
    } catch (openError) {
      if (current === messageRequestId.current) setError(errorMessage(openError))
    } finally {
      if (current === messageRequestId.current) setMessageLoading(false)
    }
  }
  async function copyAlias(address: string) {
    try {
      await navigator.clipboard.writeText(address)
      setNotice(t('已复制：{address}', { address }))
    } catch {
      setError(t('无法访问剪贴板，请手动复制邮箱地址。'))
    }
  }
  function closeMessage() {
    messageController.current?.abort()
    messageRequestId.current += 1
    setOpened(null)
    setMessageLoading(false)
  }

  return (
    <div className={`icloud-mail-view${opened ? ' has-selection' : ''}`}>
      <section className="list-pane icloud-list-pane page-content-enter">
        <header className="list-header icloud-list-header">
          <div>
            {accounts.length ? <ICloudScopeSwitcher accounts={accounts} aliases={aliases}
              selectedAccountId={selectedId} selectedAlias={selectedAlias}
              onAccountChange={setSelectedId} onAliasChange={setSelectedAlias}
              onAliasCopy={copyAlias} onAccountSettings={setCredentials} />
              : <p className="eyebrow">ICLOUD · HIDE MY EMAIL</p>}
            <h1>iCloud</h1>
          </div>
          <div className="list-header__actions">
            <button className="icon-button" type="button" disabled={!enabled}
              onClick={() => setAddOpen(true)} aria-label={t('添加 iCloud 账号')}
              data-tooltip={t('添加 iCloud 账号')}><Plus size={17} /></button>
            <button className="icon-button" type="button" disabled={!selected?.hasCookies}
              onClick={() => setCreateOpen(true)} aria-label={t('创建隐藏邮箱')}
              data-tooltip={t('创建隐藏邮箱')}><AtSign size={17} /></button>
            <button className="icon-button" type="button" disabled={!selected}
              onClick={() => selected && setCredentials(selected)} aria-label={t('账号设置')}
              data-tooltip={t('账号设置')}><Settings2 size={17} /></button>
            <button className="icon-button" type="button" disabled={!selected || syncing}
              onClick={() => void sync()} aria-label={t('同步')}
              data-tooltip={t('同步')}>{syncing ? <Spinner /> : <RefreshCw size={17} />}</button>
          </div>
        </header>

        {error && <p className="list-error" role="alert"><AlertCircle size={15} />{t(error)}</p>}
        {selected && <div className={`icloud-list-context ${selected.hasAppPassword ? 'is-imap' : 'is-cookie'}`}>
          <span>{activeAlias ? <AtSign size={16} /> : selected.hasAppPassword ? <ShieldCheck size={16} /> : <KeyRound size={16} />}</span>
          <p><strong>{activeAlias?.label || t(selected.hasAppPassword ? 'IMAP 完整邮件' : 'Web 摘要')}</strong><small>{activeAlias?.email || t(selected.hasAppPassword ? '可按隐藏地址筛选并读取完整正文' : '配置应用专用密码后可读取完整正文')}</small></p>
          {activeAlias ? <div>
            <button type="button" onClick={() => void copyAlias(activeAlias.email)} aria-label={t('复制')} data-tooltip={t('复制')}><Copy size={14} /></button>
            <button type="button" onClick={() => void aliasAction(activeAlias, activeAlias.active ? 'deactivate' : 'reactivate')} aria-label={t(activeAlias.active ? '停用' : '恢复')} data-tooltip={t(activeAlias.active ? '停用' : '恢复')}>{activeAlias.active ? <PowerOff size={14} /> : <Power size={14} />}</button>
            <button className="is-danger" type="button" onClick={() => void aliasAction(activeAlias, 'delete')} aria-label={t('删除')} data-tooltip={t('删除')}><Trash2 size={14} /></button>
          </div> : !selected.hasAppPassword && <button type="button" onClick={() => setCredentials(selected)}>{t('配置')}</button>}
        </div>}

        {!enabled ? <Empty icon={<KeyRound size={24} />} title={t('iCloud 功能尚未启用')} description={t('在 Worker Variables & Secrets 中配置至少 32 字节的 ICLOUD_CREDENTIALS_KEY，然后重新部署。')} />
          : loading ? <div className="icloud-loading"><Spinner size={22} />{t('正在读取 iCloud 账号…')}</div>
          : !accounts.length ? <Empty icon={<Cloud size={24} />} title={t('还没有 iCloud 账号')} description={t('添加 Cookie 后即可同步隐藏邮箱；应用专用密码用于按地址筛选和读取完整正文。')} action={<button className="button button--primary" type="button" onClick={() => setAddOpen(true)}><Plus size={16} />{t('添加第一个账号')}</button>} />
          : selectedAlias && !selected?.hasAppPassword ? <Empty icon={<KeyRound size={24} />} title={t('需要应用专用密码')} description={t('配置后才能准确筛选这个隐藏邮箱收到的邮件。')} action={<button className="button button--secondary button--small" type="button" onClick={() => selected && setCredentials(selected)}>{t('配置应用密码')}</button>} />
          : syncing && !messages.length ? <div className="icloud-loading"><Spinner />{t('正在读取收件箱…')}</div>
          : messages.length ? <div className="message-list-shell"><div className="message-list" role="listbox" aria-label={t('iCloud 邮件列表')}>
            {messages.map((message) => {
              const active = opened?.id === message.id && opened.to === message.to
              const sender = parseICloudSender(message.from)
              return <article className={`message-row${active ? ' is-selected' : ''}`} role="option" aria-selected={active} key={`${message.id}-${message.to}`}>
                <button className="message-row__main" type="button" onClick={() => void openMessage(message)}>
                  <span className="message-row__top"><strong>{sender.name || sender.address || t('未知发件人')}</strong><time>{message.date ? new Date(message.date).toLocaleDateString() : ''}</time></span>
                  <span className="message-row__subject"><span className="message-row__subject-text">{message.subject || t('无主题')}</span></span>
                  <span className="message-row__preview">{message.preview || t('暂无正文预览')}</span>
                  {message.to && <span className="mailbox-hint"><AtSign size={12} />{message.to}</span>}
                </button>
              </article>
            })}
          </div></div> : <Empty icon={<Inbox size={24} />} title={t('暂无 iCloud 邮件')} description={t('最近 7 天没有找到邮件，或需要更新账号凭据。')} />}
      </section>

      <main className="reader-pane icloud-reader-pane">
        <ICloudReader message={opened} loading={messageLoading} method={inboxMethod} remoteImagesEnabled={remoteImagesEnabled} onBack={closeMessage} />
      </main>

      {addOpen && <AddAccountModal onClose={() => setAddOpen(false)} onCreated={(account) => { setAccounts((items) => [...items, account]); setSelectedId(account.id); setNotice(t('iCloud 账号已添加')) }} />}
      {createOpen && selected && <Modal title={t('创建隐藏邮箱')} description={t('预览 Apple 生成的地址，确认后一次创建最多 5 个。')} onClose={() => setCreateOpen(false)}>{(close) => <ICloudAliasBatchForm account={selected} close={close} onCreated={async (createdAliases) => { const latest = createdAliases.at(-1); if (!latest) return; setSelectedAlias(latest.email); setNotice(t(createdAliases.length === 1 ? '新的隐藏邮箱已创建' : '已创建 {count} 个隐藏邮箱', { count: createdAliases.length })); await sync(latest.email) }} />}</Modal>}
      {credentials && <AccountSettingsModal account={credentials} onClose={() => setCredentials(null)} onChanged={loadAccounts} onDeleted={async () => { await loadAccounts(); setAliases([]); setMessages([]); setInboxMethod('') }} onNotice={setNotice} />}
      {notice && <div className="toast" role="status"><Check size={16} />{notice}</div>}
    </div>
  )
}
