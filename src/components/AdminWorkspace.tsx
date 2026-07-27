import { AlertCircle, ArrowRight, BadgeCheck, Ban, BarChart3, Clock3, Image as ImageIcon, ListChecks, LoaderCircle, Mail, RefreshCw, Save, Send, Settings2, ShieldCheck, UserPlus, Users } from 'lucide-react'
import { useState } from 'react'
import {
  api,
  type AppConfig,
  type ManagedDomain,
  type MailRefreshInterval,
  type MailboxAddress,
  type RegistrationDomainPolicyMode,
  type User,
} from '../lib/api'
import { registrationDomainsFromText } from '../lib/registration'
import { AccountSettings } from './AccountSettings'
import { AdminPageHeader } from './AdminPageHeader'
import { AuditLogs } from './AuditLogs'
import { DomainManagement } from './DomainManagement'
import type { AdminView } from './MailboxSidebar'
import { MailStatistics } from './MailStatistics'
import { UserManagement } from './UserManagement'

const refreshOptions: Array<{ value: MailRefreshInterval; label: string }> = [
  { value: 5, label: '5 秒' },
  { value: 10, label: '10 秒' },
  { value: 30, label: '30 秒' },
  { value: 60, label: '60 秒' },
  { value: 120, label: '120 秒' },
  { value: 0, label: '不刷新' },
]

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
  onConfigChange,
  onUserChange,
  onLogout,
  onOpenDeploymentWizard,
}: {
  view: AdminView
  user: User
  config: AppConfig
  mailboxes: MailboxAddress[]
  domains: ManagedDomain[]
  onDomainsChanged: () => Promise<void>
  onConfigChange: (config: AppConfig) => void
  onUserChange: (user: User) => void
  onLogout: () => Promise<void>
  onOpenDeploymentWizard: () => void
}) {
  const [registrationSaving, setRegistrationSaving] = useState(false)
  const [registrationError, setRegistrationError] = useState('')
  const [registrationDomainMode, setRegistrationDomainMode] = useState<
    RegistrationDomainPolicyMode
  >(config.registrationDomainPolicy.mode)
  const [registrationDomainsDraft, setRegistrationDomainsDraft] = useState(
    () => config.registrationDomainPolicy.domains.join('\n'),
  )
  const [registrationDomainsSaving, setRegistrationDomainsSaving] = useState(false)
  const [registrationDomainsError, setRegistrationDomainsError] = useState('')
  const [refreshSaving, setRefreshSaving] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const [remoteImagesSaving, setRemoteImagesSaving] = useState(false)
  const [remoteImagesError, setRemoteImagesError] = useState('')

  async function toggleRegistration() {
    setRegistrationSaving(true)
    setRegistrationError('')
    try {
      const result = await api.updateRegistrationSetting(!config.registrationEnabled)
      onConfigChange({ ...config, registrationEnabled: result.registrationEnabled })
    } catch (error) {
      setRegistrationError(error instanceof Error ? error.message : '无法更新注册设置。')
    } finally {
      setRegistrationSaving(false)
    }
  }

  async function saveRefreshInterval(interval: MailRefreshInterval) {
    if (interval === config.mailRefreshInterval) return
    setRefreshSaving(true)
    setRefreshError('')
    try {
      const result = await api.updateMailRefreshInterval(interval)
      onConfigChange({ ...config, mailRefreshInterval: result.mailRefreshInterval })
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : '无法更新自动刷新设置。')
    } finally {
      setRefreshSaving(false)
    }
  }

  async function toggleRemoteImages() {
    setRemoteImagesSaving(true)
    setRemoteImagesError('')
    try {
      const result = await api.updateRemoteImagesSetting(!config.remoteImagesEnabled)
      onConfigChange({ ...config, remoteImagesEnabled: result.remoteImagesEnabled })
    } catch (error) {
      setRemoteImagesError(error instanceof Error ? error.message : '无法更新远程图片设置。')
    } finally {
      setRemoteImagesSaving(false)
    }
  }

  async function saveRegistrationDomains() {
    const domains = registrationDomainsFromText(registrationDomainsDraft)
    if (registrationDomainMode === 'allowlist' && domains.length === 0) {
      setRegistrationDomainsError('允许列表至少需要填写一个邮箱后缀。')
      return
    }
    setRegistrationDomainsSaving(true)
    setRegistrationDomainsError('')
    try {
      const result = await api.updateRegistrationDomainPolicy({
        mode: registrationDomainMode,
        domains,
      })
      const policy = result.registrationDomainPolicy
      setRegistrationDomainMode(policy.mode)
      setRegistrationDomainsDraft(policy.domains.join('\n'))
      onConfigChange({
        ...config,
        registrationDomainPolicy: policy,
      })
    } catch (error) {
      setRegistrationDomainsError(
        error instanceof Error ? error.message : '无法保存邮箱后缀限制。',
      )
    } finally {
      setRegistrationDomainsSaving(false)
    }
  }

  if (view === 'users') {
    return (
      <UserManagement
        currentUser={user}
        registrationProtectionReady={config.registrationProtectionReady}
      />
    )
  }
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
          <button
            className="deployment-launch"
            type="button"
            onClick={onOpenDeploymentWizard}
          >
            <span><ListChecks size={17} /><span><strong>部署初始化向导</strong><small>重新检查资源绑定与服务配置</small></span></span>
            <ArrowRight size={16} />
          </button>
        </section>

        <section className="admin-card admin-card--settings">
          <header>
            <RefreshCw size={17} />
            <div>
              <h2>邮件自动刷新</h2>
              <p>设置所有用户收件箱的轮询频率</p>
            </div>
          </header>
          <fieldset className="refresh-options" aria-busy={refreshSaving}>
            <legend>刷新间隔</legend>
            {refreshOptions.map((option) => (
              <label key={option.value}>
                <input
                  type="radio"
                  name="mail-refresh-interval"
                  value={option.value}
                  checked={config.mailRefreshInterval === option.value}
                  disabled={refreshSaving}
                  onChange={() => void saveRefreshInterval(option.value)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>
          <p className="refresh-setting-note">
            {refreshSaving && <LoaderCircle className="spin" size={14} />}
            {refreshSaving ? '正在保存全局设置…' : '页面处于后台时会暂停刷新，返回后继续。'}
          </p>
          {refreshError && (
            <p className="inline-error" role="alert">
              <AlertCircle size={15} />{refreshError}
            </p>
          )}
        </section>

        <section className="admin-card admin-card--settings">
          <header>
            <ImageIcon size={17} />
            <div>
              <h2>远程图片</h2>
              <p>设置所有用户查看 HTML 邮件时的默认策略</p>
            </div>
          </header>
          <label className="policy-toggle">
            <span>
              {remoteImagesSaving
                ? <LoaderCircle className="spin" size={17} />
                : <ImageIcon size={17} />}
              <span>
                <strong>{config.remoteImagesEnabled ? '默认加载远程图片' : '默认阻止远程图片'}</strong>
                <small>{config.remoteImagesEnabled
                  ? '邮件中的 HTTPS 远程图片会自动请求'
                  : '保护用户隐私，避免触发发件人的追踪像素'}</small>
              </span>
            </span>
            <input
              type="checkbox"
              checked={config.remoteImagesEnabled}
              disabled={remoteImagesSaving}
              aria-label="默认加载邮件中的远程图片"
              onChange={() => void toggleRemoteImages()}
            />
          </label>
          {remoteImagesError && (
            <p className="inline-error" role="alert">
              <AlertCircle size={15} />{remoteImagesError}
            </p>
          )}
          <p className="admin-note">
            开启后可能向图片服务器暴露访问时间和网络信息；邮件脚本、表单与嵌入页面仍会被阻止。
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
            <UserPlus size={17} />
            <div>
              <h2>外部注册</h2>
              <p>控制未登录访客是否可以创建普通账户</p>
            </div>
          </header>
          <label className="policy-toggle">
            <span>
              {registrationSaving ? <LoaderCircle className="spin" size={17} /> : <UserPlus size={17} />}
              <span>
                <strong>{config.registrationEnabled ? '允许外部注册' : '外部注册已关闭'}</strong>
                <small>
                  {config.registrationProtectionReady
                    ? 'Turnstile 已启用；新账户默认无创建邮箱和回信权限'
                    : '配置 Cloudflare Turnstile 后才能开启'}
                </small>
              </span>
            </span>
            <input
              type="checkbox"
              checked={config.registrationEnabled}
              disabled={registrationSaving || (
                !config.registrationProtectionReady && !config.registrationEnabled
              )}
              aria-label="允许外部注册"
              onChange={() => void toggleRegistration()}
            />
          </label>
          {registrationError && (
            <p className="inline-error" role="alert">
              <AlertCircle size={15} />{registrationError}
            </p>
          )}
          {!config.registrationProtectionReady && (
            <p className="admin-note">
              需要在 Worker 中配置 `TURNSTILE_SITE_KEY` 和
              `TURNSTILE_SECRET_KEY`，防止机器人批量注册。
            </p>
          )}
          <div className="registration-domain-policy">
            <fieldset className="registration-domain-mode">
              <legend>邮箱后缀规则</legend>
              <label className={registrationDomainMode === 'blocklist' ? 'is-selected' : ''}>
                <input
                  type="radio"
                  name="registration-domain-mode"
                  checked={registrationDomainMode === 'blocklist'}
                  onChange={() => {
                    setRegistrationDomainMode('blocklist')
                    setRegistrationDomainsError('')
                  }}
                />
                <span>
                  <Ban size={15} />
                  <span><strong>禁止列表</strong><small>列表内拒绝，其他邮箱允许注册</small></span>
                </span>
              </label>
              <label className={registrationDomainMode === 'allowlist' ? 'is-selected' : ''}>
                <input
                  type="radio"
                  name="registration-domain-mode"
                  checked={registrationDomainMode === 'allowlist'}
                  onChange={() => {
                    setRegistrationDomainMode('allowlist')
                    setRegistrationDomainsError('')
                  }}
                />
                <span>
                  <BadgeCheck size={15} />
                  <span><strong>允许列表</strong><small>仅列表内邮箱可以注册</small></span>
                </span>
              </label>
            </fieldset>
            <label htmlFor="registration-domain-list">
              <span>
                {registrationDomainMode === 'allowlist'
                  ? <BadgeCheck size={15} />
                  : <Ban size={15} />}
                {registrationDomainMode === 'allowlist'
                  ? '允许注册的邮箱后缀'
                  : '禁止注册的邮箱后缀'}
              </span>
              <textarea
                id="registration-domain-list"
                value={registrationDomainsDraft}
                rows={3}
                maxLength={26000}
                spellCheck={false}
                placeholder={'qq.com\n163.com'}
                onChange={(event) => {
                  setRegistrationDomainsDraft(event.target.value)
                  setRegistrationDomainsError('')
                }}
              />
            </label>
            <footer>
              <small>
                每行或逗号分隔，最多 100 个；
                {registrationDomainMode === 'allowlist'
                  ? '至少填写一个后缀。'
                  : '留空表示不限制。'}
              </small>
              <button
                className="button button--secondary button--small"
                type="button"
                disabled={registrationDomainsSaving}
                onClick={() => void saveRegistrationDomains()}
              >
                {registrationDomainsSaving
                  ? <LoaderCircle className="spin" size={14} />
                  : <Save size={14} />}
                {registrationDomainsSaving ? '保存中…' : '保存限制'}
              </button>
            </footer>
            {registrationDomainsError && (
              <p className="inline-error" role="alert">
                <AlertCircle size={15} />{registrationDomainsError}
              </p>
            )}
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
