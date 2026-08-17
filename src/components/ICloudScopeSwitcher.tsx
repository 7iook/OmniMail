import { AtSign, Check, ChevronDown, Cloud, Inbox, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ICloudAccount, ICloudAlias } from '../lib/api'
import { t } from '../lib/i18n'

export function ICloudScopeSwitcher({
  accounts,
  aliases,
  selectedAccountId,
  selectedAlias,
  onAccountChange,
  onAliasChange,
}: {
  accounts: ICloudAccount[]
  aliases: ICloudAlias[]
  selectedAccountId: string
  selectedAlias: string
  onAccountChange: (id: string) => void
  onAliasChange: (address: string) => void
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const account = accounts.find((item) => item.id === selectedAccountId)

  useEffect(() => {
    if (!open) return
    requestAnimationFrame(() => panel.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      requestAnimationFrame(() => trigger.current?.focus())
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  function close() {
    setOpen(false)
    requestAnimationFrame(() => trigger.current?.focus())
  }

  return (
    <div className="icloud-scope-switcher">
      <button ref={trigger} className="icloud-scope-trigger" type="button"
        aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span>{t('当前 iCloud')}</span>
        <strong>{account?.name || t('选择账号')}</strong>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && <>
        <button className="icloud-scope-backdrop" type="button" tabIndex={-1}
          aria-hidden="true" onClick={close} />
        <div ref={panel} className="icloud-scope-panel" role="dialog" aria-modal="true"
          aria-labelledby="icloud-scope-title" tabIndex={-1}>
          <header>
            <div><small>ICLOUD SCOPE</small><h2 id="icloud-scope-title">{t('选择查看范围')}</h2></div>
            <button className="icon-button icon-button--small" type="button" onClick={close}
              aria-label={t('关闭')}><X size={16} /></button>
          </header>
          <div className="icloud-scope-content">
            <section>
              <h3>{t('iCloud 账号')}</h3>
              {accounts.map((item) => (
                <button className={item.id === selectedAccountId ? 'is-selected' : ''}
                  type="button" key={item.id} onClick={() => { onAccountChange(item.id); close() }}>
                  <span className="icloud-scope-icon"><Cloud size={16} /></span>
                  <span><strong>{item.name}</strong><small>{item.realEmail || item.icloudEmail || t('尚未识别 Apple ID')}</small></span>
                  {item.id === selectedAccountId && <Check size={15} />}
                </button>
              ))}
            </section>
            <section>
              <h3>{t('收件地址')}</h3>
              <button className={!selectedAlias ? 'is-selected' : ''} type="button"
                onClick={() => { onAliasChange(''); close() }}>
                <span className="icloud-scope-icon"><Inbox size={16} /></span>
                <span><strong>{t('全部邮件')}</strong><small>{t('所有收件地址')}</small></span>
                {!selectedAlias && <Check size={15} />}
              </button>
              {aliases.map((alias) => (
                <button className={alias.email === selectedAlias ? 'is-selected' : ''}
                  type="button" key={alias.anonymousId || alias.email}
                  onClick={() => { onAliasChange(alias.email); close() }}>
                  <span className="icloud-scope-icon"><AtSign size={16} /></span>
                  <span><strong>{alias.label || t('未命名地址')}</strong><small>{alias.email}</small></span>
                  {alias.email === selectedAlias && <Check size={15} />}
                </button>
              ))}
            </section>
          </div>
        </div>
      </>}
    </div>
  )
}
