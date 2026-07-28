import {
  AlertCircle,
  Check,
  Search,
  X,
} from 'lucide-react'
import { useCallback, useDeferredValue, useEffect, useState } from 'react'
import {
  ConnectionError,
  PageLoader,
  PublicLanding,
  SetupPage,
} from './components/AuthPages'
import { AdminWorkspace } from './components/AdminWorkspace'
import { DelayedScrollbar } from './components/DelayedScrollbar'
import { DeploymentWizard } from './components/DeploymentWizard'
import { type AdminView, folderLabel, MailboxSidebar } from './components/MailboxSidebar'
import { MailboxSwitcher } from './components/MailboxSwitcher'
import { MailboxHeaderActions } from './components/MailboxHeaderActions'
import { MessageList } from './components/MessageList'
import { MessageReader } from './components/MessageReader'
import { TemporaryInvitePage } from './components/TemporaryInvitePage'
import {
  api,
  ApiError,
  type AppConfig,
  type Folder,
  type ManagedDomain,
  type MailboxAddress,
  type MailCounts,
  type MailboxScope,
  type MessageDetail,
  type MessageSummary,
  type PageInfo,
  type User,
} from './lib/api'
import { isAdminRole } from './lib/roles'
import { deploymentGuideUnseen, markDeploymentGuideSeen } from './lib/deploymentGuide'
import { useAutoRefresh } from './lib/useAutoRefresh'
import { openingSplashDelay } from './lib/initialSplash'
import { t, useLocale } from './lib/i18n'
import { bulkMessages, type BulkMessageAction } from './lib/messageActions'
const emptyCounts: MailCounts = { unread: 0, starred: 0, sent: 0, trash: 0 }
const emptyPage: PageInfo = { hasMore: false, nextCursor: null, limit: 30 }

export function shouldQuietRefreshFolder(current: Folder, next: Folder, query: string) {
  return current === next && query.trim() === ''
}

function errorMessage(error: unknown): string {
  return t(error instanceof Error ? error.message : '发生了未知错误。')
}

function Mailbox({
  user,
  config,
  onConfigChange,
  onUserChange,
  onLogout,
}: {
  user: User
  config: AppConfig
  onConfigChange: (config: AppConfig) => void
  onUserChange: (user: User) => void
  onLogout: () => Promise<void>
}) {
  const [folder, setFolder] = useState<Folder>('inbox')
  const [adminView, setAdminView] = useState<AdminView | null>(null)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim())
  const [messages, setMessages] = useState<MessageSummary[]>([])
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set())
  const [messageVersion, setMessageVersion] = useState<number>()
  const [messagePage, setMessagePage] = useState<PageInfo>(emptyPage)
  const [mailboxes, setMailboxes] = useState<MailboxAddress[]>([])
  const [domains, setDomains] = useState<ManagedDomain[]>([])
  const [scope, setScope] = useState<MailboxScope>({ type: 'all' })
  const [counts, setCounts] = useState<MailCounts>(emptyCounts)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<MessageDetail | null>(null)
  const [thread, setThread] = useState<MessageSummary[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [bulkLoading, setBulkLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [deploymentWizardOpen, setDeploymentWizardOpen] = useState(
    () => deploymentGuideUnseen(user),
  )

  function closeDeploymentWizard() {
    markDeploymentGuideSeen()
    setDeploymentWizardOpen(false)
  }

  const loadMailboxes = useCallback(async () => {
    try {
      const result = await api.mailboxes()
      setMailboxes(result.mailboxes)
      setScope((current) => {
        if (current.type === 'all') return current
        const active = result.mailboxes.filter((mailbox) => mailbox.isActive)
        const available = current.type === 'mailbox'
          ? active.some((mailbox) => mailbox.address === current.value)
          : active.some((mailbox) => mailbox.domain === current.value)
        return available ? current : { type: 'all' }
      })
    } catch (loadError) {
      if (loadError instanceof ApiError && loadError.status === 401) {
        await onLogout()
        return
      }
      setError(errorMessage(loadError))
    }
  }, [onLogout])

  const loadDomains = useCallback(async () => {
    try {
      const result = await api.domains()
      setDomains(result.domains)
    } catch (loadError) {
      if (loadError instanceof ApiError && loadError.status === 401) {
        await onLogout()
        return
      }
      setError(errorMessage(loadError))
    }
  }, [onLogout])

  const loadMailboxData = useCallback(async () => {
    await Promise.all([loadMailboxes(), loadDomains()])
  }, [loadDomains, loadMailboxes])

  const loadMessages = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true)
    else setListLoading(true)
    setError('')
    try {
      const result = await api.messages(
        folder, deferredQuery, scope, undefined, quiet ? messageVersion : undefined,
      )
      if (result.unchanged) return false
      setMessageVersion(result.version)
      setMessages(result.messages)
      setSelectedMessageIds((current) => new Set(
        [...current].filter((id) => result.messages.some((message) => message.id === id)),
      ))
      setMessagePage(result.page)
      setCounts(result.counts)
      if (selectedId && !result.messages.some((message) => message.id === selectedId)) {
        setSelectedId(null)
        setDetail(null)
        setThread([])
      }
    } catch (loadError) {
      if (loadError instanceof ApiError && loadError.status === 401) {
        await onLogout()
        return
      }
      setError(errorMessage(loadError))
    } finally {
      setListLoading(false)
      setRefreshing(false)
    }
  }, [deferredQuery, folder, messageVersion, onLogout, scope, selectedId])

  async function loadMoreMessages() {
    if (!messagePage.hasMore || !messagePage.nextCursor || loadingMore) return
    setLoadingMore(true)
    setError('')
    try {
      const result = await api.messages(
        folder,
        deferredQuery,
        scope,
        messagePage.nextCursor,
      )
      if (result.unchanged) return
      setMessages((items) => {
        const existing = new Set(items.map((item) => item.id))
        return [...items, ...result.messages.filter((item) => !existing.has(item.id))]
      })
      setMessagePage(result.page)
      setCounts(result.counts)
    } catch (loadError) {
      if (loadError instanceof ApiError && loadError.status === 401) {
        await onLogout()
        return
      }
      setError(errorMessage(loadError))
    } finally {
      setLoadingMore(false)
    }
  }

  useEffect(() => {
    setSelectedMessageIds(new Set())
    void loadMessages()
  }, [folder, deferredQuery, scope]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void loadMailboxData()
  }, [loadMailboxData])

  useAutoRefresh(config.mailRefreshInterval, () => loadMessages(true), !adminView)

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 3000)
    return () => window.clearTimeout(timer)
  }, [notice])

  async function selectMessage(message: MessageSummary) {
    setSelectedId(message.id)
    setDetailLoading(true)
    setError('')
    try {
      const result = await api.message(message.id)
      setDetail(result.message)
      setThread(result.thread ?? [result.message])
      if (!message.isRead) {
        await api.updateMessage(message.id, { isRead: true })
        setMessages((items) => items.map((item) => (
          item.id === message.id ? { ...item, isRead: true } : item
        )))
        if (message.direction === 'incoming' && message.folder === 'inbox') {
          setCounts((current) => ({ ...current, unread: Math.max(0, current.unread - 1) }))
        }
        setDetail((current) => current ? { ...current, isRead: true } : current)
      }
    } catch (loadError) {
      setError(errorMessage(loadError))
      setDetail(null)
      setThread([])
    } finally {
      setDetailLoading(false)
    }
  }

  async function toggleStar(message: MessageSummary | MessageDetail) {
    const next = !message.isStarred
    await api.updateMessage(message.id, { isStarred: next })
    setMessages((items) => items.map((item) => (
      item.id === message.id ? { ...item, isStarred: next } : item
    )))
    setDetail((current) => current?.id === message.id ? { ...current, isStarred: next } : current)
    await loadMessages(true)
  }

  function toggleMessageSelection(message: MessageSummary) {
    setSelectedMessageIds((current) => {
      const next = new Set(current)
      if (next.has(message.id)) next.delete(message.id)
      else if (next.size < 50) next.add(message.id)
      return next
    })
  }

  function selectAllLoadedMessages() {
    const selectable = messages.slice(0, 50)
    const allSelected = selectable.every((message) => selectedMessageIds.has(message.id))
    setSelectedMessageIds(allSelected
      ? new Set()
      : new Set(selectable.map((message) => message.id)))
  }

  async function runBulkAction(action: BulkMessageAction) {
    const ids = [...selectedMessageIds]
    if (!ids.length) return
    if (action === 'delete' && !window.confirm(t(
      '永久删除所选的 {count} 封邮件及其附件？此操作无法撤销。',
      { count: ids.length },
    ))) return
    setBulkLoading(true)
    setError('')
    try {
      const result = await bulkMessages(ids, action)
      setSelectedMessageIds(new Set())
      if (selectedId && ids.includes(selectedId)) {
        setSelectedId(null)
        setDetail(null)
        setThread([])
      }
      setNotice(t('已更新 {count} 封邮件', { count: result.updatedCount }))
      await loadMessages(true)
    } catch (bulkError) {
      setError(errorMessage(bulkError))
    } finally {
      setBulkLoading(false)
    }
  }

  async function trashSelected() {
    if (!detail) return
    if (detail.folder === 'trash') {
      if (!window.confirm(t('永久删除这封邮件及其附件？此操作无法撤销。'))) return
      await api.deleteMessage(detail.id)
      setNotice(t('邮件已永久删除'))
    } else {
      await api.updateMessage(detail.id, { folder: 'trash' })
      setNotice(t('邮件已移入垃圾箱'))
    }
    setSelectedId(null)
    setDetail(null)
    setThread([])
    await loadMessages(true)
  }

  async function restoreSelected() {
    if (!detail) return
    await api.updateMessage(detail.id, {
      folder: detail.direction === 'outgoing' ? 'sent' : 'inbox',
    })
    setSelectedId(null)
    setDetail(null)
    setThread([])
    setNotice(t('邮件已恢复'))
    await loadMessages(true)
  }

  function changeFolder(next: Folder) {
    const shouldQuietRefresh = shouldQuietRefreshFolder(folder, next, query)
    setAdminView(null)
    setSelectedId(null)
    setDetail(null)
    setThread([])
    setQuery('')
    if (shouldQuietRefresh) {
      void loadMessages(true)
      return
    }
    setListLoading(true)
    setFolder(next)
  }

  function changeScope(next: MailboxScope) {
    setListLoading(true)
    setScope(next)
    setSelectedId(null)
    setDetail(null)
    setThread([])
    setQuery('')
  }

  function changeAdminView(next: AdminView) {
    if (next !== 'account' && !isAdminRole(user.role)) return
    setAdminView(next)
    setScope({ type: 'all' })
    setSelectedId(null)
    setDetail(null)
    setThread([])
    setQuery('')
  }

  return (
    <div className={`mail-layout ${selectedId ? 'has-selection' : ''} ${adminView ? 'has-admin-view' : ''}`}>
      <MailboxSidebar
        user={user}
        folder={folder}
        counts={counts}
        adminView={adminView}
        onFolderChange={changeFolder}
        onAdminViewChange={changeAdminView}
        onLogout={onLogout}
      />

      {adminView ? (
        <DelayedScrollbar className="admin-scroll-shell" resetKey={adminView}>
          <AdminWorkspace
            key={adminView}
            view={adminView}
            user={user}
            config={config}
            mailboxes={mailboxes}
            domains={domains}
            onDomainsChanged={loadDomains}
            onConfigChange={onConfigChange}
            onUserChange={onUserChange}
            onLogout={onLogout}
            onOpenDeploymentWizard={() => setDeploymentWizardOpen(true)}
          />
        </DelayedScrollbar>
      ) : (
        <>
          <section
            className="list-pane page-content-enter"
            key={`${folder}:${scope.type}:${scope.type === 'all' ? '' : scope.value}`}
          >
        <header className="list-header">
          <div>
            <MailboxSwitcher
              mailboxes={mailboxes}
              domains={domains}
              scope={scope}
              canManage={isAdminRole(user.role) || user.canCreateMailboxes}
              onScopeChange={changeScope}
              onMailboxesChanged={loadMailboxData}
            />
            <h1>{folderLabel(folder)}</h1>
          </div>
          <MailboxHeaderActions
            mailboxes={mailboxes}
            domains={domains}
            scope={scope}
            canGenerate={isAdminRole(user.role) || user.canCreateMailboxes}
            refreshing={refreshing}
            onRefresh={() => void loadMessages(true)}
            onCopied={(address) => {
              setError('')
              setNotice(t('已复制：{address}', { address }))
            }}
            onCopyError={() => setError(t('无法访问剪贴板，请手动复制邮箱地址。'))}
            onMailboxCreated={async (mailbox) => {
              await loadMailboxData()
              changeScope({ type: 'mailbox', value: mailbox.address })
              setNotice(t('已生成：{address}', { address: mailbox.address }))
            }}
          />
        </header>
        <label className="search-field">
          <Search size={17} />
          <span className="sr-only">{t('搜索邮件')}</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('搜索发件人或主题')}
            type="search"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label={t('清除搜索')}><X size={15} /></button>
          )}
        </label>
        {error && <p className="list-error" role="alert"><AlertCircle size={15} />{error}</p>}
        <MessageList
          folder={folder}
          messages={messages}
          selectedId={selectedId}
          selectedIds={selectedMessageIds}
          loading={listLoading}
          bulkLoading={bulkLoading}
          showMailbox={scope.type !== 'mailbox'}
          page={messagePage}
          loadingMore={loadingMore}
          onSelect={(message) => void selectMessage(message)}
          onToggleSelection={toggleMessageSelection}
          onSelectAll={selectAllLoadedMessages}
          onBulkAction={(action) => void runBulkAction(action)}
          onStar={(message) => void toggleStar(message)}
          onLoadMore={() => void loadMoreMessages()}
        />
      </section>

      <main className="reader-pane">
        <MessageReader
          message={detail}
          loading={detailLoading}
          thread={thread}
          replyEnabled={config.replyEnabled && (user.role === 'super_admin' || user.canReply)}
          remoteImagesEnabled={config.remoteImagesEnabled}
          onBack={() => {
            setSelectedId(null)
            setDetail(null)
            setThread([])
          }}
          onStar={() => detail && void toggleStar(detail)}
          onTrash={() => void trashSelected()}
          onRestore={() => void restoreSelected()}
          onReplySent={() => {
            setNotice(t('回复已发送'))
            void loadMessages(true)
          }}
          onSelectThread={(message) => void selectMessage(message)}
        />
      </main>
        </>
      )}
      {notice && <div className="toast" role="status"><Check size={16} />{notice}</div>}
      <DeploymentWizard open={deploymentWizardOpen} onClose={closeDeploymentWizard} />
    </div>
  )
}

export function App() {
  useLocale()
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [connectionError, setConnectionError] = useState('')
  const [loadVersion, setLoadVersion] = useState(0)
  const [inviteToken] = useState(() => new URLSearchParams(window.location.search).get('invite'))

  useEffect(() => {
    if (!inviteToken) return
    const url = new URL(window.location.href)
    url.searchParams.delete('invite')
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  }, [inviteToken])

  useEffect(() => {
    let active = true
    setLoading(true)
    setConnectionError('')
    Promise.all([api.config(), api.session(), openingSplashDelay(loadVersion > 0)])
      .then(([nextConfig, session]) => {
        if (!active) return
        setConfig(nextConfig)
        setUser(session.user)
      })
      .catch((error) => {
        if (active) setConnectionError(errorMessage(error))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [loadVersion])

  const logout = useCallback(async () => {
    try {
      await api.logout()
    } finally {
      setUser(null)
    }
  }, [])

  if (loading) return <PageLoader />
  if (connectionError || !config) {
    return <ConnectionError message={connectionError || t('配置读取失败。')} retry={() => setLoadVersion((value) => value + 1)} />
  }
  if (!config.setupComplete) {
    return (
      <SetupPage
        superAdminEmail={config.superAdminEmail}
        requirements={config.setupRequirements}
        onAuthenticated={(nextUser) => {
          setUser(nextUser)
          setConfig({ ...config, setupComplete: true })
        }}
      />
    )
  }
  if (inviteToken && !user) {
    return (
      <TemporaryInvitePage
        token={inviteToken}
        appName={config.appName}
        turnstileSiteKey={config.turnstileSiteKey}
        onAuthenticated={setUser}
      />
    )
  }
  if (!user) {
    return (
      <PublicLanding
        appName={config.appName}
        registrationEnabled={config.registrationEnabled && config.registrationProtectionReady}
        registrationDomainPolicy={config.registrationDomainPolicy}
        turnstileSiteKey={config.turnstileSiteKey}
        onAuthenticated={setUser}
      />
    )
  }
  return <Mailbox user={user} config={config} onConfigChange={setConfig} onUserChange={setUser} onLogout={logout} />
}
