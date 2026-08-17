import {
  AlertCircle,
  AtSign,
  Check,
  ChevronDown,
  Cloud,
  Copy,
  EyeOff,
  Globe2,
  Inbox,
  KeyRound,
  LoaderCircle,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
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
import { t } from '../lib/i18n'
import { AdminPageHeader } from './AdminPageHeader'

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

function Status({ account }: { account: ICloudAccount }) {
  return (
    <span className={`icloud-status is-${account.status}`}>
      <span />{t(account.status === 'active' ? '可用' : account.status === 'pending' ? '待配置' : '需处理')}
    </span>
  )
}

function Modal({ title, description, onClose, children }: {
  title: string
  description: string
  onClose: () => void
  children: ReactNode
}) {
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) || [])
    const first = dialog?.querySelector<HTMLElement>('[data-modal-autofocus]') || focusable()[0]
    first?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
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
      document.removeEventListener('keydown', keydown)
      previous?.focus()
    }
  }, [])
  return (
    <div className="icloud-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="icloud-modal" role="dialog" aria-modal="true" aria-labelledby="icloud-modal-title" aria-describedby="icloud-modal-description">
        <header>
          <div><h2 id="icloud-modal-title">{title}</h2><p id="icloud-modal-description">{description}</p></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label={t('关闭')}><X size={17} /></button>
        </header>
        {children}
      </section>
    </div>
  )
}

const iCloudRegions: Array<{ value: ICloudHost; label: string; domain: string }> = [
  { value: 'icloud.com', label: '全球', domain: 'icloud.com' },
  { value: 'icloud.com.cn', label: '中国大陆', domain: 'icloud.com.cn' },
]

function ICloudRegionSelect({ value, onChange }: {
  value: ICloudHost
  onChange: (value: ICloudHost) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const menuId = useId()
  const selectedIndex = Math.max(0, iCloudRegions.findIndex((region) => region.value === value))
  const selected = iCloudRegions[selectedIndex]

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  function showMenu(index = selectedIndex) {
    setOpen(true)
    requestAnimationFrame(() => optionRefs.current[index]?.focus())
  }

  function closeMenu(focusTrigger = false) {
    setOpen(false)
    if (focusTrigger) requestAnimationFrame(() => trigger.current?.focus())
  }

  function handleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    showMenu(event.key === 'ArrowUp' ? iCloudRegions.length - 1 : selectedIndex)
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const current = optionRefs.current.findIndex((option) => option === document.activeElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMenu(true)
      return
    }
    if (event.key === 'Tab') {
      setOpen(false)
      return
    }
    let next = current
    if (event.key === 'ArrowDown') next = Math.min(iCloudRegions.length - 1, current + 1)
    else if (event.key === 'ArrowUp') next = Math.max(0, current - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = iCloudRegions.length - 1
    else return
    event.preventDefault()
    optionRefs.current[next]?.focus()
  }

  return (
    <div className={`icloud-region-select${open ? ' is-open' : ''}`} ref={root}>
      <button
        ref={trigger}
        className="icloud-region-select__trigger"
        type="button"
        role="combobox"
        aria-label={t('iCloud 区域')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => open ? closeMenu() : showMenu()}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="icloud-region-select__icon"><Globe2 size={16} aria-hidden="true" /></span>
        <span><strong>{t(selected.label)}</strong><small>{selected.domain}</small></span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="icloud-region-select__menu"
          id={menuId}
          role="listbox"
          aria-label={t('iCloud 区域')}
          onKeyDown={handleMenuKeyDown}
        >
          {iCloudRegions.map((region, index) => (
            <button
              ref={(node) => { optionRefs.current[index] = node }}
              className={region.value === value ? 'is-selected' : ''}
              type="button"
              role="option"
              aria-selected={region.value === value}
              tabIndex={region.value === value ? 0 : -1}
              key={region.value}
              onClick={() => {
                onChange(region.value)
                closeMenu(true)
              }}
            >
              <span className="icloud-region-select__icon"><Globe2 size={16} aria-hidden="true" /></span>
              <span><strong>{t(region.label)}</strong><small>{region.domain}</small></span>
              {region.value === value && <Check size={16} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
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
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError('')
    try {
      const result = await api.createICloudAccount({ name, host, cookies })
      onCreated(result.account); onClose()
    } catch (submitError) { setError(errorMessage(submitError)) } finally { setSaving(false) }
  }
  return (
    <Modal title={t('添加 iCloud 账号')} description={t('导入 iCloud.com Cookie，用于管理隐藏邮箱。')} onClose={onClose}>
      <form className="icloud-form" onSubmit={submit}>
        <label><span>{t('账号名称')}</span><input value={name} maxLength={80} required autoFocus data-modal-autofocus onChange={(event) => setName(event.target.value)} placeholder={t('例如：个人 iCloud')} /></label>
        <div className="icloud-form-field"><span>{t('iCloud 区域')}</span><ICloudRegionSelect value={host} onChange={setHost} /></div>
        <label><span>Cookie</span><textarea value={cookies} rows={7} required onChange={(event) => setCookies(event.target.value)} placeholder="X-APPLE-WEBAUTH-TOKEN=...; X-APPLE-ID-SESSION-ID=..." /></label>
        <p className="icloud-form-note"><ShieldCheck size={15} />{t('凭据会在 Worker 内加密，保存后不会回传到浏览器。')}</p>
        {error && <p className="inline-error" role="alert"><AlertCircle size={15} />{t(error)}</p>}
        <footer><button className="button button--secondary" type="button" onClick={onClose}>{t('取消')}</button><button className="button button--primary" disabled={saving}>{saving ? <Spinner /> : <Plus size={16} />}{t('验证并添加')}</button></footer>
      </form>
    </Modal>
  )
}

function CredentialsModal({ account, onClose, onChanged, onDeleted }: {
  account: ICloudAccount
  onClose: () => void
  onChanged: () => Promise<void>
  onDeleted: () => Promise<void>
}) {
  const [cookies, setCookies] = useState('')
  const [icloudEmail, setICloudEmail] = useState(account.icloudEmail)
  const [appPassword, setAppPassword] = useState('')
  const [saving, setSaving] = useState<'cookies' | 'password' | 'delete' | ''>('')
  const [error, setError] = useState('')
  async function saveCookies(event: FormEvent) {
    event.preventDefault(); setSaving('cookies'); setError('')
    try { await api.updateICloudCookies(account.id, cookies); setCookies(''); await onChanged() }
    catch (saveError) { setError(errorMessage(saveError)) } finally { setSaving('') }
  }
  async function savePassword(event: FormEvent) {
    event.preventDefault(); setSaving('password'); setError('')
    try {
      await api.updateICloudAppPassword(account.id, icloudEmail, appPassword)
      setAppPassword(''); await onChanged()
    } catch (saveError) { setError(errorMessage(saveError)) } finally { setSaving('') }
  }
  async function remove() {
    if (!window.confirm(t('确定删除 iCloud 账号“{name}”及其加密凭据吗？', { name: account.name }))) return
    setSaving('delete'); setError('')
    try { await api.deleteICloudAccount(account.id); await onDeleted(); onClose() }
    catch (deleteError) { setError(errorMessage(deleteError)); setSaving('') }
  }
  return (
    <Modal title={t('管理 {name}', { name: account.name })} description={t('覆盖更新凭据；原值不会显示。')} onClose={onClose}>
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
          <button className="button button--secondary" disabled={Boolean(saving)}>{saving === 'password' ? <Spinner /> : <ShieldCheck size={16} />}{t('测试并覆盖')}</button>
        </form>
      </div>
      {error && <p className="inline-error" role="alert"><AlertCircle size={15} />{t(error)}</p>}
      <footer className="icloud-credential-danger"><span>{t('删除账号会同时删除两项密文。')}</span><button type="button" onClick={() => void remove()} disabled={Boolean(saving)}>{saving === 'delete' ? <Spinner /> : <Trash2 size={15} />}{t('删除这个 iCloud 账号')}</button></footer>
    </Modal>
  )
}

function MessageModal({ message, loading, onClose }: {
  message: ICloudMessage
  loading: boolean
  onClose: () => void
}) {
  return (
    <Modal title={message.subject || t('无主题')} description={message.date ? new Date(message.date).toLocaleString() : ''} onClose={onClose}>
      <article className="icloud-message-reader">
        <header><strong>{message.from || t('未知发件人')}</strong>{message.to && <small>{t('收件：{address}', { address: message.to })}</small>}</header>
        {loading && <p><Spinner />{t('正在读取完整正文…')}</p>}
        <div>{message.body || message.preview || t('这封邮件没有可显示的文本内容。')}</div>
      </article>
    </Modal>
  )
}

export function ICloudWorkspace({ enabled }: { enabled: boolean }) {
  const [accounts, setAccounts] = useState<ICloudAccount[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [aliases, setAliases] = useState<ICloudAlias[]>([])
  const [selectedAlias, setSelectedAlias] = useState('')
  const [messages, setMessages] = useState<ICloudMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [credentials, setCredentials] = useState<ICloudAccount | null>(null)
  const [label, setLabel] = useState('')
  const [creating, setCreating] = useState(false)
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

  const sync = useCallback(async () => {
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
        const inboxResult = await api.iCloudInbox(id, selectedAlias, inboxAbort.signal)
        if (inboxCurrent === inboxRequestId.current) setMessages(inboxResult.messages)
      } catch (inboxError) {
        if (inboxCurrent === inboxRequestId.current) {
          setMessages([])
          setError(errorMessage(inboxError))
        }
      }
    } catch (syncError) {
      if (aliasCurrent === aliasRequestId.current) {
        setAliases([]); setMessages([]); setError(errorMessage(syncError))
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
      if (current === inboxRequestId.current) setMessages(result.messages)
    } catch (inboxError) {
      if (current === inboxRequestId.current) {
        setMessages([]); setError(errorMessage(inboxError))
      }
    } finally { if (current === inboxRequestId.current) setSyncing(false) }
  }, [selectedAlias, selectedId])

  useEffect(() => { void loadAccounts() }, [loadAccounts])
  useEffect(() => {
    aliasController.current?.abort(); inboxController.current?.abort()
    messageController.current?.abort(); messageRequestId.current += 1
    aliasRequestId.current += 1; inboxRequestId.current += 1
    setAliases([]); setMessages([]); setSelectedAlias(''); setOpened(null)
  }, [selectedId])
  useEffect(() => { if (selectedId) void sync() }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
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

  async function createAlias(event: FormEvent) {
    event.preventDefault(); if (!selected) return
    setCreating(true); setError('')
    try { await api.createICloudAlias(selected.id, label); setLabel(''); setNotice(t('新的隐藏邮箱已创建')); await sync() }
    catch (createError) { setError(errorMessage(createError)) } finally { setCreating(false) }
  }
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
    <main className="admin-workspace icloud-workspace">
      <AdminPageHeader icon={Cloud} eyebrow="iCloud · HIDE MY EMAIL" title={t('iCloud 隐藏邮箱')} description={t('在 OmniMail 中管理 iCloud+ 隐藏地址，并按需查看最近来信。')} actions={enabled ? <button className="button button--primary user-header-actions icloud-header-action" type="button" onClick={() => setAddOpen(true)}><Plus size={16} />{t('添加 iCloud 账号')}</button> : undefined} />
      {!enabled ? (
        <Empty icon={<KeyRound size={24} />} title={t('iCloud 功能尚未启用')} description={t('在 Worker Variables & Secrets 中配置至少 32 字节的 ICLOUD_CREDENTIALS_KEY，然后重新部署。')} />
      ) : loading ? <div className="icloud-loading"><Spinner size={22} />{t('正在读取 iCloud 账号…')}</div> : (
        <>
          {error && <p className="inline-error icloud-alert" role="alert"><AlertCircle size={15} />{t(error)}</p>}
          <div className="icloud-account-strip">
            {accounts.map((account) => <button className={account.id === selectedId ? 'is-selected' : ''} type="button" key={account.id} onClick={() => setSelectedId(account.id)}><Cloud size={17} /><span><strong>{account.name}</strong><small>{account.realEmail || account.icloudEmail || t('尚未识别 Apple ID')}</small></span><Status account={account} /></button>)}
            {!accounts.length && <Empty icon={<Cloud size={24} />} title={t('还没有 iCloud 账号')} description={t('添加 Cookie 后即可同步隐藏邮箱；应用专用密码用于按地址筛选和读取完整正文。')} action={<button className="button button--primary" type="button" onClick={() => setAddOpen(true)}><Plus size={16} />{t('添加第一个账号')}</button>} />}
          </div>
          {selected && <>
            <section className="icloud-security-row"><span><ShieldCheck size={18} /></span><p><strong>{t('凭据不会返回到浏览器')}</strong>{t('Cookie 和应用专用密码只以加密密文保存在 D1。')}</p><button className="button button--secondary button--small" type="button" onClick={() => setCredentials(selected)}><KeyRound size={15} />{t('管理凭据')}</button></section>
            <form className="icloud-create-bar" onSubmit={createAlias}><AtSign size={17} /><input value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} placeholder={t('用途标签，例如：购物网站')} /><button className="button button--primary button--small" disabled={creating || !selected.hasCookies}>{creating ? <Spinner /> : <Plus size={15} />}{t('创建隐藏邮箱')}</button></form>
            <div className="icloud-mail-grid">
              <aside className="icloud-aliases"><header><div><h2>{t('隐藏邮箱')}</h2><p>{t('{count} 个地址', { count: aliases.length })}</p></div><button className="icon-button icon-button--small" type="button" disabled={syncing} onClick={() => void sync()} aria-label={t('同步')}>{syncing ? <Spinner /> : <RefreshCw size={15} />}</button></header><div><button className={!selectedAlias ? 'is-active' : ''} type="button" onClick={() => setSelectedAlias('')}><Inbox size={16} /><span><strong>{t('全部邮件')}</strong><small>{t('所有收件地址')}</small></span></button>{aliases.map((alias) => <button className={selectedAlias === alias.email ? 'is-active' : ''} type="button" key={alias.anonymousId || alias.email} onClick={() => setSelectedAlias(alias.email)}><AtSign size={16} /><span><strong>{alias.label || t('未命名地址')}</strong><small>{alias.email}</small></span></button>)}</div></aside>
              <section className="icloud-inbox"><header><div><h2>{selectedAlias ? aliases.find((alias) => alias.email === selectedAlias)?.label || t('隐藏邮箱') : t('全部邮件')}</h2><p>{selectedAlias || t('最近 7 天来信')} · {t('{count} 封', { count: messages.length })}</p></div>{selectedAlias && aliases.find((alias) => alias.email === selectedAlias) && <div className="icloud-alias-actions"><button type="button" onClick={() => void copyAlias(selectedAlias)}><Copy size={14} />{t('复制')}</button>{(() => { const alias = aliases.find((item) => item.email === selectedAlias)!; return <><button type="button" onClick={() => void aliasAction(alias, alias.active ? 'deactivate' : 'reactivate')}>{alias.active ? <PowerOff size={14} /> : <Power size={14} />}{t(alias.active ? '停用' : '恢复')}</button><button className="is-danger" type="button" onClick={() => void aliasAction(alias, 'delete')}><Trash2 size={14} />{t('删除')}</button></> })()}</div>}</header>{syncing && !messages.length ? <div className="icloud-loading"><Spinner />{t('正在读取收件箱…')}</div> : selectedAlias && !selected.hasAppPassword ? <Empty icon={<KeyRound />} title={t('需要应用专用密码')} description={t('配置后才能准确筛选这个隐藏邮箱收到的邮件。')} action={<button className="button button--secondary button--small" onClick={() => setCredentials(selected)}>{t('配置凭据')}</button>} /> : messages.length ? <div className="icloud-message-list">{messages.map((message) => <button type="button" key={`${message.id}-${message.to}`} onClick={() => void openMessage(message)}><span>{(message.from || '?').slice(0, 1).toUpperCase()}</span><div><header><strong>{message.from || t('未知发件人')}</strong><time>{message.date ? new Date(message.date).toLocaleString() : ''}</time></header><h3>{message.subject || t('无主题')}</h3><p>{message.preview || t('暂无正文预览')}</p></div></button>)}</div> : <Empty icon={<Inbox />} title={t('暂无 iCloud 邮件')} description={t('最近 7 天没有找到邮件，或需要更新账号凭据。')} />}</section>
            </div>
          </>}
        </>
      )}
      {addOpen && <AddAccountModal onClose={() => setAddOpen(false)} onCreated={(account) => { setAccounts((items) => [...items, account]); setSelectedId(account.id); setNotice(t('iCloud 账号已添加')) }} />}
      {credentials && <CredentialsModal account={credentials} onClose={() => setCredentials(null)} onChanged={loadAccounts} onDeleted={async () => { await loadAccounts(); setAliases([]); setMessages([]) }} />}
      {opened && <MessageModal message={opened} loading={messageLoading} onClose={closeMessage} />}
      {notice && <div className="toast" role="status"><Check size={16} />{notice}</div>}
    </main>
  )
}
