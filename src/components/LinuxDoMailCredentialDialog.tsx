import { AlertCircle, Eye, EyeOff, KeyRound, ShieldCheck, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { t } from '../lib/i18n'

export function LinuxDoMailCredentialDialog({
  username,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  username: string
  busy: boolean
  error: string
  onCancel: () => void
  onSubmit: (password: string) => Promise<void>
}) {
  const [password, setPassword] = useState('')
  const [shown, setShown] = useState(false)
  const [visible, setVisible] = useState(false)
  const titleId = useId()
  const descriptionId = useId()
  const helpId = useId()
  const errorId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const busyRef = useRef(busy)
  const cancelRef = useRef(onCancel)
  busyRef.current = busy
  cancelRef.current = onCancel

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const frame = requestAnimationFrame(() => {
      setVisible(true)
      dialogRef.current?.querySelector<HTMLInputElement>('[data-modal-autofocus]')?.focus()
    })
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) cancelRef.current()
      if (event.key !== 'Tab') return
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled])',
      )
      if (!controls?.length) return
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus()
      }
    }
    window.addEventListener('keydown', keydown)
    return () => {
      cancelAnimationFrame(frame)
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', keydown)
      previousFocus?.focus()
    }
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    await onSubmit(password)
  }

  return createPortal(
    <div className={`icloud-modal-backdrop${visible ? ' is-visible' : ''}`}
      onMouseDown={(event) => !busy && event.target === event.currentTarget && onCancel()}>
      <section ref={dialogRef} className="icloud-modal linuxdo-credential-dialog" role="dialog"
        aria-modal="true" aria-busy={busy} aria-labelledby={titleId}
        aria-describedby={descriptionId}>
        <header>
          <div>
            <h2 id={titleId}>{t('更新密码或认证令牌')}</h2>
            <p id={descriptionId}>{t(
              '为账号 {username} 输入新凭据；验证成功后才会替换已保存的密文。',
              { username },
            )}</p>
          </div>
          <button className="icon-button" type="button" disabled={busy} onClick={onCancel}
            aria-label={t('关闭')}><X size={17} aria-hidden="true" /></button>
        </header>
        <form className="icloud-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="linuxdo-mail-new-password">
            <span>{t('新密码或认证令牌')}</span>
            <span className="linuxdo-password-field">
              <input id="linuxdo-mail-new-password" data-modal-autofocus required maxLength={512}
                type={shown ? 'text' : 'password'} autoComplete="new-password"
                aria-invalid={Boolean(error)}
                aria-describedby={`${helpId}${error ? ` ${errorId}` : ''}`}
                disabled={busy} value={password}
                onChange={(event) => setPassword(event.target.value)} />
              <button type="button" disabled={busy} aria-pressed={shown}
                onClick={() => setShown((current) => !current)}
                aria-label={t(shown ? '隐藏密码' : '显示密码')}>
                {shown ? <EyeOff size={17} aria-hidden="true" />
                  : <Eye size={17} aria-hidden="true" />}
              </button>
            </span>
          </label>
          <p id={helpId} className="linuxdo-connect-note">
            <ShieldCheck size={15} aria-hidden="true" />
            {t('新凭据不会显示或保存到浏览器；建议使用可撤销的专用认证令牌。')}
          </p>
          {error && <p id={errorId} className="inline-error" role="alert">
            <AlertCircle size={15} aria-hidden="true" />{error}
          </p>}
          <footer>
            <button className="button button--secondary" type="button" disabled={busy}
              onClick={onCancel}>{t('取消')}</button>
            <button className="button button--primary" disabled={busy}>
              {busy ? <span className="spin" aria-hidden="true"><KeyRound size={16} /></span>
                : <KeyRound size={16} aria-hidden="true" />}
              {t(busy ? '正在验证并更新…' : '验证并更新')}
            </button>
          </footer>
        </form>
      </section>
    </div>,
    document.body,
  )
}
