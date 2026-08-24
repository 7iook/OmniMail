import {
  AlertCircle,
  ArrowLeft,
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, type GmailAccount } from '../lib/api'
import { errorMessage } from '../lib/errorMessage'
import { t } from '../lib/i18n'

type View = 'accounts' | 'guide' | 'connect' | 'password'

function statusLabel(account: GmailAccount): string {
  if (account.status === 'syncing') return t('正在同步')
  if (account.status === 'credential_error') return t('应用密码失效')
  if (account.status === 'error') return t('同步异常')
  return t('已连接')
}

function accountErrorLabel(code: string): string {
  if (code === 'authentication_failed') return t('应用专用密码无效，请更新后重试。')
  if (code === 'timeout') return t('连接 Gmail 超时，系统稍后会重试。')
  if (code === 'response_too_large') return t('Gmail 响应超过安全读取上限。')
  if (code === 'extension_unavailable') return t('当前账号缺少所需的 Gmail IMAP 扩展。')
  if (code === 'credential_key_unavailable') return t('Gmail 凭据加密密钥暂时不可用。')
  if (code === 'credential_decryption_failed') return t('已保存的 Gmail 凭据无法解密，请更新应用密码。')
  return t('暂时无法同步，系统稍后会重试。')
}

export function GmailAccountDialog({ accounts, accountLimit, startAdding = false, onClose, onChanged }: {
  accounts: GmailAccount[]
  accountLimit: number
  startAdding?: boolean
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const [view, setView] = useState<View>(accounts.length && !startAdding ? 'accounts' : 'guide')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [target, setTarget] = useState<GmailAccount | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  function clearFeedback() {
    setError('')
    setNotice('')
  }

  function openPassword(account: GmailAccount) {
    clearFeedback()
    setTarget(account)
    setPassword('')
    setView('password')
  }

  async function connect(event: FormEvent) {
    event.preventDefault()
    setBusy('connect')
    clearFeedback()
    try {
      await api.connectGmail({ name, email, appPassword: password })
      setName('')
      setEmail('')
      setPassword('')
      await onChanged()
      setNotice(t('Gmail 账号已连接，首次同步已进入队列。'))
      setView('accounts')
    } catch (connectError) {
      setError(errorMessage(connectError))
    } finally {
      setBusy('')
    }
  }

  async function updatePassword(event: FormEvent) {
    event.preventDefault()
    if (!target) return
    setBusy(`password:${target.id}`)
    clearFeedback()
    try {
      await api.updateGmailAppPassword(target.id, password)
      setPassword('')
      await onChanged()
      setNotice(t('应用专用密码已更新，旧凭据未在验证前被覆盖。'))
      setView('accounts')
    } catch (updateError) {
      setError(errorMessage(updateError))
    } finally {
      setBusy('')
    }
  }

  async function rename(account: GmailAccount) {
    setBusy(`rename:${account.id}`)
    clearFeedback()
    try {
      await api.renameGmail(account.id, renameValue)
      setRenaming(null)
      await onChanged()
      setNotice(t('账号名称已更新。'))
    } catch (renameError) {
      setError(errorMessage(renameError))
    } finally {
      setBusy('')
    }
  }

  async function verify(account: GmailAccount) {
    setBusy(`verify:${account.id}`)
    clearFeedback()
    try {
      await api.verifyGmail(account.id)
      await onChanged()
      setNotice(t('Gmail 连接验证成功。'))
    } catch (verifyError) {
      setError(errorMessage(verifyError))
      await onChanged()
    } finally {
      setBusy('')
    }
  }

  async function sync(account: GmailAccount) {
    setBusy(`sync:${account.id}`)
    clearFeedback()
    try {
      await api.syncGmail(account.id)
      setNotice(t('同步任务已加入队列。'))
    } catch (syncError) {
      setError(errorMessage(syncError))
    } finally {
      setBusy('')
    }
  }

  async function remove(account: GmailAccount) {
    setBusy(`delete:${account.id}`)
    clearFeedback()
    try {
      await api.disconnectGmail(account.id)
      setConfirmDelete(null)
      await onChanged()
      setNotice(t('本地连接和索引已删除；请继续在 Google 账号中撤销对应应用密码。'))
    } catch (deleteError) {
      setError(errorMessage(deleteError))
    } finally {
      setBusy('')
    }
  }

  const passwordForm = (submit: (event: FormEvent) => Promise<void>, label: string) => (
    <form className="gmail-connect-form" onSubmit={(event) => void submit(event)}>
      {view === 'connect' && <>
        <label htmlFor="gmail-account-name"><span>{t('账号名称')}</span>
          <input id="gmail-account-name" value={name} maxLength={60} required
            autoComplete="off" onChange={(event) => setName(event.target.value)}
            placeholder={t('例如：个人 Gmail')} /></label>
        <label htmlFor="gmail-account-email"><span>{t('邮箱地址')}</span>
          <input id="gmail-account-email" type="email" value={email} maxLength={254} required
            autoComplete="username" onChange={(event) => setEmail(event.target.value)}
            placeholder="name@gmail.com" /></label>
      </>}
      {view === 'password' && target && <div className="gmail-password-target">
        <strong>{target.name}</strong><span>{target.email}</span>
      </div>}
      <label htmlFor="gmail-app-password"><span>{t('16 位应用专用密码')}</span>
        <span className="gmail-password-input"><input id="gmail-app-password"
          type={passwordVisible ? 'text' : 'password'} value={password} required
          autoComplete="new-password" inputMode="text"
          aria-describedby="gmail-password-help"
          onChange={(event) => setPassword(event.target.value)}
          placeholder="abcd efgh ijkl mnop" />
          <button type="button" onClick={() => setPasswordVisible((visible) => !visible)}
            aria-label={t(passwordVisible ? '隐藏应用密码' : '显示应用密码')}>
            {passwordVisible ? <EyeOff size={17} /> : <Eye size={17} />}
          </button></span>
        <small id="gmail-password-help">{t('这不是 Google 账号主密码；可以直接粘贴带空格的分组格式。')}</small>
      </label>
      {error && <p className="inline-error" role="alert"><AlertCircle size={15} />{error}</p>}
      <button className="button button--primary" type="submit" disabled={Boolean(busy)}>
        {busy ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}{label}
      </button>
    </form>
  )

  return <div className="icloud-modal-backdrop is-visible gmail-dialog-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy) onClose()
  }}>
    <section className="icloud-modal gmail-account-dialog" role="dialog" aria-modal="true"
      aria-labelledby="gmail-dialog-title">
      <header>
        {view !== 'accounts' && accounts.length > 0 && <button className="icon-button" type="button"
          onClick={() => { clearFeedback(); setView('accounts') }} aria-label={t('返回账号列表')}>
          <ArrowLeft size={17} />
        </button>}
        <div><span className="eyebrow">GMAIL IMAP</span>
          <h2 id="gmail-dialog-title">{t(view === 'accounts' ? '管理 Gmail 账号'
            : view === 'guide' ? '创建应用专用密码'
              : view === 'password' ? '更新应用专用密码' : '连接 Gmail 账号')}</h2></div>
        <button ref={closeRef} className="icon-button" type="button" onClick={onClose}
          disabled={Boolean(busy)} aria-label={t('关闭')}><X size={17} /></button>
      </header>

      {view === 'guide' && <div className="gmail-guide">
        <div className="gmail-guide-symbol"><ShieldCheck size={25} /></div>
        <ol>
          <li><strong>{t('先开启 Google 两步验证')}</strong><span>{t('应用专用密码只对已启用两步验证的账号开放。')}</span></li>
          <li><strong>{t('创建名为 OmniMail 的应用密码')}</strong><span>{t('某些 Workspace 和 Advanced Protection 账号不支持。')}</span></li>
          <li><strong>{t('复制一次性显示的 16 位密码')}</strong><span>{t('凭据会加密保存在当前 OmniMail 部署中。')}</span></li>
        </ol>
        <a className="button button--secondary" href="https://myaccount.google.com/apppasswords"
          target="_blank" rel="noreferrer"><ExternalLink size={16} />{t('打开 Google 应用密码')}</a>
        <p><AlertCircle size={15} />{t('删除本地连接不会撤销 Google 端密码；断开后仍需返回该页面手动移除。')}</p>
        <button className="button button--primary" type="button" onClick={() => {
          clearFeedback(); setView('connect')
        }}>{t('我已准备好应用密码')}</button>
      </div>}

      {view === 'connect' && passwordForm(connect, t('验证并连接'))}
      {view === 'password' && passwordForm(updatePassword, t('验证并更新'))}

      {view === 'accounts' && <div className="gmail-account-list">
        <div className="gmail-account-list__summary">
          <span>{t('已连接 {count}/{limit} 个账号', { count: accounts.length, limit: accountLimit })}</span>
          <button className="button button--primary button--small" type="button"
            disabled={accounts.length >= accountLimit}
            onClick={() => { clearFeedback(); setView('guide') }}><Plus size={15} />{t('添加账号')}</button>
        </div>
        {notice && <p className="gmail-dialog-notice" role="status"><Check size={15} />{notice}</p>}
        {error && <p className="inline-error" role="alert"><AlertCircle size={15} />{error}</p>}
        {accounts.map((account) => <article className="gmail-account-card" key={account.id}>
          <div className="gmail-account-card__identity">
            <span>{account.name.slice(0, 1).toUpperCase()}</span>
            <div>{renaming === account.id ? <form onSubmit={(event) => {
              event.preventDefault(); void rename(account)
            }}><label className="sr-only" htmlFor={`gmail-rename-${account.id}`}>{t('账号名称')}</label>
              <input id={`gmail-rename-${account.id}`} value={renameValue} maxLength={60} required
                onChange={(event) => setRenameValue(event.target.value)} />
              <button type="submit" disabled={Boolean(busy)} aria-label={t('保存账号名称')}><Check size={15} /></button></form>
              : <strong>{account.name}</strong>}
              <small>{account.email}</small>
            </div>
            <em className={`is-${account.status}`}>{statusLabel(account)}</em>
          </div>
          {account.lastSyncedAt && <p>{t('最后同步：{time}', {
            time: new Date(account.lastSyncedAt * 1000).toLocaleString(),
          })}</p>}
          {account.lastErrorCode && <p className="gmail-account-error">{accountErrorLabel(account.lastErrorCode)}</p>}
          <div className="gmail-account-card__actions">
            <button type="button" onClick={() => {
              setRenaming(account.id); setRenameValue(account.name); clearFeedback()
            }}><Pencil size={14} />{t('重命名')}</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => void verify(account)}>
              {busy === `verify:${account.id}` ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />}{t('验证')}</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => void sync(account)}>
              {busy === `sync:${account.id}` ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{t('同步')}</button>
            <button type="button" onClick={() => openPassword(account)}><KeyRound size={14} />{t('更新密码')}</button>
            <button className="is-danger" type="button" onClick={() => setConfirmDelete(account.id)}>
              <Trash2 size={14} />{t('断开')}</button>
          </div>
          {confirmDelete === account.id && <div className="gmail-delete-confirm" role="alert">
            <p>{t('这会删除本地凭据和 Gmail 索引，但不会撤销 Google 端的应用密码。')}</p>
            <span><button type="button" onClick={() => setConfirmDelete(null)}>{t('取消')}</button>
              <button type="button" disabled={Boolean(busy)} onClick={() => void remove(account)}>
                {busy === `delete:${account.id}` && <LoaderCircle className="spin" size={14} />}{t('删除本地连接')}</button></span>
          </div>}
        </article>)}
      </div>}
    </section>
  </div>
}
