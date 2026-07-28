import { Copy, RefreshCw, SquarePen } from 'lucide-react'
import { useState } from 'react'
import type {
  ManagedDomain,
  MailboxAddress,
  MailboxScope,
} from '../lib/api'
import { t } from '../lib/i18n'
import { ComposeDialog } from './ComposeDialog'
import { QuickMailboxGenerator } from './QuickMailboxGenerator'

interface Props {
  mailboxes: MailboxAddress[]
  domains: ManagedDomain[]
  scope: MailboxScope
  canGenerate: boolean
  canCompose: boolean
  refreshing: boolean
  onRefresh: () => void
  onCopied: (address: string) => void
  onCopyError: () => void
  onMailboxCreated: (mailbox: MailboxAddress) => Promise<void>
  onMessageSent: () => void
}

export function MailboxHeaderActions({
  mailboxes,
  domains,
  scope,
  canGenerate,
  canCompose,
  refreshing,
  onRefresh,
  onCopied,
  onCopyError,
  onMailboxCreated,
  onMessageSent,
}: Props) {
  const [composeOpen, setComposeOpen] = useState(false)
  const activeMailboxes = mailboxes.filter((mailbox) => mailbox.isActive)
  const address = scope.type === 'mailbox'
    ? scope.value
    : activeMailboxes.find((mailbox) => mailbox.isPrimary)?.address
      || activeMailboxes[0]?.address
      || ''

  async function copy() {
    if (!address) return
    try {
      await navigator.clipboard.writeText(address)
      onCopied(address)
    } catch {
      onCopyError()
    }
  }

  return (
    <div className="list-header__actions">
      <button className="button button--primary compose-trigger" type="button"
        onClick={() => setComposeOpen(true)} disabled={!canCompose || !address}
        aria-label={t('新建邮件')}
        data-tooltip={!canCompose ? t('当前账户没有发信权限。') : t('新建邮件')}>
        <SquarePen size={17} />
      </button>
      <button
        className="icon-button"
        type="button"
        onClick={() => void copy()}
        aria-label={`${t('复制当前邮箱')}${address ? ` ${address}` : ''}`}
        data-tooltip={address ? `${t('复制当前邮箱')} ${address}` : t('暂无可复制邮箱')}
        disabled={!address}
      >
        <Copy size={17} />
      </button>
      <QuickMailboxGenerator
        domains={domains}
        disabled={!canGenerate}
        onCreated={onMailboxCreated}
      />
      <button className="icon-button" type="button" onClick={onRefresh} aria-label={t('刷新邮件')} data-tooltip={t('刷新')}>
        <RefreshCw className={refreshing ? 'spin' : ''} size={17} />
      </button>
      {composeOpen && (
        <ComposeDialog
          mailboxes={activeMailboxes}
          initialMailbox={address}
          onClose={() => setComposeOpen(false)}
          onSent={() => {
            setComposeOpen(false)
            onMessageSent()
          }}
        />
      )}
    </div>
  )
}
