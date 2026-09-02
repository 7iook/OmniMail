import {
  AlertCircle, Check, Copy, LoaderCircle, Plus, RefreshCw, Search, Settings2, ShieldCheck, X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type MicrosoftAccount, type MicrosoftFolder, type MicrosoftMessageDetail,
  type MicrosoftMessageSummary, type PageInfo } from '../../../shared/api'
import { errorMessage } from '../../../shared/api/errorMessage'
import { t } from '../../../shared/i18n'
import { notificationDeepLink } from '../../../shared/mail/notificationDeepLink'
import { ListScrollTopHeading } from '../../../shared/ui/mail-workspace/ListScrollTopHeading'
import { useMailListScroll } from '../../../shared/ui/mail-workspace/hooks/useMailListScroll'
import { useAutoRefresh } from '../../../shared/hooks/useAutoRefresh'
import '../../../shared/ui/mail-workspace/styles/workspace.css'
import '../../gmail/styles/gmail-dialog.css'
import '../../gmail/styles/gmail-workspace.css'
import '../styles/microsoft-workspace.css'
import { MicrosoftAccountDialog } from './MicrosoftAccountDialog'
import { MicrosoftMessageList } from './MicrosoftMessageList'
import { MicrosoftReader } from './MicrosoftReader'
import { MicrosoftScopeSwitcher } from './MicrosoftScopeSwitcher'

/** Card §12.1/§12.7: pinned regardless of the admin's global `mailRefreshInterval`. */
const MICROSOFT_POLL_SECONDS = 5
const emptyPage: PageInfo = { hasMore: false, nextCursor: null, limit: 50 }

export function accountWarning(accounts: MicrosoftAccount[]): string {
  const failed = accounts.filter(({ status }) => ['credential_error', 'permission_error', 'error'].includes(status))
  return failed.length ? t('{count} 个 Microsoft 账号需要处理，其他账号仍可继续使用。', {
    count: failed.length,
  }) : ''
}

export function pushDegradedNotice(accounts: MicrosoftAccount[]): string {
  return accounts.some(({ pushStatus }) => pushStatus === 'degraded')
    ? t('实时推送暂不可用，正在按 5 分钟同步')
    : ''
}

/**
 * §12.7 Q2/A1: the page polls on a fixed cadence regardless of the admin's
 * global `mailRefreshInterval` — EXCEPT that an explicit `0` (admin turned
 * auto-refresh off entirely) also disables the Microsoft page's own polling.
 */
export function microsoftPollingEnabled(workspaceEnabled: boolean, mailRefreshInterval: number): boolean {
  return workspaceEnabled && mailRefreshInterval !== 0
}

export function autoRefreshOffNotice(workspaceEnabled: boolean, mailRefreshInterval: number): string {
  return workspaceEnabled && mailRefreshInterval === 0 ? t('自动刷新已关闭') : ''
}

export function MicrosoftWorkspace({ enabled, remoteImagesEnabled, mailRefreshInterval }: {
  enabled: boolean
  remoteImagesEnabled: boolean
  mailRefreshInterval: number
}) {
  const mailListScroll = useMailListScroll()
  const pendingDeepLink = useRef(notificationDeepLink('microsoft'))
  const [accounts, setAccounts] = useState<MicrosoftAccount[]>([])
  const [accountId, setAccountId] = useState(pendingDeepLink.current?.accountId || '')
  const [folders, setFolders] = useState<MicrosoftFolder[]>([])
  const [folderPath, setFolderPath] = useState('INBOX')
  const [limit, setLimit] = useState(50)
  const [query, setQuery] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [messages, setMessages] = useState<MicrosoftMessageSummary[]>([])
  const [page, setPage] = useState<PageInfo>(emptyPage)
  const [selected, setSelected] = useState<MicrosoftMessageSummary | null>(null)
  const [detail, setDetail] = useState<MicrosoftMessageDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [remoteRefreshing, setRemoteRefreshing] = useState(false)
  const [folderRefreshing, setFolderRefreshing] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [dialogMode, setDialogMode] = useState<'add' | 'manage' | null>(null)
  const [error, setError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [notice, setNotice] = useState('')
  const listController = useRef<AbortController | null>(null)
  const listRequestId = useRef(0)
  const messageController = useRef<AbortController | null>(null)
  const manageButton = useRef<HTMLButtonElement>(null)
  const currentAccount = accounts.find(({ id }) => id === accountId)
  const copyAccount = currentAccount || accounts[0]

  const loadAccounts = useCallback(async () => {
    if (!enabled) { setAccounts([]); return [] }
    const result = await api.microsoftAccounts()
    setAccounts(result.accounts)
    setAccountId((current) => current && !result.accounts.some(({ id }) => id === current) ? '' : current)
    return result.accounts
  }, [enabled])

  const loadFolders = useCallback(async (refresh = false) => {
    if (!enabled || !accountId) { setFolders([]); setFolderPath('INBOX'); return }
    if (refresh) setFolderRefreshing(true)
    try {
      const result = await api.microsoftFolders(accountId, refresh)
      setFolders(result.folders)
      setFolderPath((current) => result.folders.some(({ path }) => path === current)
        ? current : result.folders.find(({ path }) => path.toUpperCase() === 'INBOX')?.path || 'INBOX')
      if (refresh) setNotice(t('文件夹列表已从 Microsoft 刷新。'))
    } catch (loadError) {
      setError(errorMessage(loadError))
    } finally { if (refresh) setFolderRefreshing(false) }
  }, [accountId, enabled])

  const loadMessages = useCallback(async (quiet = false, refresh = false) => {
    if (!enabled) { setLoading(false); setMessages([]); return }
    listController.current?.abort()
    const controller = new AbortController()
    listController.current = controller
    const requestId = ++listRequestId.current
    if (!quiet) setLoading(true)
    if (refresh) setRemoteRefreshing(true)
    setError('')
    try {
      const result = await api.microsoftMessages({
        accountId: accountId || undefined,
        folder: accountId ? folderPath : undefined,
        limit,
        query: searchQuery,
        refresh,
        signal: controller.signal,
      })
      if (requestId !== listRequestId.current) return
      setMessages(result.messages); setPage(result.page)
      setSelected((current) => current && result.messages.some(({ id }) => id === current.id) ? current : null)
      if (refresh) setNotice(t('已按只读模式刷新当前 Microsoft 文件夹。'))
    } catch (loadError) {
      if (!controller.signal.aborted && requestId === listRequestId.current) setError(errorMessage(loadError))
    } finally {
      if (!quiet && requestId === listRequestId.current) setLoading(false)
      if (refresh && requestId === listRequestId.current) setRemoteRefreshing(false)
    }
  }, [accountId, enabled, folderPath, limit, searchQuery])

  const refresh = useCallback(async () => {
    try { await loadAccounts(); await loadFolders(); await loadMessages(true) }
    catch (refreshError) { setError(errorMessage(refreshError)) }
  }, [loadAccounts, loadFolders, loadMessages])

  useEffect(() => { void loadAccounts().catch((loadError) => setError(errorMessage(loadError))) }, [loadAccounts])
  useEffect(() => { void loadFolders() }, [loadFolders])
  useEffect(() => { void loadMessages() }, [loadMessages])
  // §12.1/§12.7: local-D1-only, quiet reload — never `refresh=1` (that would hit
  // Microsoft itself). Reuses the shared hook's leader-tab/visibility gating but
  // with a fixed interval and `adaptive=false`, since the global setting's
  // backoff cannot promise the ≤5s SLA this page committed to.
  const pollMessages = useCallback(() => loadMessages(true), [loadMessages])
  useAutoRefresh(
    MICROSOFT_POLL_SECONDS, pollMessages,
    microsoftPollingEnabled(enabled, mailRefreshInterval), false,
  )
  useEffect(() => {
    const link = pendingDeepLink.current
    const message = link && messages.find(({ id, account }) => (
      id === link.messageId && (!link.accountId || account.id === link.accountId)
    ))
    if (!message) return
    pendingDeepLink.current = null
    void selectMessage(message)
  }, [messages])
  useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(query.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [query])
  useEffect(() => {
    messageController.current?.abort(); setSelected(null); setDetail(null); setDetailError('')
  }, [accountId, folderPath, searchQuery])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 4_000)
    return () => window.clearTimeout(timer)
  }, [notice])
  useEffect(() => () => {
    listController.current?.abort(); listRequestId.current += 1; messageController.current?.abort()
  }, [])

  async function selectMessage(message: MicrosoftMessageSummary) {
    messageController.current?.abort()
    const controller = new AbortController(); messageController.current = controller
    setSelected(message); setDetail(null); setDetailError(''); setDetailLoading(true)
    try {
      const result = await api.microsoftMessage(message.account.id, message.id, controller.signal)
      if (!controller.signal.aborted) {
        setDetail(result.message)
        setMessages((items) => items.map((item) => item.id === message.id
          ? { ...item, isRead: result.message.isRead }
          : item))
        setSelected((current) => current?.id === message.id
          ? { ...current, isRead: result.message.isRead }
          : current)
      }
    } catch (loadError) {
      if (!controller.signal.aborted) setDetailError(errorMessage(loadError))
    } finally { if (!controller.signal.aborted) setDetailLoading(false) }
  }

  async function loadMore() {
    if (!page.hasMore || !page.nextCursor || loadingMore) return
    setLoadingMore(true); setError('')
    try {
      const result = await api.microsoftMessages({
        accountId: accountId || undefined, folder: accountId ? folderPath : undefined,
        limit, cursor: page.nextCursor, query: searchQuery,
      })
      setMessages((current) => {
        const ids = new Set(current.map(({ id }) => id))
        return [...current, ...result.messages.filter(({ id }) => !ids.has(id))]
      })
      setPage(result.page)
    } catch (loadError) { setError(errorMessage(loadError)) } finally { setLoadingMore(false) }
  }

  async function copyAddress(address = copyAccount?.email || ''): Promise<boolean> {
    if (!address) return false
    try {
      await navigator.clipboard.writeText(address)
      setError(''); setNotice(t('已复制：{address}', { address }))
      return true
    } catch {
      setNotice(''); setError(t('无法访问剪贴板，请手动复制邮箱地址。'))
      return false
    }
  }

  async function syncScope() {
    if (!accounts.length || remoteRefreshing) return
    if (currentAccount) { await loadMessages(false, true); return }
    setRemoteRefreshing(true); setError(''); setNotice('')
    try {
      await Promise.all(accounts.map(({ id }) => api.syncMicrosoft(id)))
      setNotice(t('已将 {count} 个 Microsoft 账号加入同步队列。', { count: accounts.length }))
    } catch (syncError) { setError(errorMessage(syncError)) }
    finally { setRemoteRefreshing(false) }
  }

  function chooseAccount(next: string) {
    setAccountId(next); setFolderPath('INBOX'); setSelected(null); setDetail(null); setDetailError('')
  }

  function closeDialog() {
    setDialogMode(null); window.requestAnimationFrame(() => manageButton.current?.focus())
  }

  return <div className={`icloud-mail-view gmail-workspace gmail-mail-view microsoft-workspace${selected ? ' has-selection' : ''}`}>
    <section ref={mailListScroll.listPane} className="list-pane icloud-list-pane page-content-enter gmail-list-pane microsoft-list-pane">
      <header className="list-header icloud-list-header gmail-list-header">
        <div>{accounts.length ? <MicrosoftScopeSwitcher accounts={accounts} folders={folders}
          selectedAccountId={accountId} selectedFolderPath={folderPath} limit={limit}
          folderRefreshing={folderRefreshing} onAccountChange={chooseAccount}
          onFolderChange={setFolderPath} onLimitChange={setLimit}
          onRefreshFolders={() => loadFolders(true)} onCopyAddress={copyAddress}
          onManage={() => setDialogMode('manage')} />
          : <p className="eyebrow">MICROSOFT · MAIL</p>}
          <ListScrollTopHeading title="Microsoft" onScrollTop={mailListScroll.scrollToTop} /></div>
        {enabled && <div className="list-header__actions">
          {accounts.length > 0 && <span className="icloud-mail-status is-imap"><ShieldCheck size={13} />{t('只读同步')}</span>}
          <div className="icloud-header-action-buttons">
            <button className="icon-button" type="button" onClick={() => setDialogMode('add')}
              aria-label={t('添加 Microsoft 账号')} data-tooltip={t('添加 Microsoft 账号')}><Plus size={17} /></button>
            <button className="icon-button" type="button" disabled={!copyAccount} onClick={() => void copyAddress()}
              aria-label={`${t('复制当前邮箱')} ${copyAccount?.email || ''}`}
              data-tooltip={`${t('复制当前邮箱')} ${copyAccount?.email || ''}`}><Copy size={17} /></button>
            <button ref={manageButton} className="icon-button" type="button" onClick={() => setDialogMode('manage')}
              aria-label={t('管理 Microsoft 账号')} data-tooltip={t('管理 Microsoft 账号')}><Settings2 size={17} /></button>
            <button className="icon-button" type="button" disabled={!accounts.length || remoteRefreshing}
              onClick={() => void syncScope()}
              aria-label={t(accountId ? '远程刷新当前文件夹' : '同步全部 Microsoft 账号')}
              data-tooltip={t(accountId ? '远程刷新当前文件夹' : '同步全部 Microsoft 账号')}>
              {remoteRefreshing ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}</button>
          </div>
        </div>}
      </header>
      {enabled && accounts.length > 0 && <label
        className="search-field icloud-search-field microsoft-search-field" aria-busy={remoteRefreshing}>
        {remoteRefreshing ? <LoaderCircle className="spin" size={17} /> : <Search size={17} />}
        <span className="sr-only">{t('搜索 Microsoft 邮件')}</span><input type="search" value={query}
          maxLength={120} autoComplete="off" placeholder={t('搜索发件人、收件人或主题')}
          onChange={(event) => setQuery(event.target.value)} />
        {query && <button type="button" onClick={() => setQuery('')} aria-label={t('清除搜索')}>
          <X size={14} /></button>}</label>}
      {accountWarning(accounts) && <p className="gmail-partial-error" role="status"><AlertCircle size={15} />{accountWarning(accounts)}</p>}
      {pushDegradedNotice(accounts) && <p className="gmail-partial-error" role="status"><AlertCircle size={15} />{pushDegradedNotice(accounts)}</p>}
      {autoRefreshOffNotice(enabled, mailRefreshInterval) && <p className="microsoft-scope-note">
        {autoRefreshOffNotice(enabled, mailRefreshInterval)}</p>}
      {error && <p className="list-error" role="alert"><AlertCircle size={15} />{error}</p>}
      <MicrosoftMessageList enabled={enabled} loading={loading} accounts={accounts} accountId={accountId}
        searchQuery={searchQuery} messages={messages} selectedId={selected?.id ?? null} page={page}
        loadingMore={loadingMore} onSelect={(message) => void selectMessage(message)}
        onLoadMore={() => void loadMore()} onAddAccount={() => setDialogMode('add')} />
    </section>
    <main className="reader-pane icloud-reader-pane gmail-reader-pane"><MicrosoftReader selected={selected}
      message={detail} loading={detailLoading} error={detailError} remoteImagesEnabled={remoteImagesEnabled}
      onBack={() => { setSelected(null); setDetail(null); setDetailError('') }}
      onRetry={() => selected && void selectMessage(selected)} /></main>
    {dialogMode && <MicrosoftAccountDialog accounts={accounts} startAdding={dialogMode === 'add'}
      onClose={closeDialog} onChanged={refresh} />}
    {notice && <div className="toast" role="status"><Check size={16} />{notice}</div>}
  </div>
}
