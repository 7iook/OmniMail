import {
  BarChart3,
  Inbox,
  LogOut,
  ScrollText,
  Send,
  Settings2,
  Star,
  Trash2,
  UserCog,
  Users,
} from 'lucide-react'
import { type Folder, type MailCounts, type User } from '../lib/api'
import { t } from '../lib/i18n'
import { isAdminRole, roleLabel } from '../lib/roles'
import { Brand, ThemeToggle } from './AuthPages'
import { LanguageQuickToggle } from './LanguageToggle'

export type AdminView = 'statistics' | 'users' | 'logs' | 'settings' | 'account'

const folders: Array<{
  id: Folder
  label: string
  icon: typeof Inbox
  count: keyof MailCounts
}> = [
  { id: 'inbox', label: '收件箱', icon: Inbox, count: 'unread' },
  { id: 'starred', label: '星标邮件', icon: Star, count: 'starred' },
  { id: 'sent', label: '已发送', icon: Send, count: 'sent' },
  { id: 'trash', label: '垃圾箱', icon: Trash2, count: 'trash' },
]

const adminItems: Array<{
  id: Exclude<AdminView, 'account'>
  label: string
  icon: typeof BarChart3
}> = [
  { id: 'statistics', label: '统计', icon: BarChart3 },
  { id: 'users', label: '用户', icon: Users },
  { id: 'logs', label: '操作日志', icon: ScrollText },
  { id: 'settings', label: '系统设置', icon: Settings2 },
]

export function folderLabel(folder: Folder): string {
  return t(folders.find((item) => item.id === folder)?.label || '收件箱')
}

export function MailboxSidebar({
  user,
  folder,
  counts,
  adminView,
  onFolderChange,
  onAdminViewChange,
  onLogout,
}: {
  user: User
  folder: Folder
  counts: MailCounts
  adminView: AdminView | null
  onFolderChange: (folder: Folder) => void
  onAdminViewChange: (view: AdminView) => void
  onLogout: () => Promise<void>
}) {
  const showAdmin = isAdminRole(user.role)

  return (
    <aside className={`mail-sidebar ${showAdmin ? 'is-admin' : ''}`}>
      <div className="sidebar-brand"><Brand /></div>
      <div className="sidebar-theme">
        <ThemeToggle />
        <LanguageQuickToggle />
      </div>
      <nav className="folder-nav" aria-label={t('邮箱文件夹')}>
        {folders.map((item) => {
          const Icon = item.icon
          const count = counts[item.count]
          return (
            <button
              className={!adminView && folder === item.id ? 'is-active' : ''}
              type="button"
              key={item.id}
              onClick={() => onFolderChange(item.id)}
            >
              <Icon
                size={18}
                fill={item.id === 'starred' && !adminView && folder === item.id
                  ? 'currentColor'
                  : 'none'}
              />
              <span>{t(item.label)}</span>
              {count > 0 && <small>{count > 99 ? '99+' : count}</small>}
            </button>
          )
        })}
      </nav>

      {showAdmin && (
        <nav className="admin-nav" aria-label={t('管理员功能')}>
          {adminItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                className={adminView === item.id ? 'is-active' : ''}
                type="button"
                key={item.id}
                onClick={() => onAdminViewChange(item.id)}
              >
                <Icon size={18} />
                <span>{t(item.label)}</span>
              </button>
            )
          })}
        </nav>
      )}

      <nav className="account-nav" aria-label={t('个人账户')}>
        <button
          className={adminView === 'account' ? 'is-active' : ''}
          type="button"
          onClick={() => onAdminViewChange('account')}
        >
          <UserCog size={18} />
          <span>{t('账号设置')}</span>
        </button>
      </nav>

      <div className="sidebar-account">
        <span className="account-avatar">{user.displayName.slice(0, 1).toUpperCase()}</span>
        <div>
          <strong>{user.displayName}</strong>
          <span>{user.email}</span>
          <small className="account-role">{roleLabel(user.role)}</small>
        </div>
        <button
          className="icon-button icon-button--small"
          type="button"
          onClick={() => void onLogout()}
          aria-label={t('退出登录')}
          data-tooltip={t('退出登录')}
        >
          <LogOut size={16} />
        </button>
      </div>
    </aside>
  )
}
