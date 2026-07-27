import {
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Link2,
  MailPlus,
  Search,
  Send,
  ShieldCheck,
  UserPlus,
  UserRound,
  Users,
  X,
} from 'lucide-react'
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  api,
  type AdminUserTotals,
  type AdminUser,
  type CreateManagedUser,
  type ManagedUserPolicy,
  type PageInfo,
  type User,
} from '../lib/api'
import { getLocale, t } from '../lib/i18n'
import { roleLabel } from '../lib/roles'
import { AdminPageHeader } from './AdminPageHeader'
import { TemporaryInvitePanel } from './TemporaryInvitePanel'

const initialCreate: CreateManagedUser = {
  email: '',
  displayName: '',
  password: '',
  role: 'user',
  status: 'active',
  mailboxLimit: 1,
  canCreateMailboxes: false,
  canReply: false,
}

function policyFor(user: AdminUser): ManagedUserPolicy {
  return {
    role: user.role === 'super_admin' ? 'admin' : user.role,
    status: user.status,
    mailboxLimit: user.mailboxLimit,
    canCreateMailboxes: user.canCreateMailboxes,
    canReply: user.canReply,
  }
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(getLocale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(timestamp * 1000))
}

const roleOptions = [
  {
    value: 'admin' as const,
    label: '管理员',
    description: '管理用户、域名与系统配置',
    Icon: ShieldCheck,
  },
  {
    value: 'user' as const,
    label: '普通用户',
    description: '长期使用的标准邮箱账户',
    Icon: UserRound,
  },
  {
    value: 'temporary' as const,
    label: '临时用户',
    description: '使用管理员配置的临时权限',
    Icon: Clock3,
  },
]

function RoleSelect({
  value,
  allowAdmin,
  disabled,
  onChange,
}: {
  value: ManagedUserPolicy['role']
  allowAdmin: boolean
  disabled: boolean
  onChange: (role: ManagedUserPolicy['role']) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const options = roleOptions.filter((option) => (
    option.value !== 'admin' || allowAdmin || value === 'admin'
  ))
  const selected = options.find((option) => option.value === value) || options[0]

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeWithEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeWithEscape)
    }
  }, [open])

  return (
    <div className={`user-role-select ${open ? 'is-open' : ''}`} ref={root}>
      <button
        className="user-role-select__trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <selected.Icon size={16} />
        <span>{t(selected.label)}</span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="user-role-select__menu" id={menuId} role="listbox">
          {options.map(({ value: optionValue, label, description, Icon }) => (
            <button
              className={optionValue === value ? 'is-selected' : ''}
              type="button"
              role="option"
              aria-selected={optionValue === value}
              key={optionValue}
              onClick={() => {
                onChange(optionValue)
                setOpen(false)
              }}
            >
              <span className="user-role-select__icon"><Icon size={16} /></span>
              <span><strong>{t(label)}</strong><small>{t(description)}</small></span>
              {optionValue === value && <Check size={16} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function PolicyFields({
  value,
  onChange,
  allowAdmin,
  showStatus,
  disabled = false,
}: {
  value: ManagedUserPolicy
  onChange: (next: ManagedUserPolicy) => void
  allowAdmin: boolean
  showStatus: boolean
  disabled?: boolean
}) {
  return (
    <div className="user-policy-fields">
      <label>
        <span>{t('账户角色')}</span>
        <RoleSelect
          value={value.role}
          allowAdmin={allowAdmin}
          disabled={disabled}
          onChange={(role) => {
            onChange({
              ...value,
              role,
              canCreateMailboxes: role === 'admin' ? true : value.canCreateMailboxes,
            })
          }}
        />
      </label>

      <label>
        <span>{t('邮箱数量上限')}</span>
        <input
          type="number"
          min="0"
          max="100"
          value={value.mailboxLimit}
          disabled={disabled}
          onChange={(event) => onChange({
            ...value,
            mailboxLimit: Math.max(0, Math.min(100, Number(event.target.value))),
          })}
        />
        <small>{t('范围 0–100；已经创建的邮箱不会被自动删除。')}</small>
      </label>

      <label className="policy-toggle">
        <span><MailPlus size={17} /><span><strong>{t('创建与管理邮箱')}</strong><small>{t(value.role === 'admin' ? '管理员默认拥有此权限' : '允许添加、启用和停用自己的收件地址')}</small></span></span>
        <input
          type="checkbox"
          checked={value.role === 'admin' || value.canCreateMailboxes}
          disabled={disabled || value.role === 'admin'}
          onChange={(event) => onChange({ ...value, canCreateMailboxes: event.target.checked })}
        />
      </label>

      <label className="policy-toggle">
        <span><Send size={17} /><span><strong>{t('使用 Resend 回信')}</strong><small>{t('仍需 Worker 已配置 Resend 服务')}</small></span></span>
        <input
          type="checkbox"
          checked={value.canReply}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, canReply: event.target.checked })}
        />
      </label>

      {showStatus && (
        <label className="policy-toggle policy-toggle--danger">
          <span><Ban size={17} /><span><strong>{t('封禁账户')}</strong><small>{t('保存后立即注销该用户的所有会话')}</small></span></span>
          <input
            type="checkbox"
            checked={value.status === 'disabled'}
            disabled={disabled}
            onChange={(event) => onChange({
              ...value,
              status: event.target.checked ? 'disabled' : 'active',
            })}
          />
        </label>
      )}
    </div>
  )
}

export function UserManagement({
  currentUser,
  registrationProtectionReady,
}: {
  currentUser: User
  registrationProtectionReady: boolean
}) {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [totals, setTotals] = useState<AdminUserTotals>({ total: 0, active: 0, disabled: 0 })
  const [page, setPage] = useState<PageInfo>({ hasMore: false, nextCursor: null, limit: 50 })
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selected, setSelected] = useState<AdminUser | null>(null)
  const [policy, setPolicy] = useState<ManagedUserPolicy | null>(null)
  const [createDraft, setCreateDraft] = useState<CreateManagedUser>(initialCreate)
  const [creating, setCreating] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)

  async function loadUsers(cursor?: string) {
    if (cursor) setLoadingMore(true)
    else setLoading(true)
    setError('')
    try {
      const result = await api.adminUsers(cursor)
      setUsers((items) => {
        if (!cursor) return result.users
        const existing = new Set(items.map((item) => item.id))
        return [...items, ...result.users.filter((item) => !existing.has(item.id))]
      })
      setPage(result.page)
      setTotals(result.totals)
    } catch (loadError) {
      setError(t(loadError instanceof Error ? loadError.message : '无法读取用户列表。'))
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }

  useEffect(() => {
    void loadUsers()
  }, [])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return users
    return users.filter((user) => (
      user.email.toLowerCase().includes(needle)
      || user.displayName.toLowerCase().includes(needle)
      || roleLabel(user.role).includes(needle)
    ))
  }, [query, users])

  const protectedTarget = Boolean(
    selected
    && (
      selected.role === 'super_admin'
      || selected.id === currentUser.id
      || (currentUser.role === 'admin' && selected.role === 'admin')
    ),
  )

  function openUser(user: AdminUser) {
    setSelected(user)
    setPolicy(policyFor(user))
    setCreating(false)
    setError('')
  }

  function openCreate() {
    setCreateDraft(initialCreate)
    setSelected(null)
    setPolicy(null)
    setCreating(true)
    setError('')
  }

  function closePanel() {
    setSelected(null)
    setPolicy(null)
    setCreating(false)
    setError('')
  }

  async function savePolicy(event: FormEvent) {
    event.preventDefault()
    if (!selected || !policy || protectedTarget) return
    if (
      selected.status === 'active'
      && policy.status === 'disabled'
      && !window.confirm(t('确认封禁 {email}？该账户会立即退出登录。', { email: selected.email }))
    ) return

    setSaving(true)
    setError('')
    try {
      const result = await api.updateAdminUser(selected.id, policy)
      setUsers((items) => items.map((item) => item.id === result.user.id ? result.user : item))
      if (selected.status !== result.user.status) {
        setTotals((current) => ({
          ...current,
          active: current.active + (result.user.status === 'active' ? 1 : -1),
          disabled: current.disabled + (result.user.status === 'disabled' ? 1 : -1),
        }))
      }
      setSelected(result.user)
      setPolicy(policyFor(result.user))
      setNotice(t(result.user.status === 'disabled' ? '账户已封禁' : '权限设置已保存'))
    } catch (saveError) {
      setError(t(saveError instanceof Error ? saveError.message : '无法保存用户设置。'))
    } finally {
      setSaving(false)
    }
  }

  async function createUser(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      const result = await api.createAdminUser(createDraft)
      setUsers((items) => [...items, result.user])
      setTotals((current) => ({
        total: current.total + 1,
        active: current.active + 1,
        disabled: current.disabled,
      }))
      setNotice(t('用户已创建，可以使用邮箱密码登录'))
      closePanel()
    } catch (createError) {
      setError(t(createError instanceof Error ? createError.message : '无法创建用户。'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="admin-workspace user-management">
      <AdminPageHeader
        icon={Users}
        eyebrow="ADMIN · ACCOUNTS"
        title={t('用户管理')}
        description={t('控制登录状态、角色、邮箱额度和可使用的邮件能力。')}
        className="user-management__header"
        actions={<div className="user-header-actions">
          <button className="button button--secondary user-invite-button" type="button" onClick={() => setInviteOpen(true)}>
            <Link2 size={16} />
            {t('临时邀请')}
          </button>
          <button className="button button--primary user-add-button" type="button" onClick={openCreate}>
            <UserPlus size={16} />
            {t('新增用户')}
          </button>
        </div>}
      />

      <section className="user-summary" aria-label={t('用户概况')}>
        <div><Users size={16} /><span><strong>{totals.total}</strong><small>{t('全部账户')}</small></span></div>
        <div><ShieldCheck size={16} /><span><strong>{totals.active}</strong><small>{t('正常使用')}</small></span></div>
        <div><Ban size={16} /><span><strong>{totals.disabled}</strong><small>{t('已经封禁')}</small></span></div>
      </section>

      <section className="user-directory">
        <header>
          <div>
            <h2>{t('账户列表')}</h2>
            <p>{t('主管理员身份由 Worker 配置保护。')}</p>
          </div>
          <label className="user-search">
            <Search size={16} />
            <span className="sr-only">{t('搜索用户')}</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('搜索名称、邮箱或角色')}
              type="search"
            />
          </label>
        </header>

        {loading ? (
          <div className="user-list-state">{t('正在读取用户…')}</div>
        ) : filtered.length ? (
          <div className="managed-user-list">
            <div className="user-list-heading" aria-hidden="true">
              <span>{t('用户')}</span><span>{t('角色')}</span><span>{t('邮箱额度')}</span><span>{t('权限')}</span><span>{t('状态')}</span><span />
            </div>
            {filtered.map((user) => (
              <button className="managed-user-row" type="button" key={user.id} onClick={() => openUser(user)}>
                <span className="managed-user-identity">
                  <span className="managed-user-avatar">{user.displayName.slice(0, 1).toUpperCase()}</span>
                  <span><strong>{user.displayName}</strong><small>{user.email}</small></span>
                </span>
                <span className={`role-pill role-pill--${user.role}`}>{roleLabel(user.role)}</span>
                <span className="user-mailbox-usage">
                  <strong>{user.mailboxCount}</strong>
                  <small>/ {user.role === 'super_admin' ? t('不限') : user.mailboxLimit}</small>
                </span>
                <span className="user-capabilities">
                  {user.canCreateMailboxes && <span title={t('可管理邮箱')}><MailPlus size={14} /></span>}
                  {user.canReply && <span title={t('可回信')}><Send size={14} /></span>}
                  {!user.canCreateMailboxes && !user.canReply && <small>{t('基础权限')}</small>}
                </span>
                <span className={`user-status ${user.status === 'active' ? 'is-active' : ''}`}>
                  <span aria-hidden="true" />{t(user.status === 'active' ? '正常' : '已封禁')}
                </span>
                <ChevronRight size={16} />
              </button>
            ))}
            {page.hasMore && !query.trim() && (
              <button
                className="button button--secondary user-load-more"
                type="button"
                disabled={loadingMore}
                onClick={() => page.nextCursor && void loadUsers(page.nextCursor)}
              >
                {t(loadingMore ? '正在加载…' : '加载更多用户')}
              </button>
            )}
          </div>
        ) : (
          <div className="user-list-state">{t('没有符合条件的用户。')}</div>
        )}
      </section>

      {(selected || creating) && (
        <div className="user-panel-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closePanel()
        }}>
          <section className="user-panel" role="dialog" aria-modal="true" aria-labelledby="user-panel-title">
            <header>
              <div>
                <p className="eyebrow">{creating ? 'NEW ACCOUNT' : 'ACCOUNT POLICY'}</p>
                <h2 id="user-panel-title">{creating ? t('新增用户') : selected?.displayName}</h2>
                <p>{creating ? t('创建可使用邮箱密码登录的账户。') : selected?.email}</p>
              </div>
              <button className="icon-button" type="button" onClick={closePanel} aria-label={t('关闭')}>
                <X size={17} />
              </button>
            </header>

            {error && <p className="user-panel-error" role="alert">{error}</p>}

            {creating ? (
              <form onSubmit={(event) => void createUser(event)}>
                <div className="user-create-fields">
                  <label><span>{t('显示名称')}</span><input required maxLength={60} value={createDraft.displayName} onChange={(event) => setCreateDraft({ ...createDraft, displayName: event.target.value })} /></label>
                  <label><span>{t('登录邮箱')}</span><input required type="email" value={createDraft.email} onChange={(event) => setCreateDraft({ ...createDraft, email: event.target.value })} /></label>
                  <label><span>{t('初始密码')}</span><input required type="password" minLength={10} maxLength={128} value={createDraft.password} onChange={(event) => setCreateDraft({ ...createDraft, password: event.target.value })} /></label>
                </div>
                <PolicyFields
                  value={createDraft}
                  onChange={(next) => setCreateDraft({ ...createDraft, ...next })}
                  allowAdmin={currentUser.role === 'super_admin'}
                  showStatus={false}
                />
                <button className="button button--primary user-panel-submit" type="submit" disabled={saving}>
                  <UserPlus size={16} />{t(saving ? '正在创建…' : '创建用户')}
                </button>
              </form>
            ) : policy && selected ? (
              <form onSubmit={(event) => void savePolicy(event)}>
                <div className="user-panel-meta">
                  <span><UserRound size={15} />{t('创建于 {date}', { date: formatDate(selected.createdAt) })}</span>
                  <span><MailPlus size={15} />{t('已使用 {count} 个邮箱', { count: selected.mailboxCount })}</span>
                  {selected.role === 'temporary' && <span><Clock3 size={15} />{t('临时用户')}</span>}
                </div>
                {protectedTarget && (
                  <p className="user-protected-note">
                    <ShieldCheck size={16} />
                    {selected.role === 'super_admin'
                      ? t('主管理员由 Worker 配置保护，不能在网页端降级或封禁。')
                      : t('为了避免权限升级或自我锁定，当前管理员不能修改这个账户。')}
                  </p>
                )}
                <PolicyFields
                  value={policy}
                  onChange={setPolicy}
                  allowAdmin={currentUser.role === 'super_admin'}
                  showStatus
                  disabled={protectedTarget}
                />
                {!protectedTarget && (
                  <button className="button button--primary user-panel-submit" type="submit" disabled={saving}>
                    <ShieldCheck size={16} />{t(saving ? '正在保存…' : '保存权限')}
                  </button>
                )}
              </form>
            ) : null}
          </section>
        </div>
      )}

      {inviteOpen && (
        <TemporaryInvitePanel
          registrationProtectionReady={registrationProtectionReady}
          onClose={() => setInviteOpen(false)}
        />
      )}

      {notice && (
        <button className="user-notice" type="button" onClick={() => setNotice('')}>
          {notice}<X size={14} />
        </button>
      )}
    </main>
  )
}
