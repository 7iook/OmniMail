import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Cloud,
  Globe2,
  Layers3,
  LoaderCircle,
  LogIn,
  Mail,
  Monitor,
  Moon,
  RefreshCw,
  ShieldCheck,
  Sun,
  UserPlus,
  X,
} from 'lucide-react'
import {
  type FormEvent,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { api, type RegistrationDomainPolicy, type User } from '../lib/api'
import type { SetupRequirements } from '../lib/api'
import { emailAllowedByDomainPolicy } from '../lib/registration'
import {
  getThemePreference,
  setThemePreference,
  subscribeTheme,
} from '../lib/theme'
import { TurnstileWidget } from './TurnstileWidget'

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
    <div className="page-loader" role="status" aria-label="正在打开 OmniMail">
      <div className="opening-splash" aria-hidden="true">
        <span className="opening-splash__mark"><Mail size={31} /></span>
        <span className="opening-splash__copy">
          <strong>OmniMail</strong>
          <small>YOUR DOMAINS · ONE INBOX</small>
        </span>
        <span className="opening-splash__track"><span /></span>
      </div>
      <span className="sr-only">正在打开 OmniMail</span>
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

export function SetupPage({
  superAdminEmail = '',
  requirements,
  onAuthenticated,
}: {
  superAdminEmail?: string
  requirements: SetupRequirements
  onAuthenticated: (user: User) => void
}) {
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [setupToken, setSetupToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const readiness = [
    { label: 'D1 数据库', ready: requirements.databaseReady },
    { label: 'R2 邮件存储', ready: requirements.storageReady },
    { label: '邮件解析队列', ready: requirements.queueReady },
    { label: '主管理员邮箱', ready: requirements.superAdminReady },
    { label: '初始化令牌', ready: requirements.setupTokenReady },
  ]
  const deploymentReady = readiness.every((item) => item.ready)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const result = await api.setup({ displayName, password, setupToken })
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
      <section className="auth-card setup-card">
        <span className="auth-symbol"><ShieldCheck size={27} /></span>
        <p className="eyebrow">FIRST RUN</p>
        <h1>设置你的邮箱</h1>
        <p className="auth-lead">
          为 Worker 中配置的主管理员创建密码。登录身份与域名收件地址相互独立。
        </p>

        <section className={`setup-readiness ${deploymentReady ? 'is-ready' : ''}`}>
          <header>
            <span><Cloud size={17} />部署前置检查</span>
            <strong>{deploymentReady ? '可以继续' : '需要配置'}</strong>
          </header>
          <ul>
            {readiness.map((item) => (
              <li className={item.ready ? 'is-ready' : ''} key={item.label}>
                {item.ready ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
                <span>{item.label}</span>
                <small>{item.ready ? '已就绪' : '未检测到'}</small>
              </li>
            ))}
          </ul>
          {!deploymentReady && (
            <>
              <p>
                请在 Worker 中补齐缺少的绑定或变量，重新部署后刷新此页面。
                检查结果不会包含 Secret 的实际内容。
              </p>
              <button
                className="setup-check-refresh"
                type="button"
                onClick={() => window.location.reload()}
              >
                <RefreshCw size={13} />重新检查
              </button>
            </>
          )}
        </section>

        <form className="auth-form" onSubmit={submit}>
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
          <label>
            <span>密码</span>
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="至少 10 个字符"
              minLength={10}
              required
            />
          </label>
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
          {error && <p className="form-error" role="alert"><AlertCircle size={16} />{error}</p>}
          <button
            className="button button--primary auth-submit"
            type="submit"
            disabled={submitting || !deploymentReady}
          >
            {submitting && <LoaderCircle className="spin" size={17} />}
            创建主管理员
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

type AuthMode = 'login' | 'register'

function AuthModal({
  mode,
  appName,
  registrationEnabled,
  registrationDomainPolicy,
  turnstileSiteKey,
  onModeChange,
  onClose,
  onAuthenticated,
}: {
  mode: AuthMode
  appName: string
  registrationEnabled: boolean
  registrationDomainPolicy: RegistrationDomainPolicy
  turnstileSiteKey: string
  onModeChange: (mode: AuthMode) => void
  onClose: () => void
  onAuthenticated: (user: User) => void
}) {
  const titleId = useId()
  const modalRef = useRef<HTMLElement>(null)
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [turnstileToken, setTurnstileToken] = useState('')
  const [turnstileAttempt, setTurnstileAttempt] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const registering = mode === 'register'

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    const previousFocus = document.activeElement as HTMLElement | null
    document.body.style.overflow = 'hidden'
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab') return
      const controls = modalRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled])',
      )
      if (!controls?.length) return
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
      previousFocus?.focus()
    }
  }, [onClose])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (registering && password !== confirmPassword) {
      setError('两次输入的密码不一致。')
      return
    }
    if (registering && !emailAllowedByDomainPolicy(email, registrationDomainPolicy)) {
      setError(registrationDomainPolicy.mode === 'allowlist'
        ? '该邮箱后缀不在管理员允许的注册范围内。'
        : '管理员不允许使用该邮箱后缀注册。')
      return
    }
    if (registering && !turnstileToken) {
      setError('请先完成人机验证。')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const result = registering
        ? await api.register({ email, displayName, password, turnstileToken })
        : await api.login(email, password)
      onAuthenticated(result.user)
    } catch (submitError) {
      setError(errorMessage(submitError))
      if (registering) {
        setTurnstileToken('')
        setTurnstileAttempt((attempt) => attempt + 1)
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="public-auth-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        ref={modalRef}
        className="public-auth-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header>
          <span>{registering ? <UserPlus size={21} /> : <LogIn size={21} />}</span>
          <div>
            <p className="eyebrow">{registering ? 'CREATE ACCOUNT' : 'WELCOME BACK'}</p>
            <h2 id={titleId}>{registering ? '创建普通账户' : `登录 ${appName}`}</h2>
          </div>
          <button type="button" aria-label="关闭" title="关闭" onClick={onClose}>
            <X size={19} />
          </button>
        </header>

        <form className="auth-form" onSubmit={submit}>
          {registering && (
            <label>
              <span>显示名称</span>
              <input
                autoFocus
                autoComplete="name"
                value={displayName}
                maxLength={60}
                placeholder="你的显示名称"
                onChange={(event) => setDisplayName(event.target.value)}
                required
              />
            </label>
          )}
          <label>
            <span>登录邮箱</span>
            <input
              autoFocus={!registering}
              type="email"
              autoComplete="email"
              value={email}
              placeholder="you@example.com"
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            <span>密码</span>
            <input
              type="password"
              autoComplete={registering ? 'new-password' : 'current-password'}
              value={password}
              minLength={registering ? 10 : undefined}
              placeholder={registering ? '至少 10 个字符' : '输入邮箱密码'}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {registering && (
            <label>
              <span>确认密码</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                minLength={10}
                placeholder="再次输入密码"
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
              />
            </label>
          )}
          {registering && (
            <TurnstileWidget
              key={turnstileAttempt}
              siteKey={turnstileSiteKey}
              onTokenChange={setTurnstileToken}
            />
          )}
          {error && <p className="form-error" role="alert"><AlertCircle size={16} />{error}</p>}
          <button
            className="button button--primary auth-submit"
            type="submit"
            disabled={submitting || (registering && !turnstileToken)}
          >
            {submitting && <LoaderCircle className="spin" size={17} />}
            {registering ? '创建并登录' : '登录邮箱'}
          </button>
        </form>

        <footer>
          {registering ? '已经有账户？' : registrationEnabled ? '还没有账户？' : '当前未开放外部注册。'}
          {(registering || registrationEnabled) && (
            <button
              type="button"
              onClick={() => onModeChange(registering ? 'login' : 'register')}
            >
              {registering ? '返回登录' : '创建账户'}
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}

export function PublicLanding({
  appName,
  registrationEnabled,
  registrationDomainPolicy,
  turnstileSiteKey,
  onAuthenticated,
}: {
  appName: string
  registrationEnabled: boolean
  registrationDomainPolicy: RegistrationDomainPolicy
  turnstileSiteKey: string
  onAuthenticated: (user: User) => void
}) {
  const [authMode, setAuthMode] = useState<AuthMode | null>(null)
  const closeModal = () => setAuthMode(null)

  return (
    <div className="public-landing">
      <header className="public-nav">
        <Brand />
        <div>
          <ThemeToggle />
          <button className="button button--secondary" type="button" onClick={() => setAuthMode('login')}>
            登录
          </button>
          {registrationEnabled && (
            <button className="button button--primary" type="button" onClick={() => setAuthMode('register')}>
              创建账户
            </button>
          )}
        </div>
      </header>

      <main className="public-main">
        <section className="public-hero">
          <div className="public-hero__copy">
            <p className="eyebrow">YOUR DOMAINS · ONE INBOX</p>
            <h1>把多个域名，<br />收进一个清爽邮箱。</h1>
            <p>
              基于 Cloudflare Workers、Static Assets、D1 与 R2 的轻量邮件工作台。
              集中管理域名、邮箱地址和访问权限。
            </p>
            <div className="public-hero__actions">
              <button className="button button--primary" type="button" onClick={() => setAuthMode('login')}>
                登录邮箱 <ArrowRight size={16} />
              </button>
              {registrationEnabled && (
                <button className="button button--secondary" type="button" onClick={() => setAuthMode('register')}>
                  创建普通账户
                </button>
              )}
            </div>
            <small>
              {registrationEnabled
                ? '外部注册已开放；邮箱能力由管理员统一分配。'
                : '当前仅允许管理员创建或邀请账户。'}
            </small>
          </div>

          <div className="public-mail-preview" aria-hidden="true">
            <header><Brand /><span>ALL MAILBOXES</span></header>
            <div className="public-mail-preview__body">
              <aside><span /><span /><span /><span /></aside>
              <div>
                <p><strong>统一收件箱</strong><small>3 个域名 · 8 个邮箱</small></p>
                <article><span>O</span><p><strong>Omni Updates</strong><small>欢迎使用你的新邮箱工作台</small></p><time>刚刚</time></article>
                <article><span>D</span><p><strong>Domain Notice</strong><small>域名邮件路由已经连接</small></p><time>09:42</time></article>
                <article><span>T</span><p><strong>Team Inbox</strong><small>权限设置已更新</small></p><time>昨天</time></article>
              </div>
            </div>
          </div>
        </section>

        <section className="public-features" aria-label="主要能力">
          <article><Globe2 size={20} /><strong>多域名统一管理</strong><p>一个工作台管理多个域名与域名下的邮箱。</p></article>
          <article><Layers3 size={20} /><strong>精细账户权限</strong><p>区分管理员、普通用户与临时用户。</p></article>
          <article><Cloud size={20} /><strong>Cloudflare 原生</strong><p>邮件数据保留在你自己的 Cloudflare 资源中。</p></article>
        </section>
      </main>

      <footer className="public-footer">
        <Brand />
        <span>Private email workspace on Cloudflare.</span>
      </footer>

      {authMode && (
        <AuthModal
          key={authMode}
          mode={authMode}
          appName={appName}
          registrationEnabled={registrationEnabled}
          registrationDomainPolicy={registrationDomainPolicy}
          turnstileSiteKey={turnstileSiteKey}
          onModeChange={setAuthMode}
          onClose={closeModal}
          onAuthenticated={onAuthenticated}
        />
      )}
    </div>
  )
}
