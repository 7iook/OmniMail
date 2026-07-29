import { AlertCircle, LoaderCircle, Send, ShieldCheck, Trash2, X } from 'lucide-react'
import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { api, type MailboxAddress } from '../lib/api'
import { errorMessage } from '../lib/errorMessage'
import { t } from '../lib/i18n'

export function ComposeDialog({
  mailboxes,
  initialMailbox,
  onClose,
  onSent,
}: {
  mailboxes: MailboxAddress[]
  initialMailbox: string
  onClose: () => void
  onSent: () => void
}) {
  const [mailboxAddress, setMailboxAddress] = useState(initialMailbox)
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const idempotencyKey = useMemo(
    () => crypto.randomUUID().replaceAll('-', ''),
    [],
  )

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !sending) onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onClose, sending])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!mailboxAddress || !to.trim() || !subject.trim() || !text.trim()) return
    setSending(true)
    setError('')
    try {
      await api.sendMessage({ mailboxAddress, to, subject, text, idempotencyKey })
      onSent()
    } catch (sendError) {
      setError(errorMessage(sendError))
      setSending(false)
    }
  }

  return (
    <div className="compose-backdrop">
      <form
        className="compose-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="compose-title"
        aria-describedby="compose-description"
        onSubmit={submit}
      >
        <header>
          <div>
            <h2 id="compose-title">{t('新建邮件')}</h2>
            <span className="compose-provider"><ShieldCheck size={13} />{t('Resend 发信')}</span>
          </div>
          <button className="icon-button" type="button" onClick={onClose}
            aria-label={t('关闭新建邮件')} disabled={sending}>
            <X size={18} />
          </button>
        </header>
        <div className="compose-dialog__body">
          <p className="sr-only" id="compose-description">
            {t('通过 Resend 安全发送，并保存到已发送邮件。')}
          </p>
          <div className="compose-fields">
            <label className="compose-field">
              <span>{t('发件人')}</span>
              <select name="from" value={mailboxAddress}
                onChange={(event) => setMailboxAddress(event.target.value)} disabled={sending}>
                {mailboxes.map((mailbox) => (
                  <option value={mailbox.address} key={mailbox.address}>{mailbox.address}</option>
                ))}
              </select>
            </label>
            <label className="compose-field">
              <span>{t('收件人')}</span>
              <input name="to" type="email" autoComplete="off" spellCheck={false} autoFocus
                value={to} onChange={(event) => setTo(event.target.value)}
                placeholder="name@example.com" maxLength={254} required disabled={sending} />
            </label>
            <label className="compose-field compose-field--subject">
              <span>{t('主题')}</span>
              <input name="subject" type="text" autoComplete="off" value={subject}
                onChange={(event) => setSubject(event.target.value)}
                placeholder={t('输入邮件主题…')} maxLength={500} required disabled={sending} />
            </label>
          </div>
          <label className="compose-editor">
            <span className="sr-only">{t('邮件正文')}</span>
            <textarea name="text" value={text} onChange={(event) => setText(event.target.value)}
              placeholder={t('写下邮件内容…')} maxLength={50_000} required disabled={sending} />
          </label>
          {error && <p className="inline-error" role="alert"><AlertCircle size={15} />{error}</p>}
        </div>
        <footer>
          <button className="button button--primary" type="submit"
            disabled={sending || !mailboxAddress || !to.trim() || !subject.trim() || !text.trim()}>
            {sending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
            {t('发送邮件')}
          </button>
          <span className="compose-delivery-note">
            <ShieldCheck size={13} />{t('通过 Resend 安全发送，并保存到已发送邮件。')}
          </span>
          <button className="compose-discard" type="button" onClick={onClose}
            disabled={sending} aria-label={t('取消')} data-tooltip={t('取消')}>
            <Trash2 size={17} />
          </button>
        </footer>
      </form>
    </div>
  )
}
