import {
  ArrowLeft,
  AtSign,
  Check,
  ChevronDown,
  Globe2,
  Inbox,
  LoaderCircle,
  Plus,
  Settings2,
  X,
} from 'lucide-react'
import {
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  api,
  type ManagedDomain,
  type MailboxAddress,
  type MailboxScope,
} from '../lib/api'

interface Props {
  mailboxes: MailboxAddress[]
  domains: ManagedDomain[]
  scope: MailboxScope
  canManage: boolean
  onScopeChange: (scope: MailboxScope) => void
  onMailboxesChanged: () => Promise<void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试。'
}

function scopeMatches(scope: MailboxScope, type: MailboxScope['type'], value = ''): boolean {
  if (type === 'all') return scope.type === 'all'
  if (scope.type === 'all') return false
  return scope.type === type && scope.value === value
}

export function MailboxSwitcher({
  mailboxes,
  domains,
  scope,
  canManage,
  onScopeChange,
  onMailboxesChanged,
}: Props) {
  const [open, setOpen] = useState(false)
  const [managing, setManaging] = useState(false)
  const [localPart, setLocalPart] = useState('')
  const [domainName, setDomainName] = useState('')
  const [busyAddress, setBusyAddress] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const activeMailboxes = useMemo(
    () => mailboxes.filter((mailbox) => mailbox.isActive),
    [mailboxes],
  )
  const enabledDomains = useMemo(
    () => domains.filter((domain) => domain.isActive),
    [domains],
  )
  const groups = useMemo(() => {
    const grouped = new Map<string, MailboxAddress[]>()
    for (const mailbox of activeMailboxes) {
      const entries = grouped.get(mailbox.domain) || []
      entries.push(mailbox)
      grouped.set(mailbox.domain, entries)
    }
    return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))
  }, [activeMailboxes])
  const scopeLabel = scope.type === 'all' ? '所有邮箱' : scope.value

  useEffect(() => {
    if (enabledDomains.some((domain) => domain.name === domainName)) return
    setDomainName(enabledDomains[0]?.name || '')
  }, [domainName, enabledDomains])

  useEffect(() => {
    if (!open) return
    panelRef.current?.focus()
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') close()
      if (event.key !== 'Tab' || !panelRef.current) return
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )]
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [open])

  function close() {
    setOpen(false)
    setManaging(false)
    setError('')
    window.setTimeout(() => triggerRef.current?.focus(), 0)
  }

  function select(nextScope: MailboxScope) {
    onScopeChange(nextScope)
    close()
  }

  async function add(event: FormEvent) {
    event.preventDefault()
    const nextLocalPart = localPart.trim().toLowerCase()
    if (!nextLocalPart || !domainName) return
    const nextAddress = `${nextLocalPart}@${domainName}`
    setBusyAddress(nextAddress)
    setError('')
    setNotice('')
    try {
      const result = await api.addMailbox(nextAddress)
      await onMailboxesChanged()
      setLocalPart('')
      setNotice('邮箱地址已启用')
      onScopeChange({ type: 'mailbox', value: result.mailbox.address })
    } catch (addError) {
      setError(errorMessage(addError))
    } finally {
      setBusyAddress('')
    }
  }

  async function toggle(mailbox: MailboxAddress) {
    setBusyAddress(mailbox.address)
    setError('')
    setNotice('')
    try {
      await api.updateMailbox(mailbox.address, !mailbox.isActive)
      await onMailboxesChanged()
      if (mailbox.isActive && scope.type === 'mailbox' && scope.value === mailbox.address) {
        onScopeChange({ type: 'all' })
      }
      setNotice(mailbox.isActive ? '邮箱地址已停用' : '邮箱地址已启用')
    } catch (toggleError) {
      setError(errorMessage(toggleError))
    } finally {
      setBusyAddress('')
    }
  }

  return (
    <div className="mailbox-switcher">
      <button
        ref={triggerRef}
        className="mailbox-scope-trigger"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span>当前邮箱</span>
        <strong>{scopeLabel}</strong>
        <ChevronDown size={14} aria-hidden="true" />
      </button>

      {open && (
        <>
          <button
            className="switcher-backdrop"
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={close}
          />
          <div
            ref={panelRef}
            className="mailbox-switcher__panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mailbox-switcher-title"
            tabIndex={-1}
          >
            <header className="switcher-header">
              {managing && (
                <button
                  className="icon-button icon-button--small"
                  type="button"
                  onClick={() => {
                    setManaging(false)
                    setError('')
                    setNotice('')
                  }}
                  aria-label="返回邮箱选择"
                >
                  <ArrowLeft size={17} />
                </button>
              )}
              <div>
                <small>{managing ? 'SETTINGS' : 'MAILBOX SCOPE'}</small>
                <h2 id="mailbox-switcher-title">
                  {managing ? '管理邮箱地址' : '选择查看范围'}
                </h2>
              </div>
              <button
                className="icon-button icon-button--small"
                type="button"
                onClick={close}
                aria-label="关闭邮箱选择"
              >
                <X size={17} />
              </button>
            </header>

            {managing ? (
              <div className="mailbox-manager">
                <form className="mailbox-add-form" onSubmit={add}>
                  <label htmlFor="new-mailbox-local-part">新增邮箱地址</label>
                  <div>
                    <AtSign size={16} />
                    <input
                      id="new-mailbox-local-part"
                      type="text"
                      value={localPart}
                      onChange={(event) => setLocalPart(event.target.value)}
                      placeholder="hello"
                      autoComplete="off"
                      required
                    />
                    <span className="mailbox-domain-separator">@</span>
                    <select
                      value={domainName}
                      onChange={(event) => setDomainName(event.target.value)}
                      aria-label="邮箱域名"
                      disabled={!enabledDomains.length}
                      required
                    >
                      {enabledDomains.length ? enabledDomains.map((domain) => (
                        <option value={domain.name} key={domain.name}>{domain.name}</option>
                      )) : <option value="">暂无可用域名</option>}
                    </select>
                    <button
                      className="button button--primary button--small"
                      type="submit"
                      disabled={Boolean(busyAddress) || !localPart.trim() || !domainName}
                    >
                      {busyAddress === `${localPart.trim().toLowerCase()}@${domainName}`
                        ? <LoaderCircle className="spin" size={15} />
                        : <Plus size={15} />}
                      添加
                    </button>
                  </div>
                </form>
                <p className="mailbox-manager-note">
                  {enabledDomains.length
                    ? '只能在系统设置中已启用的域名下创建邮箱。'
                    : '系统尚未启用可创建邮箱的域名，请联系管理员。'}
                </p>

                <div className="managed-mailboxes">
                  {mailboxes.map((mailbox) => (
                    <div className="managed-mailbox" key={mailbox.address}>
                      <span className={mailbox.isActive ? 'is-active' : ''} aria-hidden="true" />
                      <div>
                        <strong>{mailbox.address}</strong>
                        <small>
                          {mailbox.isPrimary
                            ? '主邮箱 · 始终启用'
                            : mailbox.isActive ? '正在接收邮件' : '已停止接收新邮件'}
                        </small>
                      </div>
                      <button
                        className="button button--secondary button--small"
                        type="button"
                        disabled={mailbox.isPrimary || Boolean(busyAddress)}
                        onClick={() => void toggle(mailbox)}
                      >
                        {busyAddress === mailbox.address && (
                          <LoaderCircle className="spin" size={14} />
                        )}
                        {mailbox.isActive ? '停用' : '启用'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mailbox-scope-list">
                <button
                  className={scopeMatches(scope, 'all') ? 'is-selected' : ''}
                  type="button"
                  aria-pressed={scopeMatches(scope, 'all')}
                  onClick={() => select({ type: 'all' })}
                >
                  <span className="scope-icon"><Inbox size={17} /></span>
                  <span>
                    <strong>所有邮箱</strong>
                    <small>{activeMailboxes.length} 个启用地址</small>
                  </span>
                  {scopeMatches(scope, 'all') && <Check size={16} />}
                </button>

                {groups.map(([domain, addresses]) => (
                  <section className="mailbox-domain-group" key={domain}>
                    <button
                      className={scopeMatches(scope, 'domain', domain) ? 'is-selected' : ''}
                      type="button"
                      aria-pressed={scopeMatches(scope, 'domain', domain)}
                      onClick={() => select({ type: 'domain', value: domain })}
                    >
                      <span className="scope-icon"><Globe2 size={17} /></span>
                      <span>
                        <strong>{domain}</strong>
                        <small>{addresses.length} 个邮箱地址</small>
                      </span>
                      {scopeMatches(scope, 'domain', domain) && <Check size={16} />}
                    </button>
                    <div className="mailbox-address-list">
                      {addresses.map((mailbox) => (
                        <button
                          className={scopeMatches(scope, 'mailbox', mailbox.address)
                            ? 'is-selected'
                            : ''}
                          type="button"
                          key={mailbox.address}
                          aria-pressed={scopeMatches(scope, 'mailbox', mailbox.address)}
                          onClick={() => select({ type: 'mailbox', value: mailbox.address })}
                        >
                          <AtSign size={15} />
                          <span>{mailbox.address}</span>
                          {mailbox.isPrimary && <small>主邮箱</small>}
                          {scopeMatches(scope, 'mailbox', mailbox.address) && <Check size={15} />}
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}

            {(error || notice) && (
              <p className={error ? 'switcher-feedback is-error' : 'switcher-feedback'} role={error ? 'alert' : 'status'}>
                {error || notice}
              </p>
            )}
            {!managing && canManage && (
              <footer className="switcher-footer">
                <button
                  type="button"
                  onClick={() => {
                    setManaging(true)
                    setError('')
                    setNotice('')
                  }}
                >
                  <Settings2 size={16} />
                  管理邮箱地址
                </button>
              </footer>
            )}
          </div>
        </>
      )}
    </div>
  )
}
