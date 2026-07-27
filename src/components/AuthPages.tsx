import {
  AlertCircle,
  LoaderCircle,
  Mail,
  Monitor,
  Moon,
  RefreshCw,
  ShieldCheck,
  Sun,
} from 'lucide-react'
import { type FormEvent, useState, useSyncExternalStore } from 'react'
import { api, type User } from '../lib/api'
import {
  getThemePreference,
  setThemePreference,
  subscribeTheme,
} from '../lib/theme'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '发生了未知错误。'
}

export function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark" aria-hidden="true"><Mail size={17} /></span>
      <span>OmniMail</span>
    </span>
  )
}

export function ThemeToggle({ labeled = false }: { labeled?: boolean }) {
  const preference = useSyncExternalStore(
    subscribeTheme,
    getThemePreference,
    getThemePreference,
  )
  const choices = [
    { value: 'light' as const, label: '亮色', Icon: Sun },
    { value: 'dark' as const, label: '暗色', Icon: Moon },
    { value: 'system' as const, label: '跟随系统', Icon: Monitor },
  ]
  return (
    <div
      className={`theme-selector ${labeled ? 'is-labeled' : ''}`}
      role="radiogroup"
      aria-label="界面主题"
    >
      {choices.map(({ value, label, Icon }) => (
        <button
          className={preference === value ? 'is-selected' : ''}
          type="button"
          role="radio"
          aria-checked={preference === value}
          aria-label={`${label}主题`}
          title={label}
          key={value}
          onClick={() => setThemePreference(value)}
        >
          <Icon size={15} />
          {labeled && <span>{label}</span>}
        </button>
      ))}
    </div>
  )
}

export function PageLoader() {
  return (
    <div className="page-loader" role="status">
      <span className="brand-mark"><Mail size={19} /></span>
      <LoaderCircle className="spin" size={22} />
      <span>正在打开 OmniMail</span>
    </div>
  )
}

export function ConnectionError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <main className="center-page">
      <section className="auth-card error-card">
        <span className="auth-symbol auth-symbol--danger"><AlertCircle size={27} /></span>
        <p className="eyebrow">CONNECTION ERROR</p>
        <h1>暂时无法连接邮箱</h1>
        <p>{message}</p>
        <button className="button button--primary" type="button" onClick={retry}>
          <RefreshCw size={16} /> 重新连接
        </button>
      </section>
    </main>
  )
}

export function AuthPage({
  mode,
  appName,
  superAdminEmail = '',
  onAuthenticated,
}: {
  mode: 'setup' | 'login'
  appName: string
  superAdminEmail?: string
  onAuthenticated: (user: User) => void
}) {
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [setupToken, setSetupToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const result = mode === 'setup'
        ? await api.setup({ displayName, password, setupToken })
        : await api.login(email, password)
      onAuthenticated(result.user)
    } catch (submitError) {
      setError(errorMessage(submitError))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-page__top">
        <Brand />
        <ThemeToggle />
      </div>
      <section className="auth-card">
        <span className="auth-symbol">
          {mode === 'setup' ? <ShieldCheck size={27} /> : <Mail size={27} />}
        </span>
        <p className="eyebrow">{mode === 'setup' ? 'FIRST RUN' : 'WELCOME BACK'}</p>
        <h1>{mode === 'setup' ? '设置你的邮箱' : `登录 ${appName}`}</h1>
        <p className="auth-lead">
          {mode === 'setup'
            ? '为 Worker 中配置的主管理员创建密码。登录身份与域名收件地址相互独立。'
            : '使用完整邮箱地址和密码进入收件箱。'}
        </p>

        <form className="auth-form" onSubmit={submit}>
          {mode === 'setup' && (
            <>
              <label>
                <span>显示名称</span>
                <input
                  autoComplete="name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="例如：Omni"
                  maxLength={60}
                  required
                />
              </label>
              <div className="configured-admin">
                <span>主管理员登录邮箱</span>
                <strong>{superAdminEmail || '尚未配置 SUPER_ADMIN_EMAIL'}</strong>
              </div>
            </>
          )}
          {mode === 'login' && (
            <label>
              <span>邮箱地址</span>
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                required
              />
            </label>
          )}
          <label>
            <span>密码</span>
            <input
              type="password"
              autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={mode === 'setup' ? '至少 10 个字符' : '输入邮箱密码'}
              minLength={mode === 'setup' ? 10 : undefined}
              required
            />
          </label>
          {mode === 'setup' && (
            <label>
              <span>一次性设置令牌</span>
              <input
                type="password"
                autoComplete="off"
                value={setupToken}
                onChange={(event) => setSetupToken(event.target.value)}
                placeholder="Worker 中的 SETUP_TOKEN"
                required
              />
            </label>
          )}
          {error && <p className="form-error" role="alert"><AlertCircle size={16} />{error}</p>}
          <button
            className="button button--primary auth-submit"
            type="submit"
            disabled={submitting || (mode === 'setup' && !superAdminEmail)}
          >
            {submitting && <LoaderCircle className="spin" size={17} />}
            {mode === 'setup' ? '创建主管理员' : '登录邮箱'}
          </button>
        </form>

        <div className="privacy-note">
          <ShieldCheck size={16} />
          <p>
            密码经过 PBKDF2 派生后保存；邮件正文与附件保存在你的私有 Cloudflare R2 中。
          </p>
        </div>
      </section>
    </main>
  )
}
