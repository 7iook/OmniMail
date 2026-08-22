import { AlertCircle, LoaderCircle, Send, ShieldCheck, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { t } from '../lib/i18n'

export type LinuxDoMailComposeInput = {
  to: string
  subject: string
  text: string
  idempotencyKey: string
}

export function LinuxDoMailComposeDialog({
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
  onSubmit: (input: LinuxDoMailComposeInput) => Promise<void>
}) {
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [visible, setVisible] = useState(false)
  const idempotencyKey = useMemo(() => crypto.randomUUID().replaceAll('-', ''), [])
  const titleId = useId()
  const descriptionId = useId()
  const noteId = useId()
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
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled])',
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
    await onSubmit({ to, subject, text: body, idempotencyKey })
  }

  return createPortal(
    <div className={`icloud-modal-backdrop${visible ? ' is-visible' : ''}`}
      onMouseDown={(event) => !busy && event.target === event.currentTarget && onCancel()}>
      <section ref={dialogRef} className="icloud-modal linuxdo-compose-dialog" role="dialog"
        aria-modal="true" aria-busy={busy} aria-labelledby={titleId}
        aria-describedby={descriptionId}>
        <header>
          <div>
            <h2 id={titleId}>{t('新建 Linux DO 邮件')}</h2>
            <p id={descriptionId}>{t('邮件将固定从 {username} 发出。', { username })}</p>
          </div>
          <button className="icon-button" type="button" disabled={busy} onClick={onCancel}
            aria-label={t('关闭')}><X size={17} aria-hidden="true" /></button>
        </header>
        <form className="icloud-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="linuxdo-mail-compose-to">
            <span>{t('收件人')}</span>
            <input id="linuxdo-mail-compose-to" data-modal-autofocus required maxLength={254}
              type="email" autoComplete="email" disabled={busy} value={to}
              onChange={(event) => setTo(event.target.value)} />
          </label>
          <label htmlFor="linuxdo-mail-compose-subject">
            <span>{t('主题')}</span>
            <input id="linuxdo-mail-compose-subject" required maxLength={500}
              disabled={busy} value={subject}
              onChange={(event) => setSubject(event.target.value)} />
          </label>
          <label htmlFor="linuxdo-mail-compose-body">
            <span>{t('正文')}</span>
            <textarea id="linuxdo-mail-compose-body" required maxLength={50_000}
              aria-invalid={Boolean(error)}
              aria-describedby={`${noteId}${error ? ` ${errorId}` : ''}`}
              disabled={busy} value={body}
              onChange={(event) => setBody(event.target.value)} />
          </label>
          <p id={noteId} className="linuxdo-connect-note">
            <ShieldCheck size={15} aria-hidden="true" />
            {t('发送受 Linux DO Mail 发信额度和 OmniMail 用户限速共同保护。')}
          </p>
          {error && <p id={errorId} className="inline-error" role="alert">
            <AlertCircle size={15} aria-hidden="true" />{error}
          </p>}
          <footer>
            <button className="button button--secondary" type="button" disabled={busy}
              onClick={onCancel}>{t('取消')}</button>
            <button className="button button--primary" disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={16} aria-hidden="true" />
                : <Send size={16} aria-hidden="true" />}
              {t(busy ? '正在加入发送队列…' : '发送邮件')}
            </button>
          </footer>
        </form>
      </section>
    </div>,
    document.body,
  )
}
