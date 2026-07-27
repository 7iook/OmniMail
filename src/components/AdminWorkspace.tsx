import { BarChart3, Clock3, Mail, Send, Settings2, ShieldCheck, Users } from 'lucide-react'
import {
  type AppConfig,
  type ManagedDomain,
  type MailboxAddress,
  type User,
} from '../lib/api'
import { AccountSettings } from './AccountSettings'
import { AdminPageHeader } from './AdminPageHeader'
import { AuditLogs } from './AuditLogs'
import { DomainManagement } from './DomainManagement'
import type { AdminView } from './MailboxSidebar'
import { MailStatistics } from './MailStatistics'
import { UserManagement } from './UserManagement'

function Status({ enabled, children }: { enabled: boolean; children: string }) {
  return (
    <span className={`admin-status ${enabled ? 'is-ready' : ''}`}>
      <span aria-hidden="true" />
      {children}
    </span>
  )
}

export function AdminWorkspace({
  view,
  user,
  config,
  mailboxes,
  domains,
  onDomainsChanged,
  onUserChange,
  onLogout,
}: {
  view: AdminView
  user: User
  config: AppConfig
  mailboxes: MailboxAddress[]
  domains: ManagedDomain[]
  onDomainsChanged: () => Promise<void>
  onUserChange: (user: User) => void
  onLogout: () => Promise<void>
}) {
  if (view === 'users') return <UserManagement currentUser={user} />
  if (view === 'logs') return <AuditLogs />
  if (view === 'account') {
    return <AccountSettings user={user} onUserChange={onUserChange} onLogout={onLogout} />
  }

  const activeMailboxes = mailboxes.filter((mailbox) => mailbox.isActive)
  if (view === 'statistics') {
    return (
      <main className="admin-workspace">
        <AdminPageHeader
          icon={BarChart3}
          eyebrow="ADMIN · ALL MAILBOXES"
          title="邮箱统计"
          description="查看全站收件趋势、来源域名和高频发件人。"
        />
        <MailStatistics />
      </main>
    )
  }

  return (
    <main className="admin-workspace">
      <AdminPageHeader
        icon={Settings2}
        eyebrow="ADMIN · SYSTEM"
        title="系统设置"
        description="集中管理全局域名、账户权限模型和邮件服务配置。"
      />

      <div className="admin-detail-grid">
        <DomainManagement domains={domains} onChanged={onDomainsChanged} />

        <section className="admin-card admin-card--settings">
          <header>
            <ShieldCheck size={17} />
            <div>
              <h2>主管理员</h2>
              <p>系统最高权限登录身份</p>
            </div>
          </header>
          <dl className="settings-list">
            <div>
              <dt><Mail size={15} />配置邮箱</dt>
              <dd>{config.superAdminEmail || '未配置 SUPER_ADMIN_EMAIL'}</dd>
            </div>
            <div>
              <dt><ShieldCheck size={15} />身份来源</dt>
              <dd>Worker 环境变量</dd>
            </div>
          </dl>
          <p className="admin-note">
            修改主管理员邮箱需要前往 Cloudflare Worker 的 Variables & Secrets，
            更新 `SUPER_ADMIN_EMAIL` 后重新部署或重启 Worker。
          </p>
        </section>

        <section className="admin-card admin-card--settings">
          <header>
            <Users size={17} />
            <div>
              <h2>账户类型</h2>
              <p>权限模型已经预留</p>
            </div>
          </header>
          <div className="role-list">
            <div><ShieldCheck size={16} /><strong>管理员</strong><Status enabled>已启用</Status></div>
            <div><Users size={16} /><strong>普通用户</strong><Status enabled={false}>按用户配置</Status></div>
            <div><Clock3 size={16} /><strong>临时用户</strong><Status enabled={false}>按用户配置</Status></div>
          </div>
        </section>

        <section className="admin-card admin-card--settings">
          <header>
            <Send size={17} />
            <div>
              <h2>邮件服务</h2>
              <p>当前 Worker 功能状态</p>
            </div>
          </header>
          <div className="service-status-list">
            <div><span>Cloudflare Email Routing</span><Status enabled>收件已启用</Status></div>
            <div><span>Resend 回复</span><Status enabled={config.replyEnabled}>{config.replyEnabled ? '已配置' : '未配置'}</Status></div>
            <div><span>收件地址</span><strong>{activeMailboxes.length}</strong></div>
          </div>
        </section>
      </div>
    </main>
  )
}
