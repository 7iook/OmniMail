import {
  KeyRound, LoaderCircle, Mail, Paperclip, Plus, Search,
} from 'lucide-react'
import type { MicrosoftAccount, MicrosoftMessageSummary, PageInfo } from '../../../shared/api'
import { t } from '../../../shared/i18n'
import { isMicrosoftJunkFolderPath } from '../microsoft-constants'

export function MicrosoftMessageList({
  enabled, loading, accounts, accountId, searchQuery, messages, selectedId, page, loadingMore,
  onSelect, onLoadMore, onAddAccount,
}: {
  enabled: boolean
  loading: boolean
  accounts: MicrosoftAccount[]
  accountId: string
  searchQuery: string
  messages: MicrosoftMessageSummary[]
  selectedId: string | null
  page: PageInfo
  loadingMore: boolean
  onSelect: (message: MicrosoftMessageSummary) => void
  onLoadMore: () => void
  onAddAccount: () => void
}) {
  // Q1: the aggregate view spans INBOX and Junk Email (card C-4); a single
  // account/folder view never needs the label since the user already knows
  // which folder they picked.
  const showJunkLabels = !accountId

  return <div className="gmail-message-list" aria-busy={loading}>
    {!enabled ? <div className="icloud-empty"><span><KeyRound size={24} /></span>
      <h3>{t('Microsoft 邮箱功能尚未启用')}</h3>
      <p>{t('配置至少 32 字节的 MICROSOFT_CREDENTIALS_KEY，并启用 MICROSOFT_MAIL_ENABLED 后重新部署。')}</p></div>
      : loading ? <div className="gmail-list-state" role="status"><LoaderCircle className="spin" size={21} />{t('正在读取 Microsoft 邮件索引…')}</div>
        : !accounts.length ? <div className="gmail-list-state gmail-list-state--empty"><span><Mail size={25} /></span>
          <h2>{t('连接你的第一个 Microsoft 邮箱')}</h2><p>{t('仅支持 OAuth2；不再接受仅邮箱密码登录。')}</p>
          <button className="button button--primary" type="button" onClick={onAddAccount}><Plus size={16} />{t('添加 Microsoft 账号')}</button></div>
          : !messages.length ? <div className="gmail-list-state gmail-list-state--empty"><span>{searchQuery ? <Search size={25} /> : <Mail size={25} />}</span>
            <h2>{t(searchQuery ? '未找到相关 Microsoft 邮件' : '当前文件夹还没有索引邮件')}</h2>
            <p>{t(searchQuery ? '请尝试其他关键词。' : accountId
              ? '可远程刷新当前文件夹，或等待后台定时同步 INBOX。'
              : '可同步全部 Microsoft 账号，或等待后台定时同步 INBOX。')}</p></div>
            : <div className="message-list-shell"><div className="message-list" role="listbox" aria-label={t('Microsoft 邮件列表')}>
              {messages.map((message) => {
                const active = selectedId === message.id
                const sender = message.senderName || message.senderAddress || t('未知发件人')
                const isJunk = showJunkLabels && isMicrosoftJunkFolderPath(message.folderPath)
                return <article className={`message-row${message.isRead ? '' : ' is-unread'}${active ? ' is-selected' : ''}`}
                  role="option" aria-selected={active} key={message.id}>
                  <button className="message-row__main" type="button" onClick={() => onSelect(message)}>
                    <span className="message-row__top"><strong>{sender}</strong><time dateTime={new Date(message.date * 1000).toISOString()}>
                      {new Date(message.date * 1000).toLocaleDateString()}</time></span>
                    <span className="message-row__subject"><span className="message-row__subject-text">{message.subject || t('无主题')}</span></span>
                    <span className="message-row__preview">{message.preview || t('邮件正文将在打开时按需读取')}</span>
                    <span className="mailbox-hint"><Mail size={12} />{message.account.name}</span>
                    {isJunk && <span className="icloud-source-badge">{t('垃圾邮件')}</span>}
                    {message.hasAttachments && <span className="attachment-hint"><Paperclip size={12} />{t('附件')}</span>}
                  </button>{!message.isRead && <span className="message-row__unread-dot" aria-hidden="true" />}
                </article>
              })}
              {page.hasMore && <button className="gmail-load-more" type="button" disabled={loadingMore}
                onClick={onLoadMore}>{loadingMore && <LoaderCircle className="spin" size={15} />}{t('加载更多')}</button>}
            </div></div>}
  </div>
}
