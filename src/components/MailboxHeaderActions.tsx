import { Copy, RefreshCw } from 'lucide-react'
import type { MailboxAddress, MailboxScope } from '../lib/api'
import { ThemeToggle } from './AuthPages'

interface Props {
  mailboxes: MailboxAddress[]
  scope: MailboxScope
  refreshing: boolean
  onRefresh: () => void
  onCopied: (address: string) => void
  onCopyError: () => void
}

export function MailboxHeaderActions({
  mailboxes,
  scope,
  refreshing,
  onRefresh,
  onCopied,
  onCopyError,
}: Props) {
  const address = scope.type === 'mailbox'
    ? scope.value
    : mailboxes.find((mailbox) => mailbox.isPrimary && mailbox.isActive)?.address
      || mailboxes.find((mailbox) => mailbox.isActive)?.address
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
      <button
        className="icon-button"
        type="button"
        onClick={() => void copy()}
        aria-label={`复制当前邮箱${address ? ` ${address}` : ''}`}
        title={address ? `复制 ${address}` : '暂无可复制邮箱'}
        disabled={!address}
      >
        <Copy size={17} />
      </button>
      <ThemeToggle />
      <button className="icon-button" type="button" onClick={onRefresh} aria-label="刷新邮件" title="刷新">
        <RefreshCw className={refreshing ? 'spin' : ''} size={17} />
      </button>
    </div>
  )
}
