import {
  AlertCircle,
  AtSign,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  Globe2,
  Link2,
  LoaderCircle,
  MailPlus,
  Send,
  ShieldCheck,
  UserRoundPlus,
  X,
} from 'lucide-react'
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  type CreateTemporaryInvite,
  type ManagedDomain,
  type PageInfo,
  type TemporaryInvite,
} from '../lib/api'

const initialDraft: CreateTemporaryInvite = {
  domain: '',
  expiresInHours: 24,
  accountLifetimeHours: 24,
  multiUse: false,
  addressMode: 'self_selected',
  assignedLocalPart: '',
  mailboxLimit: 1,
  canCreateMailboxes: false,
  canReply: false,
}

const stateLabels: Record<TemporaryInvite['state'], string> = {
  active: '可使用',
  expired: '已过期',
  used: '已使用',
  revoked: '已撤销',
  domain_disabled: '域名已停用',
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp * 1000))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '发生了未知错误。'
}

function formatDuration(hours: number): string {
  return hours % 24 === 0 ? `${hours / 24} 天` : `${hours} 小时`
}

function InviteSelect({
  value,
  options,
  label,
  disabled = false,
  onChange,
}: {
  value: string
  options: Array<{ value: string; label: string }>
  label: string
  disabled?: boolean
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const selected = options.find((option) => option.value === value)

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', closeWithEscape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', closeWithEscape)
    }
  }, [open])

  return (
    <div className={`invite-select ${open ? 'is-open' : ''}`} ref={root}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected?.label || '请选择'}</span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="invite-select__menu" role="listbox" aria-label={label}>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={option.value === value ? 'is-selected' : ''}
              key={option.value}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function TemporaryInvitePanel({
  registrationProtectionReady,
  onClose,
}: {
  registrationProtectionReady: boolean
  onClose: () => void
}) {
  const [domains, setDomains] = useState<ManagedDomain[]>([])
  const [invites, setInvites] = useState<TemporaryInvite[]>([])
  const [page, setPage] = useState<PageInfo>({ hasMore: false, nextCursor: null, limit: 30 })
  const [draft, setDraft] = useState<CreateTemporaryInvite>(initialDraft)
  const [createdLink, setCreatedLink] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const activeDomains = useMemo(
    () => domains.filter((domain) => domain.isActive),
    [domains],
  )

  useEffect(() => {
    let active = true
    Promise.all([api.domains(), api.temporaryInvites()])
      .then(([domainResult, inviteResult]) => {
        if (!active) return
        const enabled = domainResult.domains.filter((domain) => domain.isActive)
        setDomains(domainResult.domains)
        setInvites(inviteResult.invites)
        setPage(inviteResult.page)
        setDraft((current) => ({
          ...current,
          domain: current.domain || enabled[0]?.name || '',
        }))
      })
      .catch((loadError) => {
        if (active) setError(errorMessage(loadError))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  async function createInvite(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    setCopied(false)
    try {
      const result = await api.createTemporaryInvite(draft)
      const link = `${window.location.origin}${window.location.pathname}?invite=${encodeURIComponent(result.token)}`
      setInvites((items) => [result.invite, ...items])
      setCreatedLink(link)
    } catch (createError) {
      setError(errorMessage(createError))
    } finally {
      setSaving(false)
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(createdLink)
      setCopied(true)
    } catch {
      setError('浏览器没有允许复制，请手动选择邀请链接。')
    }
  }

  async function loadMoreInvites() {
    if (!page.hasMore || !page.nextCursor || loadingMore) return
    setLoadingMore(true)
    setError('')
    try {
      const result = await api.temporaryInvites(page.nextCursor)
      setInvites((items) => [...items, ...result.invites])
      setPage(result.page)
    } catch (loadError) {
      setError(errorMessage(loadError))
    } finally {
      setLoadingMore(false)
    }
  }

  async function revoke(invite: TemporaryInvite) {
    const target = invite.assignedAddress || invite.domain
    if (!window.confirm(`确认撤销 ${target} 的邀请链接？已注册的账号不会删除。`)) return
    setError('')
    try {
      await api.revokeTemporaryInvite(invite.id)
      setInvites((items) => items.map((item) => (
        item.id === invite.id ? { ...item, state: 'revoked' } : item
      )))
    } catch (revokeError) {
      setError(errorMessage(revokeError))
    }
  }

  return (
    <div className="user-panel-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="user-panel invite-panel" role="dialog" aria-modal="true" aria-labelledby="invite-panel-title">
        <header>
          <div>
            <p className="eyebrow">TEMPORARY ACCESS</p>
            <h2 id="invite-panel-title">临时用户邀请</h2>
            <p>选择由管理员固定邮箱，或让访问者在指定域名下自选邮箱。</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">
            <X size={17} />
          </button>
        </header>

        {loading ? (
          <div className="invite-loading"><LoaderCircle className="spin" size={18} />正在读取邀请设置…</div>
        ) : (
          <>
            {error && <p className="user-panel-error" role="alert"><AlertCircle size={16} />{error}</p>}
            <form className="invite-form" onSubmit={(event) => void createInvite(event)}>
              <fieldset className="invite-mode invite-address-mode">
                <legend>邮箱分配方式</legend>
                <label className={draft.addressMode === 'assigned' ? 'is-selected' : ''}>
                  <input
                    type="radio"
                    name="address-mode"
                    checked={draft.addressMode === 'assigned'}
                    onChange={() => setDraft({
                      ...draft,
                      addressMode: 'assigned',
                      multiUse: false,
                      mailboxLimit: 1,
                      canCreateMailboxes: false,
                    })}
                  />
                  <span><strong>管理员指定邮箱</strong><small>提前固定完整地址；用户注册后直接使用，不能自行新增或更改。</small></span>
                </label>
                <label className={draft.addressMode === 'self_selected' ? 'is-selected' : ''}>
                  <input
                    type="radio"
                    name="address-mode"
                    checked={draft.addressMode === 'self_selected'}
                    onChange={() => setDraft({ ...draft, addressMode: 'self_selected' })}
                  />
                  <span><strong>用户自选邮箱</strong><small>管理员固定域名后缀，用户注册时填写尚未使用的邮箱前缀。</small></span>
                </label>
              </fieldset>

              <div className="invite-form-grid">
                <div className="invite-field">
                  <span>指定邮箱域名</span>
                  <InviteSelect
                    value={draft.domain}
                    label="指定邮箱域名"
                    disabled={!activeDomains.length}
                    options={activeDomains.map((domain) => ({
                      value: domain.name,
                      label: domain.name,
                    }))}
                    onChange={(domain) => setDraft({ ...draft, domain })}
                  />
                  <small>{draft.addressMode === 'assigned' ? '该域名将与下方前缀组成固定邮箱。' : '用户只能填写 @ 前面的邮箱名称。'}</small>
                </div>
                <div className="invite-field">
                  <span>链接有效时间</span>
                  <InviteSelect
                    value={String(draft.expiresInHours)}
                    label="链接有效时间"
                    options={[
                      { value: '1', label: '1 小时' },
                      { value: '6', label: '6 小时' },
                      { value: '24', label: '24 小时' },
                      { value: '72', label: '3 天' },
                      { value: '168', label: '7 天' },
                      { value: '720', label: '30 天' },
                    ]}
                    onChange={(value) => setDraft({
                      ...draft,
                      expiresInHours: Number(value),
                    })}
                  />
                  <small>只控制这个链接可以注册到什么时候。</small>
                </div>
                <div className="invite-field">
                  <span>临时账号有效时间</span>
                  <InviteSelect
                    value={String(draft.accountLifetimeHours)}
                    label="临时账号有效时间"
                    options={[
                      { value: '1', label: '1 小时' },
                      { value: '6', label: '6 小时' },
                      { value: '24', label: '24 小时' },
                      { value: '72', label: '3 天' },
                      { value: '168', label: '7 天' },
                      { value: '720', label: '30 天' },
                    ]}
                    onChange={(value) => setDraft({
                      ...draft,
                      accountLifetimeHours: Number(value),
                    })}
                  />
                  <small title="从注册成功起计算；账号到期删除，邮箱保留。">
                    注册后计时；删账号、留邮箱。
                  </small>
                </div>
              </div>

              {draft.addressMode === 'assigned' && (
                <label className="invite-admin-address">
                  <span>管理员指定邮箱</span>
                  <span>
                    <AtSign size={16} />
                    <input
                      value={draft.assignedLocalPart}
                      onChange={(event) => setDraft({
                        ...draft,
                        assignedLocalPart: event.target.value.toLowerCase(),
                      })}
                      maxLength={64}
                      placeholder="temporary-user"
                      pattern="[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+"
                      required
                    />
                    <strong>@{draft.domain || '请选择域名'}</strong>
                  </span>
                  <small>地址会立即为这个邀请预留，注册后成为固定的登录邮箱和收件地址。</small>
                </label>
              )}

              <fieldset className={`invite-mode ${draft.addressMode === 'assigned' ? 'invite-mode--single' : ''}`}>
                <legend>链接使用方式</legend>
                <label className={!draft.multiUse ? 'is-selected' : ''}>
                  <input
                    type="radio"
                    name="invite-mode"
                    checked={!draft.multiUse}
                    onChange={() => setDraft({ ...draft, multiUse: false })}
                  />
                  <span><strong>单次使用</strong><small>{draft.addressMode === 'assigned' ? '固定邮箱只能分配给一个临时用户。' : '首个用户成功注册后，链接立即失效。'}</small></span>
                </label>
                {draft.addressMode === 'self_selected' && (
                  <label className={`${draft.multiUse ? 'is-selected' : ''} ${!registrationProtectionReady ? 'is-disabled' : ''}`}>
                    <input
                      type="radio"
                      name="invite-mode"
                      checked={draft.multiUse}
                      disabled={!registrationProtectionReady}
                      onChange={() => setDraft({ ...draft, multiUse: true })}
                    />
                    <span>
                      <strong>多人注册</strong>
                      <small>{registrationProtectionReady
                        ? '有效期内可多人注册，每次注册都需要通过 Turnstile。'
                        : '配置 Turnstile 后才能创建多人注册链接。'}</small>
                    </span>
                  </label>
                )}
              </fieldset>

              <div className="invite-permissions">
                {draft.addressMode === 'self_selected' && (
                  <>
                    <label className="policy-toggle">
                      <span><MailPlus size={17} /><span><strong>允许继续添加邮箱</strong><small>注册时创建的首个邮箱不受此开关影响</small></span></span>
                      <input
                        type="checkbox"
                        checked={draft.canCreateMailboxes}
                        onChange={(event) => setDraft({
                          ...draft,
                          canCreateMailboxes: event.target.checked,
                          mailboxLimit: event.target.checked ? Math.max(2, draft.mailboxLimit) : 1,
                        })}
                      />
                    </label>
                    <label className="invite-limit">
                      <span>邮箱总数上限</span>
                      <input
                        type="number"
                        min={draft.canCreateMailboxes ? 2 : 1}
                        max={100}
                        disabled={!draft.canCreateMailboxes}
                        value={draft.mailboxLimit}
                        onChange={(event) => setDraft({
                          ...draft,
                          mailboxLimit: Math.max(2, Math.min(100, Number(event.target.value))),
                        })}
                      />
                    </label>
                  </>
                )}
                <label className="policy-toggle">
                  <span><Send size={17} /><span><strong>允许使用 Resend 回信</strong><small>Worker 仍需配置有效的 Resend 服务</small></span></span>
                  <input
                    type="checkbox"
                    checked={draft.canReply}
                    onChange={(event) => setDraft({ ...draft, canReply: event.target.checked })}
                  />
                </label>
              </div>

              <button
                className="button button--primary invite-create-button"
                type="submit"
                disabled={saving || !draft.domain || (draft.addressMode === 'assigned' && !draft.assignedLocalPart.trim())}
              >
                {saving ? <LoaderCircle className="spin" size={17} /> : <Link2 size={17} />}
                {saving ? '正在生成…' : '生成邀请链接'}
              </button>
            </form>

            {createdLink && (
              <section className="created-invite" aria-live="polite">
                <div><Check size={17} /><span><strong>邀请链接已生成</strong><small>出于安全考虑，关闭窗口后将无法再次查看完整链接。</small></span></div>
                <label>
                  <span className="sr-only">新邀请链接</span>
                  <input value={createdLink} readOnly onFocus={(event) => event.target.select()} />
                  <button className="button button--secondary button--small" type="button" onClick={() => void copyLink()}>
                    {copied ? <Check size={15} /> : <Copy size={15} />}{copied ? '已复制' : '复制'}
                  </button>
                </label>
              </section>
            )}

            <section className="invite-history">
              <header>
                <div><h3>最近邀请</h3><p>历史记录仅显示状态，不保存可复制的明文链接。</p></div>
                <span>{invites.length} 条</span>
              </header>
              {!invites.length ? (
                <div className="invite-empty"><UserRoundPlus size={21} />还没有临时用户邀请。</div>
              ) : (
                <div className="invite-list">
                  {invites.map((invite) => (
                    <article className="invite-row" key={invite.id}>
                      <span className="invite-domain"><Globe2 size={16} /><span><strong>{invite.assignedAddress || invite.domain}</strong><small>{invite.addressMode === 'assigned' ? '管理员指定 · 单次使用' : `${invite.multiUse ? `用户自选 · 已注册 ${invite.useCount} 人` : '用户自选 · 单次使用'}`}</small></span></span>
                      <span title={`账号注册后可用 ${formatDuration(invite.accountLifetimeHours)}`}><Clock3 size={15} />{formatDate(invite.expiresAt)} · 账号 {formatDuration(invite.accountLifetimeHours)}</span>
                      <span><ShieldCheck size={15} />{invite.canCreateMailboxes ? `最多 ${invite.mailboxLimit} 个邮箱` : '仅首个邮箱'}{invite.canReply ? ' · 可回信' : ''}</span>
                      <span className={`invite-state invite-state--${invite.state}`}>{stateLabels[invite.state]}</span>
                      {invite.state === 'active' && (
                        <button type="button" onClick={() => void revoke(invite)}>撤销</button>
                      )}
                    </article>
                  ))}
                  {page.hasMore && (
                    <button
                      className="button button--secondary invite-load-more"
                      type="button"
                      disabled={loadingMore}
                      onClick={() => void loadMoreInvites()}
                    >
                      {loadingMore && <LoaderCircle className="spin" size={15} />}
                      {loadingMore ? '正在加载…' : '加载更多邀请'}
                    </button>
                  )}
                </div>
              )}
            </section>
          </>
        )}
      </section>
    </div>
  )
}
