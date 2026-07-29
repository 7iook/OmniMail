import {
  AlertCircle,
  FileText,
  LoaderCircle,
  Paperclip,
  Send,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { api, type DraftAttachment, type MailboxAddress } from '../lib/api'
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
  const [attachments, setAttachments] = useState<DraftAttachment[]>([])
  const [draftLoaded, setDraftLoaded] = useState(false)
  const [draftLoadFailed, setDraftLoadFailed] = useState(false)
  const [sending, setSending] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [closing, setClosing] = useState(false)
  const [error, setError] = useState('')
  const attachmentInput = useRef<HTMLInputElement>(null)
  const draftSaveQueue = useRef<Promise<void>>(Promise.resolve())
  const finalizing = useRef(false)
  const idempotencyKey = useMemo(
    () => crypto.randomUUID().replaceAll('-', ''),
    [],
  )
  const busy = sending || uploading || discarding || closing

  const saveCurrentDraft = useCallback(() => {
    const input = { mailboxAddress, to, subject, text }
    const request = draftSaveQueue.current.then(() => api.saveDraft(input))
    draftSaveQueue.current = request.then(() => undefined, () => undefined)
    return request
  }, [mailboxAddress, subject, text, to])

  useEffect(() => {
    let active = true
    void api.draft()
      .then(({ draft }) => {
        if (!active || !draft) return
        if (mailboxes.some((mailbox) => mailbox.address === draft.mailboxAddress)) {
          setMailboxAddress(draft.mailboxAddress)
        }
        setTo(draft.to)
        setSubject(draft.subject)
        setText(draft.text)
        setAttachments(draft.attachments)
      })
      .catch((loadError) => {
        if (!active) return
        setDraftLoadFailed(true)
        setError(errorMessage(loadError))
      })
      .finally(() => active && setDraftLoaded(true))
    return () => { active = false }
  }, [mailboxes])

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy && draftLoaded) void closeAndSave()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  })

  useEffect(() => {
    if (!draftLoaded || busy || !mailboxAddress) return
    const timer = window.setTimeout(() => {
      if (finalizing.current) return
      void saveCurrentDraft()
        .catch((saveError) => setError(errorMessage(saveError)))
    }, 600)
    return () => window.clearTimeout(timer)
  }, [busy, draftLoaded, mailboxAddress, saveCurrentDraft])

  async function closeAndSave() {
    if (!draftLoaded) return
    if (draftLoadFailed) {
      onClose()
      return
    }
    finalizing.current = true
    setClosing(true)
    setError('')
    try {
      await saveCurrentDraft()
      onClose()
    } catch (saveError) {
      finalizing.current = false
      setError(errorMessage(saveError))
      setClosing(false)
    }
  }

  async function addAttachments(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    if (!files.length) return
    setUploading(true)
    setError('')
    try {
      await saveCurrentDraft()
      for (const file of files.slice(0, Math.max(0, 5 - attachments.length))) {
        const result = await api.uploadDraftAttachment(file)
        setAttachments((current) => [...current, result.attachment])
      }
    } catch (uploadError) {
      setError(errorMessage(uploadError))
    } finally {
      setUploading(false)
    }
  }

  async function removeAttachment(attachment: DraftAttachment) {
    setUploading(true)
    setError('')
    try {
      await api.deleteDraftAttachment(attachment.id)
      setAttachments((current) => current.filter((item) => item.id !== attachment.id))
    } catch (removeError) {
      setError(errorMessage(removeError))
    } finally {
      setUploading(false)
    }
  }

  async function discard() {
    finalizing.current = true
    setDiscarding(true)
    setError('')
    try {
      await draftSaveQueue.current
      await api.discardDraft()
      onClose()
    } catch (discardError) {
      finalizing.current = false
      setError(errorMessage(discardError))
      setDiscarding(false)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!mailboxAddress || !to.trim() || !subject.trim() || !text.trim()) return
    finalizing.current = true
    setSending(true)
    setError('')
    try {
      await saveCurrentDraft()
      await api.sendDraft(idempotencyKey)
      onSent()
    } catch (sendError) {
      finalizing.current = false
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
          <button className="icon-button" type="button" onClick={() => void closeAndSave()}
            aria-label={t('关闭并保留草稿')} disabled={busy || !draftLoaded}>
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
                onChange={(event) => setMailboxAddress(event.target.value)} disabled={busy}>
                {mailboxes.map((mailbox) => (
                  <option value={mailbox.address} key={mailbox.address}>{mailbox.address}</option>
                ))}
              </select>
            </label>
            <label className="compose-field">
              <span>{t('收件人')}</span>
              <input name="to" type="email" autoComplete="off" spellCheck={false} autoFocus
                value={to} onChange={(event) => setTo(event.target.value)}
                placeholder="name@example.com" maxLength={254} required disabled={busy} />
            </label>
            <label className="compose-field compose-field--subject">
              <span>{t('主题')}</span>
              <input name="subject" type="text" autoComplete="off" value={subject}
                onChange={(event) => setSubject(event.target.value)}
                placeholder={t('输入邮件主题…')} maxLength={500} required disabled={busy} />
            </label>
          </div>
          <label className="compose-editor">
            <span className="sr-only">{t('邮件正文')}</span>
            <textarea name="text" value={text} onChange={(event) => setText(event.target.value)}
              placeholder={t('写下邮件内容…')} maxLength={50_000} required disabled={busy} />
          </label>
          {attachments.length > 0 && (
            <div className="compose-attachments">
              {attachments.map((attachment) => (
                <span className="compose-attachment" key={attachment.id}>
                  <FileText size={14} />
                  <span>{attachment.filename}</span>
                  <button type="button" onClick={() => void removeAttachment(attachment)}
                    disabled={busy} aria-label={t('移除附件：{name}', { name: attachment.filename })}>
                    <X size={13} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {error && <p className="inline-error" role="alert"><AlertCircle size={15} />{error}</p>}
        </div>
        <footer>
          <button className="button button--primary" type="submit"
            disabled={busy || !draftLoaded || !mailboxAddress || !to.trim() || !subject.trim() || !text.trim()}>
            {sending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
            {t('发送邮件')}
          </button>
          <input ref={attachmentInput} className="sr-only" type="file" multiple
            onChange={(event) => void addAttachments(event)} disabled={busy || attachments.length >= 5} />
          <button className="compose-attach" type="button"
            onClick={() => attachmentInput.current?.click()}
            disabled={busy || !draftLoaded || attachments.length >= 5}
            aria-label={t('添加附件')} data-tooltip={t('添加附件')}>
            {uploading ? <LoaderCircle className="spin" size={17} /> : <Paperclip size={17} />}
          </button>
          <span className="compose-delivery-note">
            <ShieldCheck size={13} />{t('草稿自动保存；通过 Resend 安全发送。')}
          </span>
          <button className="compose-discard" type="button" onClick={() => void discard()}
            disabled={busy} aria-label={t('丢弃草稿')} data-tooltip={t('丢弃草稿')}>
            {discarding ? <LoaderCircle className="spin" size={17} /> : <Trash2 size={17} />}
          </button>
        </footer>
      </form>
    </div>
  )
}
