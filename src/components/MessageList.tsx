import {
  AlertCircle,
  AtSign,
  CheckCheck,
  Inbox,
  LoaderCircle,
  Mail,
  MailOpen,
  Paperclip,
  RotateCcw,
  Star,
  StarOff,
  Trash2,
} from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { Folder, MessageSummary, PageInfo } from '../lib/api'
import type { BulkMessageAction } from '../lib/messageActions'
import { t } from '../lib/i18n'
import { formatMessageDate, senderLabel } from '../lib/mailFormatting'

function SelectionCheckbox({
  checked,
  indeterminate = false,
  label,
  onChange,
}: {
  checked: boolean
  indeterminate?: boolean
  label: string
  onChange: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])
  return <input ref={ref} type="checkbox" checked={checked} aria-label={label} onChange={onChange} />
}

function BulkToolbar({
  folder,
  messages,
  selectedIds,
  loading,
  onSelectAll,
  onAction,
}: {
  folder: Folder
  messages: MessageSummary[]
  selectedIds: ReadonlySet<string>
  loading: boolean
  onSelectAll: () => void
  onAction: (action: BulkMessageAction) => void
}) {
  const selectable = messages.slice(0, 50)
  const allSelected = selectable.length > 0
    && selectable.every((message) => selectedIds.has(message.id))
  const someSelected = selectedIds.size > 0
  const actions: Array<[BulkMessageAction, string, typeof Mail]> = folder === 'trash'
    ? [
        ['restore', t('恢复所选邮件'), RotateCcw],
        ['delete', t('永久删除所选邮件'), Trash2],
      ]
    : [
        ['read', t('标记为已读'), MailOpen],
        ['unread', t('标记为未读'), Mail],
        ['star', t('添加星标'), Star],
        ['unstar', t('取消星标'), StarOff],
        ['trash', t('移入垃圾箱'), Trash2],
      ]

  return (
    <div className={`bulk-toolbar${someSelected ? ' is-active' : ''}`} aria-label={t('批量邮件操作')}>
      <label>
        <SelectionCheckbox
          checked={allSelected}
          indeterminate={someSelected && !allSelected}
          label={t('选择当前已加载邮件')}
          onChange={onSelectAll}
        />
        <span>{someSelected
          ? t('已选择 {count} 封', { count: selectedIds.size })
          : t('批量选择')}</span>
      </label>
      {someSelected && <div>
        {actions.map(([action, label, Icon]) => (
          <button key={action} type="button" disabled={loading}
            aria-label={label} data-tooltip={label} onClick={() => onAction(action)}>
            {loading ? <LoaderCircle className="spin" size={15} /> : <Icon size={15} />}
          </button>
        ))}
      </div>}
    </div>
  )
}

export function MessageList({
  folder,
  messages,
  selectedId,
  selectedIds,
  loading,
  bulkLoading,
  showMailbox,
  page,
  loadingMore,
  onSelect,
  onToggleSelection,
  onSelectAll,
  onBulkAction,
  onStar,
  onLoadMore,
}: {
  folder: Folder
  messages: MessageSummary[]
  selectedId: string | null
  selectedIds: ReadonlySet<string>
  loading: boolean
  bulkLoading: boolean
  showMailbox: boolean
  page: PageInfo
  loadingMore: boolean
  onSelect: (message: MessageSummary) => void
  onToggleSelection: (message: MessageSummary) => void
  onSelectAll: () => void
  onBulkAction: (action: BulkMessageAction) => void
  onStar: (message: MessageSummary) => void
  onLoadMore: () => void
}) {
  if (loading) {
    return <div className="list-state" role="status">
      <LoaderCircle className="spin" size={21} /><span>{t('正在读取邮件')}</span>
    </div>
  }
  if (!messages.length) {
    return <div className="list-state list-state--empty">
      <span className="empty-symbol"><Inbox size={24} /></span>
      <strong>{t('这里还是空的')}</strong><span>{t('新邮件到达后会出现在这里。')}</span>
    </div>
  }

  return <div className="message-list" role="listbox" aria-label={t('邮件列表')}>
    <BulkToolbar folder={folder} messages={messages} selectedIds={selectedIds}
      loading={bulkLoading} onSelectAll={onSelectAll} onAction={onBulkAction} />
    {messages.map((message) => (
      <article
        className={`message-row ${!message.isRead ? 'is-unread' : ''} ${selectedId === message.id ? 'is-selected' : ''} ${selectedIds.has(message.id) ? 'is-checked' : ''}`}
        key={message.id} role="option" aria-selected={selectedId === message.id}
      >
        <span className="message-row__check">
          <SelectionCheckbox checked={selectedIds.has(message.id)}
            label={t('选择邮件：{subject}', { subject: message.subject })}
            onChange={() => onToggleSelection(message)} />
        </span>
        <button className="message-row__main" type="button" onClick={() => onSelect(message)}
          data-tooltip={message.subject.length > 40 ? message.subject : undefined}>
          <span className="message-row__top">
            <strong>{senderLabel(message)}</strong>
            <time dateTime={new Date(message.date).toISOString()}>{formatMessageDate(message.date)}</time>
          </span>
          <span className="message-row__subject">
            {message.status === 'processing' && <LoaderCircle className="spin" size={13} />}
            {message.status === 'failed' && <AlertCircle size={13} />}
            <span className="message-row__subject-text">{message.subject}</span>
          </span>
          <span className="message-row__preview">{message.preview || t('暂无正文预览')}</span>
          {showMailbox && <span className="mailbox-hint"><AtSign size={12} />{message.mailboxAddress}</span>}
          {message.attachmentCount > 0 && <span className="attachment-hint">
            <Paperclip size={12} /> {message.attachmentCount}
          </span>}
        </button>
        <button className={`row-star ${message.isStarred ? 'is-active' : ''}`}
          type="button" onClick={() => onStar(message)}
          aria-label={t(message.isStarred ? '取消星标' : '添加星标')}
          data-tooltip={t(message.isStarred ? '取消星标' : '添加星标')}>
          <Star size={16} fill={message.isStarred ? 'currentColor' : 'none'} />
        </button>
      </article>
    ))}
    {page.hasMore && <button className="button button--secondary message-load-more"
      type="button" disabled={loadingMore} onClick={onLoadMore}>
      {loadingMore && <LoaderCircle className="spin" size={15} />}
      {t(loadingMore ? '正在加载…' : '加载更多邮件')}
    </button>}
  </div>
}
