import {
  AlertCircle,
  Clock3,
  LoaderCircle,
  LogIn,
  Search,
  ScrollText,
  ShieldAlert,
  UserRound,
} from 'lucide-react'
import {
  type CSSProperties,
  useDeferredValue,
  useEffect,
  useState,
} from 'react'
import {
  api,
  type AuditCategory,
  type AuditDays,
  type AuditLog,
  type AuditSummary,
  type PageInfo,
} from '../lib/api'
import { getLocale, t } from '../lib/i18n'
import { AdminPageHeader } from './AdminPageHeader'

const categories: Array<{ id: AuditCategory; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'auth', label: '登录安全' },
  { id: 'user', label: '用户权限' },
  { id: 'account', label: '账号' },
  { id: 'mailbox', label: '邮箱' },
  { id: 'domain', label: '域名' },
  { id: 'invitation', label: '邀请' },
  { id: 'message', label: '邮件' },
  { id: 'system', label: '系统' },
]

const ranges: Array<{ value: AuditDays; label: string }> = [
  { value: 1, label: '24 小时' },
  { value: 7, label: '7 天' },
  { value: 30, label: '30 天' },
  { value: 90, label: '90 天' },
]

const actionLabels: Record<string, string> = {
  'setup.complete': '完成系统初始化',
  'auth.login': '网页登录成功',
  'auth.login_failed': '登录失败',
  'auth.register': '外部注册账户',
  'auth.register_failed': '外部注册失败',
  'auth.logout': '退出登录',
  'auth.token.issue': '客户端登录成功',
  'auth.token.revoke': '客户端退出',
  'auth.device.revoke': '撤销客户端设备',
  'account.update': '修改账号资料',
  'account.delete': '删除临时账号',
  'account.expire': '临时账号到期',
  'user.create': '创建用户',
  'user.update': '修改用户权限',
  'mailbox.create': '创建邮箱',
  'mailbox.enable': '启用邮箱',
  'mailbox.disable': '停用邮箱',
  'domain.create': '添加域名',
  'domain.enable': '启用域名',
  'domain.disable': '停用域名',
  'domain.delete': '删除域名',
  'temporary_invite.create': '创建临时邀请',
  'temporary_invite.revoke': '撤销临时邀请',
  'temporary_invite.register': '通过邀请注册',
  'temporary_invite.register_failed': '邀请注册被拦截',
  'message.reply': '回复邮件',
  'message.delete': '永久删除邮件',
  'system.registration.update': '修改外部注册设置',
  'system.registration_domains.update': '修改注册邮箱限制',
  'system.mail_refresh.update': '修改邮件自动刷新',
  'system.remote_images.update': '修改远程图片策略',
}

const categoryLabels: Record<string, string> = {
  setup: '系统',
  auth: '登录安全',
  account: '账号',
  user: '用户权限',
  mailbox: '邮箱',
  domain: '域名',
  temporary_invite: '邀请',
  message: '邮件',
  system: '系统',
}

function actionCategory(action: string): string {
  return t(categoryLabels[action.split('.')[0]] || '其他')
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(getLocale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp * 1000))
}

function detailText(log: AuditLog): string {
  const detail = log.detail
  const parts: string[] = []
  if (detail.channel === 'browser') parts.push(t('网页端'))
  if (detail.channel === 'token') parts.push(t('客户端'))
  if (detail.deviceName) parts.push(String(detail.deviceName))
  if (detail.reason === 'invalid_credentials') parts.push(t('凭据错误'))
  if (detail.reason === 'rate_limited') parts.push(t('触发登录限速'))
  if (detail.role) parts.push(t('角色 {role}', { role: String(detail.role) }))
  if (detail.status) parts.push(t('状态 {status}', { status: String(detail.status) }))
  if (typeof detail.mailboxLimit === 'number') {
    parts.push(t('邮箱额度 {limit}', { limit: detail.mailboxLimit }))
  }
  if (detail.address) parts.push(String(detail.address))
  if (log.action === 'system.remote_images.update' && typeof detail.enabled === 'boolean') {
    parts.push(t(detail.enabled ? '默认加载' : '默认阻止'))
  }
  return parts.join(' · ')
}

function actorName(log: AuditLog): string {
  if (log.actor) return log.actor.displayName || log.actor.email || t('已删除用户')
  return log.targetId || t('未登录访问者')
}

function targetName(log: AuditLog): string {
  if (log.target) return log.target.displayName || log.target.email || log.target.id || '—'
  return log.targetId || '—'
}

const emptyPage: PageInfo = { hasMore: false, nextCursor: null, limit: 50 }
const emptySummary: AuditSummary = { total: 0, loginSuccess: 0, loginFailed: 0 }
const MINIMUM_LOADING_MS = 260
const SKELETON_ROWS = 7

function loadingDelay(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, MINIMUM_LOADING_MS))
}

function AuditSkeleton() {
  return (
    <div className="audit-list audit-list--skeleton" aria-hidden="true">
      <div className="audit-heading">
        <span>{t('时间')}</span><span>{t('操作')}</span><span>{t('操作者')}</span><span>{t('目标 / 详情')}</span><span>{t('来源 IP')}</span>
      </div>
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div className="audit-row audit-row--skeleton" key={index}>
          <time><span className="audit-skeleton audit-skeleton--time" /></time>
          <span className="audit-action">
            <span className="audit-skeleton audit-skeleton--title" />
            <span className="audit-skeleton audit-skeleton--caption" />
          </span>
          <span className="audit-actor">
            <span className="audit-skeleton audit-skeleton--avatar" />
            <span>
              <span className="audit-skeleton audit-skeleton--title" />
              <span className="audit-skeleton audit-skeleton--caption" />
            </span>
          </span>
          <span className="audit-target">
            <span className="audit-skeleton audit-skeleton--target" />
            <span className="audit-skeleton audit-skeleton--caption" />
          </span>
          <code><span className="audit-skeleton audit-skeleton--ip" /></code>
        </div>
      ))}
    </div>
  )
}

export function AuditLogs() {
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [page, setPage] = useState<PageInfo>(emptyPage)
  const [summary, setSummary] = useState<AuditSummary>(emptySummary)
  const [days, setDays] = useState<AuditDays>(7)
  const [category, setCategory] = useState<AuditCategory>('all')
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim())
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    setLogs([])
    setPage(emptyPage)
    setSummary(emptySummary)
    Promise.all([
      api.auditLogs({ days, category, query: deferredQuery }),
      loadingDelay(),
    ])
      .then(([result]) => {
        if (!active) return
        setLogs(result.logs)
        setPage(result.page)
        setSummary(result.summary)
      })
      .catch((loadError) => {
        if (active) {
          setError(t(loadError instanceof Error ? loadError.message : '无法读取操作日志。'))
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [category, days, deferredQuery])

  async function loadMore() {
    if (!page.hasMore || !page.nextCursor || loadingMore) return
    setLoadingMore(true)
    setError('')
    try {
      const result = await api.auditLogs({
        days,
        category,
        query: deferredQuery,
        cursor: page.nextCursor,
      })
      setLogs((items) => [...items, ...result.logs])
      setPage(result.page)
      setSummary(result.summary)
    } catch (loadError) {
      setError(t(loadError instanceof Error ? loadError.message : '无法读取更多日志。'))
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <main className="admin-workspace audit-workspace">
      <AdminPageHeader
        icon={ScrollText}
        eyebrow="ADMIN · AUDIT TRAIL"
        title={t('操作日志')}
        description={t('追踪登录安全、权限修改和重要系统操作。')}
      />

      <section className={`audit-summary ${loading ? 'is-loading' : ''}`} aria-label={t('日志概况')} aria-busy={loading}>
        <article><ScrollText size={17} /><span><strong>{loading ? <span className="audit-skeleton audit-skeleton--number" /> : summary.total}</strong><small>{t('筛选范围内操作')}</small></span></article>
        <article><LogIn size={17} /><span><strong>{loading ? <span className="audit-skeleton audit-skeleton--number" /> : summary.loginSuccess}</strong><small>{t('成功登录')}</small></span></article>
        <article className={!loading && summary.loginFailed ? 'has-warning' : ''}><ShieldAlert size={17} /><span><strong>{loading ? <span className="audit-skeleton audit-skeleton--number" /> : summary.loginFailed}</strong><small>{t('登录失败')}</small></span></article>
      </section>

      <section className="audit-panel">
        <header className="audit-toolbar">
          <div className="audit-ranges" aria-label={t('时间范围')}>
            {ranges.map((range) => (
              <button
                className={range.value === days ? 'is-active' : ''}
                type="button"
                key={range.value}
                onClick={() => setDays(range.value)}
              >
                {t(range.label)}
              </button>
            ))}
          </div>
          <label className="audit-search">
            <Search size={16} />
            <span className="sr-only">{t('搜索操作日志')}</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('搜索用户、邮箱、目标或 IP')}
            />
          </label>
        </header>

        <div className="audit-categories" aria-label={t('日志类型')}>
          {categories.map((item) => (
            <button
              className={item.id === category ? 'is-active' : ''}
              type="button"
              key={item.id}
              onClick={() => setCategory(item.id)}
            >
              {t(item.label)}
            </button>
          ))}
        </div>

        {error && <p className="audit-error" role="alert"><AlertCircle size={16} />{error}</p>}
        {loading ? (
          <AuditSkeleton />
        ) : logs.length ? (
          <>
            <div className="audit-list">
              <div className="audit-heading" aria-hidden="true">
                <span>{t('时间')}</span><span>{t('操作')}</span><span>{t('操作者')}</span><span>{t('目标 / 详情')}</span><span>{t('来源 IP')}</span>
              </div>
              {logs.map((log, index) => (
                <article
                  className={`audit-row audit-row--enter ${log.action === 'auth.login_failed' ? 'is-warning' : ''}`}
                  key={log.id}
                  style={{
                    '--audit-row-delay': `${Math.min(index, 14) * 30}ms`,
                  } as CSSProperties}
                >
                  <time dateTime={new Date(log.createdAt * 1000).toISOString()}>
                    <Clock3 size={14} />{formatTime(log.createdAt)}
                  </time>
                  <span className="audit-action">
                    <strong>{t(actionLabels[log.action] || log.action)}</strong>
                    <small>{actionCategory(log.action)}</small>
                  </span>
                  <span className="audit-actor">
                    <span><UserRound size={14} /></span>
                    <span><strong>{actorName(log)}</strong><small>{log.actor?.email || t(log.actor ? '无登录邮箱' : '未建立会话')}</small></span>
                  </span>
                  <span className="audit-target">
                    <strong title={log.targetId || undefined}>{targetName(log)}</strong>
                    <small>{[log.target?.email, detailText(log)].filter(Boolean).join(' · ') || t('无附加信息')}</small>
                  </span>
                  <code>{log.ip}</code>
                </article>
              ))}
            </div>
            {page.hasMore && (
              <button
                className="button button--secondary audit-load-more"
                type="button"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore && <LoaderCircle className="spin" size={15} />}
                {t(loadingMore ? '正在加载…' : '加载更多日志')}
              </button>
            )}
          </>
        ) : !error ? (
          <div className="audit-state"><ScrollText size={22} />{t('当前筛选范围内没有操作记录。')}</div>
        ) : null}
      </section>
    </main>
  )
}
