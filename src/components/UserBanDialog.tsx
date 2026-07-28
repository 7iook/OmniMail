import { Ban, TriangleAlert, X } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'
import { t } from '../lib/i18n'

export function UserBanDialog({
  email,
  onCancel,
  onConfirm,
}: {
  email: string
  onCancel: () => void
  onConfirm: () => void
}) {
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const cancelRef = useRef(onCancel)
  cancelRef.current = onCancel

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const frame = requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelRef.current()
      if (event.key !== 'Tab') return
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])')
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
    window.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(frame)
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
      previousFocus?.focus()
    }
  }, [])

  return (
    <div className="mail-delete-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel()
    }}>
      <section
        ref={dialogRef}
        className="mail-delete-dialog user-ban-dialog is-permanent"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header>
          <span><Ban size={21} /></span>
          <div>
            <p className="eyebrow">DISABLE ACCOUNT</p>
            <h2 id={titleId}>{t('封禁 {email}？', { email })}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onCancel} aria-label={t('关闭')}>
            <X size={17} />
          </button>
        </header>
        <div className="mail-delete-dialog__body">
          <p id={descriptionId}>{t('该账户会立即退出登录，所有现有会话都将失效。')}</p>
          <p className="mail-delete-impact">
            <TriangleAlert size={17} />
            <span>
              <strong>{t('立即生效')}</strong>
              <small>{t('用户之后无法继续访问邮箱，管理员可随时重新启用账户。')}</small>
            </span>
          </p>
        </div>
        <footer>
          <button className="button button--secondary" type="button" data-autofocus onClick={onCancel}>
            {t('取消')}
          </button>
          <button className="button mail-delete-confirm is-permanent" type="button" onClick={onConfirm}>
            <Ban size={16} />
            {t('确认封禁')}
          </button>
        </footer>
      </section>
    </div>
  )
}
