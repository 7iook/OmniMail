import {
  AlertCircle,
  ArrowLeft,
  Check,
  Copy,
  Download,
  ExternalLink,
  LoaderCircle,
  Mail,
  Paperclip,
  Reply,
  Send,
  ShieldAlert,
  Star,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type MessageDetail } from '../lib/api'
import { getLocale, t } from '../lib/i18n'

function errorMessage(error: unknown): string {
  return t(error instanceof Error ? error.message : '发生了未知错误。')
}

function formatFullDate(timestamp: number): string {
  return new Intl.DateTimeFormat(getLocale(), {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp))
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function emailImageSources(remoteImagesEnabled: boolean): string {
  return remoteImagesEnabled ? 'data: cid: https:' : 'data: cid:'
}

export const EMAIL_FRAME_SANDBOX = 'allow-same-origin'

export function normalizeContentId(value: string): string {
  let normalized = value.trim().replace(/^cid:/i, '')
  try {
    normalized = decodeURIComponent(normalized)
  } catch {
    // Keep malformed values unchanged so they simply fail to match.
  }
  if (normalized.startsWith('<') && normalized.endsWith('>')) {
    normalized = normalized.slice(1, -1)
  }
  return normalized
}

export function safeEmailHref(value: string): string | null {
  const candidate = value.trim()
  if (!/^https?:\/\//i.test(candidate)) return null
  try {
    const url = new URL(candidate)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

export function emailLinkHref(target: EventTarget | null): string | null {
  if (!target || typeof (target as Element).closest !== 'function') return null
  const link = (target as Element).closest<HTMLAnchorElement>('a[data-omnimail-href]')
  return link ? safeEmailHref(link.dataset.omnimailHref ?? '') : null
}

export function shouldProxyRemoteImage(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && url.hostname === 'claude.ai'
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && url.pathname === '/images/claude_logo_full.png'
  } catch {
    return false
  }
}

function buildEmailDocument(
  html: string,
  remoteImagesEnabled: boolean,
  inlineImageSources: ReadonlyMap<string, string>,
): string {
  const policy = `default-src 'none'; img-src ${emailImageSources(remoteImagesEnabled)}; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'`
  const document = new DOMParser().parseFromString(html, 'text/html')
  document.querySelectorAll('script, iframe, object, embed, form, base, meta[http-equiv]').forEach((node) => node.remove())
  document.querySelectorAll('*').forEach((node) => {
    for (const attribute of [...node.attributes]) {
      if (attribute.name.toLowerCase().startsWith('on') || attribute.name.toLowerCase() === 'srcdoc') {
        node.removeAttribute(attribute.name)
      }
    }
  })
  document.querySelectorAll('img[src]').forEach((image) => {
    const source = image.getAttribute('src') ?? ''
    if (/^cid:/i.test(source)) {
      const replacement = inlineImageSources.get(normalizeContentId(source))
      if (replacement) image.setAttribute('src', replacement)
      return
    }
    if (remoteImagesEnabled && shouldProxyRemoteImage(source)) {
      image.setAttribute('src', api.remoteImageUrl(source))
    }
  })
  document.querySelectorAll('a[href]').forEach((link) => {
    const href = safeEmailHref(link.getAttribute('href') ?? '')
    if (!href) {
      link.removeAttribute('href')
      return
    }
    link.removeAttribute('href')
    link.setAttribute('data-omnimail-href', href)
    link.setAttribute('role', 'link')
    link.setAttribute('tabindex', '0')
    link.removeAttribute('target')
    link.removeAttribute('rel')
  })
  const head = `
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${policy}">
    <meta name="referrer" content="no-referrer">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      :root { color-scheme: light; }
      body { margin: 0; padding: 2px; color: #222; background: #fff; font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow-wrap: anywhere; }
      img { max-width: 100%; height: auto; }
      table { max-width: 100% !important; }
      pre { white-space: pre-wrap; }
      a { color: #1d1d1f; text-decoration: underline; }
      a[data-omnimail-href] { cursor: pointer; }
    </style>`
  return `<!doctype html><html><head>${head}${document.head.innerHTML}</head><body>${document.body.innerHTML}</body></html>`
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(String(reader.result)))
    reader.addEventListener('error', () => reject(reader.error))
    reader.readAsDataURL(blob)
  })
}

function ExternalLinkDialog({
  href,
  onClose,
  onContinue,
}: {
  href: string
  onClose: () => void
  onContinue: () => void
}) {
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const destination = new URL(href).host

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusFrame = requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    })
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
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
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      cancelAnimationFrame(focusFrame)
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
      previousFocus?.focus()
    }
  }, [onClose])

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(href)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  return createPortal(
    <div className="external-link-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section
        ref={dialogRef}
        className="external-link-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header>
          <span className="external-link-dialog__symbol"><ShieldAlert size={22} /></span>
          <div>
            <p className="eyebrow">EXTERNAL LINK</p>
            <h2 id={titleId}>{t('即将离开 OmniMail')}</h2>
          </div>
          <button className="icon-button" type="button" aria-label={t('关闭')} onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="external-link-dialog__body">
          <p id={descriptionId}>{t('您将要访问外部网站。请先确认目标域名可信，并留意钓鱼或仿冒页面。')}</p>
          <dl>
            <div>
              <dt>{t('目标域名')}</dt>
              <dd><ExternalLink size={15} /><strong>{destination}</strong></dd>
            </div>
            <div>
              <dt>{t('完整链接')}</dt>
              <dd className="external-link-url">
                <code>{href}</code>
                <button
                  type="button"
                  onClick={() => void copyLink()}
                  aria-label={t(copyState === 'copied' ? '链接已复制' : '复制链接')}
                >
                  {copyState === 'copied' ? <Check size={16} /> : <Copy size={16} />}
                  <span>{t(copyState === 'copied' ? '链接已复制' : '复制链接')}</span>
                </button>
              </dd>
            </div>
          </dl>
          <p className="external-link-warning">
            <ShieldAlert size={16} />
            <span>{t('外部页面不受 OmniMail 控制，请勿在可疑页面输入密码、验证码或其他敏感信息。')}</span>
          </p>
          <p
            className={`external-link-copy-status${copyState === 'copied' ? ' external-link-copy-status--success' : ''}`}
            role="status"
            aria-live="polite"
          >
            {copyState === 'copied'
              ? t('链接已复制')
              : copyState === 'failed'
                ? t('无法访问剪贴板，请手动复制链接。')
                : ''}
          </p>
        </div>

        <footer>
          <button className="button button--secondary" type="button" data-autofocus onClick={onClose}>
            {t('取消')}
          </button>
          <button className="button button--primary" type="button" onClick={onContinue}>
            <ExternalLink size={16} />{t('继续访问')}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}

function ReplyComposer({
  message,
  onClose,
  onSent,
}: {
  message: MessageDetail
  onClose: () => void
  onSent: () => void
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const idempotencyKey = useMemo(
    () => crypto.randomUUID().replaceAll('-', ''),
    [],
  )

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!text.trim()) return
    setSending(true)
    setError('')
    try {
      await api.reply(message.id, text, idempotencyKey)
      onSent()
    } catch (sendError) {
      setError(errorMessage(sendError))
    } finally {
      setSending(false)
    }
  }

  return (
    <form className="reply-composer" onSubmit={submit}>
      <div className="reply-composer__header">
        <div>
          <small>{t('回复给')}</small>
          <strong>{message.senderName || message.senderAddress}</strong>
        </div>
        <button className="icon-button icon-button--small" type="button" onClick={onClose} aria-label={t('关闭回复')}>
          <X size={17} />
        </button>
      </div>
      <label className="sr-only" htmlFor="reply-body">{t('回复内容')}</label>
      <textarea
        id="reply-body"
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={t('写下回复…')}
        maxLength={50_000}
      />
      {error && <p className="inline-error" role="alert"><AlertCircle size={15} />{error}</p>}
      <div className="reply-composer__footer">
        <span>{t('通过 Resend 发送')}</span>
        <button className="button button--primary button--small" type="submit" disabled={sending || !text.trim()}>
          {sending ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}
          {t('发送回复')}
        </button>
      </div>
    </form>
  )
}

export function MessageReader({
  message,
  loading,
  replyEnabled,
  remoteImagesEnabled,
  onBack,
  onStar,
  onTrash,
  onRestore,
  onReplySent,
}: {
  message: MessageDetail | null
  loading: boolean
  replyEnabled: boolean
  remoteImagesEnabled: boolean
  onBack: () => void
  onStar: () => void
  onTrash: () => void
  onRestore: () => void
  onReplySent: () => void
}) {
  const [replying, setReplying] = useState(false)
  const [inlineImageSources, setInlineImageSources] = useState<ReadonlyMap<string, string>>(new Map())
  const [externalLink, setExternalLink] = useState<string | null>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const closeExternalLink = useCallback(() => setExternalLink(null), [])
  const handleEmailLinkClick = useCallback((event: Event) => {
    const href = emailLinkHref(event.target)
    if (!href) return
    event.preventDefault()
    setExternalLink(href)
  }, [])
  const handleEmailLinkKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key !== 'Enter') return
    const href = emailLinkHref(event.target)
    if (!href) return
    event.preventDefault()
    setExternalLink(href)
  }, [])

  useEffect(() => {
    setReplying(false)
    setExternalLink(null)
  }, [message?.id])
  useEffect(() => {
    const controller = new AbortController()
    const inlineAttachments = message?.attachments.filter((attachment) => (
      attachment.contentId && attachment.contentType.startsWith('image/')
    )) ?? []
    setInlineImageSources(new Map())

    if (!message || inlineAttachments.length === 0) return () => controller.abort()
    void Promise.all(inlineAttachments.map(async (attachment) => {
      try {
        const response = await fetch(api.attachmentUrl(message.id, attachment.id), {
          credentials: 'include',
          signal: controller.signal,
        })
        if (!response.ok) return null
        return [
          normalizeContentId(attachment.contentId ?? ''),
          await blobDataUrl(await response.blob()),
        ] as const
      } catch {
        return null
      }
    })).then((entries) => {
      if (controller.signal.aborted) return
      setInlineImageSources(new Map(entries.filter((entry): entry is readonly [string, string] => entry !== null)))
    })
    return () => controller.abort()
  }, [message])

  const emailDocument = useMemo(
    () => message?.html
      ? buildEmailDocument(message.html, remoteImagesEnabled, inlineImageSources)
      : '',
    [inlineImageSources, message?.html, remoteImagesEnabled],
  )

  if (loading) {
    return (
      <div className="reader-state reader-state--loading" role="status" aria-live="polite">
        <span className="reader-loading-visual" aria-hidden="true">
          <span className="reader-loading-mail"><Mail size={23} /></span>
        </span>
        <span className="reader-loading-copy">
          <strong>{t('正在打开邮件')}</strong>
          <small>{t('安全读取邮件内容')}</small>
        </span>
      </div>
    )
  }
  if (!message) {
    return (
      <div className="reader-state reader-state--empty">
        <span className="reader-empty-symbol"><Mail size={29} /></span>
        <h2>{t('选择一封邮件')}</h2>
        <p>{t(remoteImagesEnabled
          ? '邮件内容会安全地显示在这里，HTTPS 远程图片按系统设置加载。'
          : '邮件内容会安全地显示在这里，远程图片默认被阻止。')}</p>
      </div>
    )
  }

  return (
    <article className="message-reader">
      <header className="reader-toolbar">
        <button className="icon-button mobile-back" type="button" onClick={onBack} aria-label={t('返回邮件列表')}>
          <ArrowLeft size={18} />
        </button>
        <div className="reader-toolbar__spacer" />
        {message.folder === 'trash' && (
          <button className="toolbar-button" type="button" onClick={onRestore}>
            <Undo2 size={16} /> {t('恢复')}
          </button>
        )}
        <button className="icon-button" type="button" onClick={onStar} aria-label={t(message.isStarred ? '取消星标' : '添加星标')}>
          <Star size={17} fill={message.isStarred ? 'currentColor' : 'none'} />
        </button>
        <button className="icon-button icon-button--danger" type="button" onClick={onTrash} aria-label={t(message.folder === 'trash' ? '永久删除' : '移入垃圾箱')}>
          <Trash2 size={17} />
        </button>
      </header>

      <div className="reader-content">
        <header className="message-heading">
          <h1>{message.subject || t('无主题')}</h1>
          <div className="sender-block">
            <span className="sender-avatar">
              {(message.senderName || message.senderAddress || 'M').slice(0, 1).toUpperCase()}
            </span>
            <div>
              <strong>{message.senderName || message.senderAddress}</strong>
              {message.senderName && <span>&lt;{message.senderAddress}&gt;</span>}
              <small>
                {message.direction === 'outgoing'
                  ? t('发给 {recipients}', { recipients: message.recipients.join(', ') })
                  : t('发送至 {address}', { address: message.mailboxAddress })}
              </small>
            </div>
            <time dateTime={new Date(message.date).toISOString()}>{formatFullDate(message.date)}</time>
          </div>
        </header>

        {message.status === 'processing' && (
          <div className="message-notice"><LoaderCircle className="spin" size={17} />{t('邮件正在安全解析，请稍后刷新。')}</div>
        )}
        {message.status === 'failed' && (
          <div className="message-notice message-notice--error">
            <AlertCircle size={17} />{t('解析失败：{error}', { error: message.processingError || t('未知错误') })}
          </div>
        )}

        {message.html ? (
          <iframe
            ref={frameRef}
            className="email-frame"
            sandbox={EMAIL_FRAME_SANDBOX}
            srcDoc={emailDocument}
            title={t('邮件正文：{subject}', { subject: message.subject })}
            onLoad={(event) => {
              event.currentTarget.contentDocument?.addEventListener('click', handleEmailLinkClick)
              event.currentTarget.contentDocument?.addEventListener('keydown', handleEmailLinkKeyDown)
            }}
          />
        ) : (
          <div className="plain-body">{message.text || t('这封邮件没有可显示的正文。')}</div>
        )}

        {message.attachments.length > 0 && (
          <section className="attachments" aria-labelledby="attachments-title">
            <h2 id="attachments-title"><Paperclip size={16} />{t('附件')}</h2>
            <div className="attachment-grid">
              {message.attachments.map((attachment) => (
                <a
                  className="attachment-card"
                  key={attachment.id}
                  href={api.attachmentUrl(message.id, attachment.id)}
                  download
                >
                  <span><Paperclip size={17} /></span>
                  <div>
                    <strong>{attachment.filename}</strong>
                    <small>{formatSize(attachment.size)}</small>
                  </div>
                  <Download size={16} />
                </a>
              ))}
            </div>
          </section>
        )}

        <div className="message-footer-actions">
          {message.direction === 'incoming' && (
            <a className="quiet-link" href={api.rawUrl(message.id)} download>
              <Download size={14} /> {t('下载原始邮件')}
            </a>
          )}
          {message.direction === 'incoming' && replyEnabled && message.status === 'ready' && !replying && (
            <button className="button button--secondary" type="button" onClick={() => setReplying(true)}>
              <Reply size={16} /> {t('回复')}
            </button>
          )}
        </div>
      </div>

      {replying && (
        <ReplyComposer
          message={message}
          onClose={() => setReplying(false)}
          onSent={() => {
            setReplying(false)
            onReplySent()
          }}
        />
      )}
      {externalLink && (
        <ExternalLinkDialog
          href={externalLink}
          onClose={closeExternalLink}
          onContinue={() => {
            window.open(externalLink, '_blank', 'noopener,noreferrer')
            setExternalLink(null)
          }}
        />
      )}
    </article>
  )
}
