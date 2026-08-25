import {
  AlertCircle, ArrowLeft, Check, ChevronRight, KeyRound, LoaderCircle, Pencil,
  Plus, RefreshCw, ShieldCheck, Trash2, X,
} from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { api, type MicrosoftAccount, type MicrosoftAuthMode,
  type MicrosoftImportAccount, type MicrosoftImportResult } from '../../../shared/api'
import { errorMessage } from '../../../shared/api/errorMessage'
import { t } from '../../../shared/i18n'
import { MICROSOFT_IMPORT_ALTERNATE_FORMAT, MICROSOFT_IMPORT_FORMATS,
  parseMicrosoftImportText } from '../model/microsoft-import'
import type { MicrosoftImportMode } from '../model/microsoft-import'
import { MicrosoftAuthModeSelect } from './MicrosoftAuthModeSelect'
import { MicrosoftImportProgress,
  type MicrosoftImportProgressValue } from './MicrosoftImportProgress'

type View = 'accounts' | 'account' | 'connect'
type EntryMode = 'fields' | 'batch'
const importFormatLabels = ['完整组合', '仅密码', '仅 OAuth2'] as const
const importPlaceholder = [
  MICROSOFT_IMPORT_FORMATS[0], MICROSOFT_IMPORT_ALTERNATE_FORMAT,
  ...MICROSOFT_IMPORT_FORMATS.slice(1),
].join('\n')
function statusLabel(status: MicrosoftAccount['status']) {
  if (status === 'syncing') return t('正在同步')
  if (status === 'credential_error') return t('凭据失效')
  if (status === 'permission_error') return t('权限不足')
  if (status === 'error') return t('同步异常')
  if (status === 'pending_validation') return t('等待验证')
  return t('已连接')
}

function safeResultError(code?: string, message?: string) {
  if (message) return message
  if (code === 'duplicate') return t('账号已存在。')
  return t('账号验证失败，请检查凭据、权限和 IMAP 设置。')
}

function importModeLabel(mode: MicrosoftImportMode | null) {
  if (mode === 'password') return t('密码兼容 · 确认后加密保存')
  if (mode === 'oauth2_combination') return t('OAuth2 · 组合密码将丢弃')
  return mode === 'oauth2' ? 'OAuth2' : ''
}

export function MicrosoftAccountDialog({ accounts, startAdding = false, onClose, onChanged }: {
  accounts: MicrosoftAccount[]
  startAdding?: boolean
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const [view, setView] = useState<View>(accounts.length && !startAdding ? 'accounts' : 'connect')
  const [entryMode, setEntryMode] = useState<EntryMode>('fields')
  const [authMode, setAuthMode] = useState<MicrosoftAuthMode>('oauth2')
  const [target, setTarget] = useState<MicrosoftAccount | null>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [refreshToken, setRefreshToken] = useState('')
  const [clientId, setClientId] = useState('')
  const [authority, setAuthority] = useState('common')
  const [passwordConsent, setPasswordConsent] = useState(false)
  const [batchText, setBatchText] = useState('')
  const [renameValue, setRenameValue] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState('')
  const [importProgress, setImportProgress] = useState<MicrosoftImportProgressValue | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const errorRef = useRef<HTMLParagraphElement>(null)
  const busyRef = useRef(busy)
  const onCloseRef = useRef(onClose)
  busyRef.current = busy
  onCloseRef.current = onClose
  const batchRows = useMemo(() => parseMicrosoftImportText(batchText), [batchText])
  const readyRows = batchRows.filter(({ preview }) => preview.status === 'ready')
  const batchHasPasswords = readyRows.some(({ input }) => input.authMode === 'password')

  useEffect(() => { if (error) errorRef.current?.focus() }, [error])

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) onCloseRef.current()
      if (event.key !== 'Tab') return
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) || [])
      if (!controls.length) return
      const first = controls[0]
      const last = controls.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
      previousFocus?.focus()
    }
  }, [])

  function resetSecrets() {
    setPassword(''); setRefreshToken(''); setClientId(''); setPasswordConsent(false)
  }

  function openAccount(account: MicrosoftAccount) {
    setTarget(account); setRenameValue(account.name); setAuthority(account.authority || 'common')
    resetSecrets(); setError(''); setNotice(''); setConfirmDelete(false); setView('account')
  }

  async function importInputs(
    inputs: MicrosoftImportAccount[],
    reportProgress: boolean,
  ): Promise<MicrosoftImportResult[]> {
    if (!reportProgress) return (await api.importMicrosoftAccounts(inputs)).results
    const results: MicrosoftImportResult[] = []
    setImportProgress({ completed: 0, total: inputs.length })
    for (let index = 0; index < inputs.length; index += 1) {
      const response = await api.importMicrosoftAccounts([inputs[index]])
      const item = response.results[0] || {
        index: 0, status: 'error' as const, error: t('Microsoft 未返回账号验证结果。'),
      }
      results.push({ ...item, index })
      setImportProgress({ completed: index + 1, total: inputs.length })
    }
    return results
  }

  async function submitImport(
    inputs: MicrosoftImportAccount[],
    sourceLines?: number[],
    reportProgress = false,
  ) {
    setBusy('import'); setError(''); setNotice('')
    try {
      const results = await importInputs(inputs, reportProgress)
      const accepted = results.filter(({ status }) => status === 'accepted').length
      const failed = results.filter(({ status }) => status !== 'accepted')
      await onChanged()
      resetSecrets(); setBatchText('')
      if (failed.length) {
        setError(failed.map((item) => t('第 {line} 项：{error}', {
          line: sourceLines?.[item.index] ?? item.index + 1,
          error: safeResultError(item.code, item.error),
        })).join(' '))
      }
      if (accepted) setNotice(t('已安全连接 {count} 个 Microsoft 账号。', { count: accepted }))
      if (accepted && !failed.length) setView('accounts')
    } catch (submitError) {
      setError(errorMessage(submitError))
    } finally {
      setImportProgress(null); setBusy('')
    }
  }

  async function connect(event: FormEvent) {
    event.preventDefault()
    const input: MicrosoftImportAccount = authMode === 'oauth2'
      ? { name, email, authMode, refreshToken, clientId, authority }
      : { name, email, authMode, password, persistPasswordConfirmed: passwordConsent }
    await submitImport([input])
  }

  async function validatePasswordOnly() {
    if (!email.trim() || !password) {
      setError(t('请先填写邮箱地址和密码。'))
      return
    }
    setBusy('validate-password'); setError(''); setNotice('')
    try {
      await api.validateMicrosoftPassword(email, password)
      setPassword('')
      setNotice(t('密码兼容登录验证成功；密码未保存，后台同步账号也未创建。'))
    } catch (validationError) {
      setError(errorMessage(validationError))
    } finally { setBusy('') }
  }

  async function importBatch(event: FormEvent) {
    event.preventDefault()
    if (!readyRows.length) { setError(t('没有可导入的有效账号。')); return }
    if (readyRows.length > 25) { setError(t('每批最多导入 25 个账号。')); return }
    if (batchHasPasswords && !passwordConsent) {
      setError(t('请先确认允许加密保存密码兼容模式凭据。')); return
    }
    await submitImport(
      readyRows.map(({ input }) => input.authMode === 'password'
        ? { ...input, persistPasswordConfirmed: true } : input),
      readyRows.map(({ preview }) => preview.line),
      true,
    )
  }

  async function rename(event: FormEvent) {
    event.preventDefault(); if (!target) return
    setBusy('rename'); setError('')
    try {
      const result = await api.renameMicrosoft(target.id, renameValue)
      setTarget(result.account); await onChanged(); setNotice(t('账号备注已保存。'))
    } catch (renameError) { setError(errorMessage(renameError)) } finally { setBusy('') }
  }

  async function verify() {
    if (!target) return
    setBusy('verify'); setError('')
    try { await api.verifyMicrosoft(target.id); await onChanged(); setNotice(t('Microsoft IMAP 连接有效。')) }
    catch (verifyError) { setError(errorMessage(verifyError)); await onChanged() }
    finally { setBusy('') }
  }

  async function sync() {
    if (!target) return
    setBusy('sync'); setError('')
    try { await api.syncMicrosoft(target.id); setNotice(t('Microsoft 同步任务已加入队列。')) }
    catch (syncError) { setError(errorMessage(syncError)) } finally { setBusy('') }
  }

  async function updateCredential(event: FormEvent) {
    event.preventDefault(); if (!target) return
    if (target.authMode === 'password' && !passwordConsent) {
      setError(t('请先确认允许加密保存密码兼容模式凭据。')); return
    }
    setBusy('credential'); setError('')
    try {
      await api.updateMicrosoftCredential(target.id, target.authMode === 'oauth2'
        ? { authMode: 'oauth2', refreshToken, clientId, authority }
        : { authMode: 'password', password, persistPasswordConfirmed: true })
      resetSecrets(); await onChanged(); setNotice(t('凭据验证成功并已更新。'))
    } catch (credentialError) { setError(errorMessage(credentialError)); await onChanged() }
    finally { setBusy('') }
  }

  async function remove() {
    if (!target) return
    setBusy('delete'); setError('')
    try {
      const result = await api.disconnectMicrosoft(target.id)
      await onChanged(); setTarget(null); setView('accounts')
      setNotice(result.remoteRevocationRequired
        ? t('账号已断开；请同时在 Microsoft 账户中撤销应用授权。')
        : t('账号和本地索引已删除。'))
    } catch (removeError) { setError(errorMessage(removeError)) } finally { setBusy('') }
  }

  const title = view === 'accounts' ? t('Microsoft 账号管理')
    : view === 'account' ? t('设置 {name}', { name: target?.name || 'Microsoft' })
      : t('连接 Microsoft 邮箱')
  const canGoBack = view === 'account' || (view === 'connect' && accounts.length > 0)

  return <div className="icloud-modal-backdrop gmail-dialog-backdrop microsoft-dialog-backdrop is-visible"
    role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section ref={dialogRef} className="icloud-modal gmail-account-dialog microsoft-account-dialog"
      role="dialog" aria-modal="true" aria-busy={Boolean(busy)} aria-labelledby={titleId}
      aria-describedby={descriptionId}>
      <header className={canGoBack ? 'has-back' : ''}>
        {canGoBack && <button className="icon-button gmail-dialog-back" type="button"
          disabled={Boolean(busy)} onClick={() => { setError(''); setNotice(''); setView('accounts') }}
          aria-label={t('返回')}><ArrowLeft size={17} /></button>}
        <div><p className="eyebrow">MICROSOFT · IMAP</p><h2 id={titleId}>{title}</h2>
          <p id={descriptionId}>{t('只读访问；凭据仅在服务端加密保存。')}</p></div>
        <button ref={closeRef} className="icon-button" type="button" disabled={Boolean(busy)}
          onClick={onClose} aria-label={t('关闭')}><X size={17} /></button>
      </header>

      {(notice || error) && <div className="gmail-dialog-feedback">
        {notice && <p className="gmail-dialog-notice" role="status"><Check size={15} />{notice}</p>}
        {error && <p ref={errorRef} className="inline-error" role="alert" tabIndex={-1}><AlertCircle size={15} />{error}</p>}
      </div>}

      {view === 'connect' && <>
        <div className="microsoft-entry-tabs" role="tablist" aria-label={t('录入方式')}>
          <button type="button" role="tab" aria-selected={entryMode === 'fields'}
            disabled={Boolean(busy)}
            onClick={() => setEntryMode('fields')}>{t('分字段录入')}</button>
          <button type="button" role="tab" aria-selected={entryMode === 'batch'}
            disabled={Boolean(busy)}
            onClick={() => setEntryMode('batch')}>{t('批量导入')}</button>
        </div>
        {entryMode === 'fields' ? <form className="icloud-form gmail-connect-form"
          onSubmit={(event) => void connect(event)}>
          <div className="icloud-form-field"><span>{t('认证方式')}</span>
            <MicrosoftAuthModeSelect value={authMode}
              onChange={(nextMode) => { setAuthMode(nextMode); resetSecrets() }} />
          </div>
          <label><span>{t('账号名称')}</span><input value={name} maxLength={60} required
            autoComplete="off" onChange={(event) => setName(event.target.value)} /></label>
          <label><span>{t('邮箱地址')}</span><input type="email" value={email} maxLength={254}
            required autoComplete="username" onChange={(event) => setEmail(event.target.value)} /></label>
          {authMode === 'oauth2' ? <>
            <label><span>Refresh token</span><input type="password" value={refreshToken} required
              autoComplete="off" onChange={(event) => setRefreshToken(event.target.value)} /></label>
            <label><span>Client ID</span><input value={clientId} required autoComplete="off"
              placeholder="00000000-0000-0000-0000-000000000000"
              onChange={(event) => setClientId(event.target.value)} /></label>
            <label><span>Authority</span><input value={authority} required autoComplete="off"
              aria-describedby="microsoft-authority-help"
              onChange={(event) => setAuthority(event.target.value)} />
              <small id="microsoft-authority-help">common / organizations / consumers / tenant UUID</small></label>
          </> : <PasswordFields password={password} consent={passwordConsent}
            onPassword={setPassword} onConsent={setPasswordConsent} />}
          <footer className="gmail-connect-actions">
            {authMode === 'password' && <button className="button button--secondary" type="button"
              disabled={Boolean(busy)} onClick={() => void validatePasswordOnly()}>
              {busy === 'validate-password' ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
              {t('仅验证，不保存')}</button>}
            <button className="button button--primary"
            type="submit" disabled={Boolean(busy)}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
            {t('验证并连接')}</button></footer>
        </form> : <form className="icloud-form microsoft-batch-form"
          onSubmit={(event) => void importBatch(event)}>
          <label><span>{t('每行一个账号')}</span><textarea value={batchText} rows={7}
            disabled={Boolean(busy)} spellCheck={false} autoComplete="off"
            aria-describedby="microsoft-import-formats"
            onChange={(event) => setBatchText(event.target.value)}
            placeholder={importPlaceholder} /></label>
          <div className="microsoft-import-formats" id="microsoft-import-formats">
            <strong>{t('支持以下三种凭据类型（四字段兼容两种顺序）：')}</strong>
            <ul>{MICROSOFT_IMPORT_FORMATS.map((format, index) => <li key={format}>
              <span>{t(importFormatLabels[index])}</span><code>{format}</code>
            </li>)}<li><span>{t('兼容顺序')}</span><code>{MICROSOFT_IMPORT_ALTERNATE_FORMAT}</code></li></ul>
            <small>{t('最后两段可互换，系统按 UUID 自动识别 Client ID。完整组合优先使用 OAuth2，password 不上传也不保存；连续 8 个连字符表示 password 为空。')}</small>
          </div>
          {importProgress && <MicrosoftImportProgress progress={importProgress} />}
          {batchRows.length > 0 && <div className="microsoft-import-preview">
            <h3>{t('安全预览')}</h3><p>{t('预览不会显示密码、refresh token 或完整 Client ID。')}</p>
            <ul>{batchRows.map(({ preview }) => <li key={preview.line}
              className={`is-${preview.status}`}><span>{preview.line}</span><strong>{preview.email || t('无效邮箱')}</strong>
              <small>{preview.error || `${importModeLabel(preview.mode)}${preview.clientIdMasked ? ` · ${preview.clientIdMasked}` : ''}`}</small></li>)}</ul>
          </div>}
          {batchHasPasswords && <Consent checked={passwordConsent} onChange={setPasswordConsent} />}
          <footer><button className="button button--primary" type="submit"
            disabled={Boolean(busy) || !readyRows.length}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
            {importProgress
              ? t('正在验证 {completed}/{total}', importProgress)
              : t('验证并导入 {count} 个账号', { count: readyRows.length })}</button></footer>
        </form>}
      </>}

      {view === 'accounts' && <div className="gmail-account-list">
        <div className="gmail-account-list__summary"><span>{t('已连接 {count} 个账号', { count: accounts.length })}</span>
          <button className="button button--primary button--small" type="button"
            onClick={() => { setError(''); setNotice(''); setView('connect') }}><Plus size={15} />{t('添加账号')}</button></div>
        {accounts.map((account) => <button className="gmail-account-card" type="button"
          key={account.id} onClick={() => openAccount(account)}>
          <span className="gmail-account-card__icon">M</span>
          <span className="gmail-account-card__content"><strong>{account.name}</strong><small>{account.email}</small>
            <small>{account.authMode === 'oauth2' ? `OAuth2 · ${account.clientIdMasked}` : t('密码兼容模式')}</small></span>
          <span className="gmail-account-card__side"><em className={`is-${account.status}`}>{statusLabel(account.status)}</em>
            <span>{t('管理')}<ChevronRight size={14} /></span></span>
        </button>)}
      </div>}

      {view === 'account' && target && <div className="gmail-account-settings">
        <div className="gmail-account-summary"><span className="gmail-account-summary__icon"><KeyRound size={18} /></span>
          <span><strong>{target.email}</strong><small>{target.authMode === 'oauth2' ? `OAuth2 · ${target.clientIdMasked}` : t('密码兼容模式')}</small></span>
          <em className={`is-${target.status}`}>{statusLabel(target.status)}</em></div>
        {target.lastErrorCode && <p className="gmail-account-detail-error"><AlertCircle size={15} />
          {t('最近错误：{code}', { code: target.lastErrorCode })}</p>}
        <form className="icloud-form gmail-account-rename" onSubmit={(event) => void rename(event)}>
          <div className="gmail-account-section-heading"><span className="gmail-account-section-icon"><Pencil size={16} /></span>
            <span><strong>{t('备注名称')}</strong><small>{t('只用于 OmniMail 内区分账号。')}</small></span></div>
          <label><span>{t('账号名称')}</span><span className="gmail-account-rename__field">
            <input value={renameValue} required maxLength={60} onChange={(event) => setRenameValue(event.target.value)} />
            <button className="button button--secondary" type="submit" disabled={Boolean(busy)}><Check size={15} />{t('保存备注')}</button>
          </span></label>
        </form>
        <section className="gmail-account-action"><span><strong>{t('验证邮箱连接')}</strong>
          <small>{t('检查当前凭据与 Microsoft IMAP 权限。')}</small></span>
          <button className="button button--secondary" type="button" disabled={Boolean(busy)} onClick={() => void verify()}>
            {busy === 'verify' ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}{t('立即验证')}</button></section>
        <section className="gmail-account-action"><span><strong>{t('同步这个账号')}</strong>
          <small>{t('将 INBOX 增量同步任务加入队列。')}</small></span>
          <button className="button button--secondary" type="button" disabled={Boolean(busy)} onClick={() => void sync()}>
            {busy === 'sync' ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}{t('立即同步')}</button></section>
        <form className="icloud-form gmail-account-credential" onSubmit={(event) => void updateCredential(event)}>
          <div className="gmail-account-section-heading"><span className="gmail-account-section-icon"><KeyRound size={16} /></span>
            <span><strong>{t('替换凭据')}</strong><small>{t('只有远程验证成功后才会替换原密文。')}</small></span></div>
          {target.authMode === 'oauth2' ? <>
            <label><span>Refresh token</span><input type="password" value={refreshToken} required
              autoComplete="off" onChange={(event) => setRefreshToken(event.target.value)} /></label>
            <label><span>Client ID</span><input value={clientId} required autoComplete="off"
              onChange={(event) => setClientId(event.target.value)} /></label>
            <label><span>Authority</span><input value={authority} required autoComplete="off"
              onChange={(event) => setAuthority(event.target.value)} /></label>
          </> : <PasswordFields password={password} consent={passwordConsent}
            onPassword={setPassword} onConsent={setPasswordConsent} />}
          <footer><button className="button button--primary" type="submit" disabled={Boolean(busy)}>
            {busy === 'credential' ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}
            {t('验证并更新')}</button></footer>
        </form>
        <div className="gmail-account-danger"><span><strong>{t('断开这个 Microsoft 账号')}</strong>
          <small>{t('删除本地密文与索引，不会删除服务器邮件。')}</small></span>
          <button className="button icloud-danger-button" type="button" disabled={Boolean(busy)}
            onClick={() => setConfirmDelete(true)}><Trash2 size={16} />{t('断开账号')}</button></div>
        {confirmDelete && <div className="gmail-delete-confirm" role="alert"><p>
          {t(target.authMode === 'oauth2' ? '确认断开？之后还应在 Microsoft 账户中撤销应用授权。' : '确认断开并删除本地加密凭据？')}</p>
          <span><button className="button button--secondary" type="button" onClick={() => setConfirmDelete(false)}>{t('取消')}</button>
            <button className="button icloud-danger-button" type="button" onClick={() => void remove()}>{t('确认断开')}</button></span></div>}
      </div>}
    </section>
  </div>
}

function Consent({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="microsoft-password-consent"><input type="checkbox" checked={checked}
    onChange={(event) => onChange(event.target.checked)} /><span>{t('我确认这是兼容方案，并允许服务端加密保存该密码。')}</span></label>
}

function PasswordFields({ password, consent, onPassword, onConsent }: {
  password: string
  consent: boolean
  onPassword: (value: string) => void
  onConsent: (value: boolean) => void
}) {
  return <><label><span>{t('邮箱密码')}</span><input type="password" value={password} required
    autoComplete="new-password" onChange={(event) => onPassword(event.target.value)} />
    <small>{t('仅用于兼容仍允许基础认证的租户；优先使用 OAuth2。')}</small></label>
    <Consent checked={consent} onChange={onConsent} /></>
}
