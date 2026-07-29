import {
  AlertCircle,
  ArrowLeft,
  Clock3,
  CheckCircle2,
  Download,
  LoaderCircle,
  Mail,
  Paperclip,
  Reply,
  RotateCcw,
  Star,
  Trash2,
  Undo2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type MessageDetail, type MessageSummary } from '../lib/api'
import { errorMessage } from '../lib/errorMessage'
import { failedMailApi } from '../lib/failedMailApi'
import { getLocale, t } from '../lib/i18n'
import { ExternalLinkDialog } from './ExternalLinkDialog'
import { MessageThread } from './MessageThread'
import { ReplyComposer } from './ReplyComposer'

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

export function emailImageSources(
  remoteImagesEnabled: boolean,
  proxySource = '',
): string {
  return remoteImagesEnabled && proxySource ? `data: ${proxySource}` : 'data:'
}

export const EMAIL_FRAME_SANDBOX = 'allow-same-origin'
const EMAIL_FRAME_MIN_HEIGHT = 470

type PreparedEmailFrame = {
  messageId: string
  document: string
}

export function emailDocumentHeight(document: Document): number {
  return Math.max(
    EMAIL_FRAME_MIN_HEIGHT,
    document.body.offsetHeight,
    document.body.scrollHeight,
    document.documentElement.offsetHeight,
    document.documentElement.scrollHeight,
  )
}

export function fitEmailDocument(document: Document): number {
  const { body, documentElement } = document
  body.style.removeProperty('transform')
  body.style.removeProperty('transform-origin')
  body.style.removeProperty('--omnimail-body-width')
  body.style.removeProperty('--omnimail-body-max-width')

  const viewportWidth = documentElement.clientWidth
  if (viewportWidth <= 0) return emailDocumentHeight(document)

  const bodyLeft = body.getBoundingClientRect().left
  let minLeft = 0
  let maxRight = viewportWidth
  for (const element of [body, ...body.querySelectorAll('*')]) {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    minLeft = Math.min(minLeft, rect.left - bodyLeft)
    maxRight = Math.max(maxRight, rect.right - bodyLeft)
  }

  const contentWidth = Math.max(
    viewportWidth,
    body.scrollWidth,
    documentElement.scrollWidth,
    maxRight - minLeft,
  )
  if (contentWidth <= viewportWidth + 1) return emailDocumentHeight(document)

  body.style.setProperty('--omnimail-body-width', `${contentWidth}px`)
  body.style.setProperty('--omnimail-body-max-width', 'none')
  const scale = viewportWidth / contentWidth
  const naturalHeight = emailDocumentHeight(document)
  body.style.setProperty('transform-origin', 'top left')
  body.style.setProperty(
    'transform',
    minLeft < 0 ? `scale(${scale}) translateX(${-minLeft}px)` : `scale(${scale})`,
  )
  return Math.max(EMAIL_FRAME_MIN_HEIGHT, Math.ceil(naturalHeight * scale))
}

export function emailFrameReady(
  messageId: string,
  html: string,
  frameDocument: string,
  inlineImagesLoading: boolean,
  prepared: PreparedEmailFrame | null,
): boolean {
  return !html || (!inlineImagesLoading
    && prepared?.messageId === messageId
    && prepared.document === frameDocument)
}

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
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
    return url.protocol === 'https:'
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && hostname.includes('.')
      && !hostname.includes(':')
      && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
  } catch {
    return false
  }
}

function buildEmailDocument(
  html: string,
  remoteImagesEnabled: boolean,
  inlineImageSources: ReadonlyMap<string, string>,
): string {
  const proxyUrl = new URL(api.remoteImageUrl('https://example.invalid/image'), window.location.href)
  const proxySource = `${proxyUrl.origin}${proxyUrl.pathname}`
  const policy = `default-src 'none'; img-src ${emailImageSources(remoteImagesEnabled, proxySource)}; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'`
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
    image.removeAttribute('srcset')
    if (/^cid:/i.test(source)) {
      const replacement = inlineImageSources.get(normalizeContentId(source))
      if (replacement) image.setAttribute('src', replacement)
      return
    }
    if (remoteImagesEnabled && shouldProxyRemoteImage(source)) {
      image.setAttribute('src', api.remoteImageUrl(source))
    }
  })
  document.querySelectorAll('source[srcset]').forEach((source) => source.removeAttribute('srcset'))
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
  const securityHead = `
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${policy}">
    <meta name="referrer" content="no-referrer">
    <meta name="viewport" content="width=device-width, initial-scale=1">`
  const layoutStyles = `
    <style>
      :root { color-scheme: light; }
      html { width: 100% !important; max-width: 100% !important; overflow-x: hidden !important; }
      body { width: var(--omnimail-body-width, 100%) !important; max-width: var(--omnimail-body-max-width, 100%) !important; overflow-x: hidden !important; }
      body { min-width: 0 !important; margin: 0 !important; padding: 2px !important; color: #222; background: #fff; font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow-wrap: anywhere; }
      body *, body *::before, body *::after { box-sizing: border-box; }
      body > *, table, tbody, tr, td { min-width: 0 !important; max-width: 100% !important; }
      img, video { max-width: 100% !important; height: auto !important; }
      pre, code { max-width: 100% !important; white-space: pre-wrap !important; overflow-wrap: anywhere; }
      a { color: #1d1d1f; text-decoration: underline; }
      a[data-omnimail-href] { cursor: pointer; }
    </style>`
  return `<!doctype html><html><head>${securityHead}${document.head.innerHTML}${layoutStyles}</head><body>${document.body.innerHTML}</body></html>`
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(String(reader.result)))
    reader.addEventListener('error', () => reject(reader.error))
    reader.readAsDataURL(blob)
  })
}

export function MessageReader({
  message,
  loading,
  replyEnabled,
  remoteImagesEnabled,
  thread,
  onBack,
  onStar,
  onTrash,
  onRestore,
  onReplySent,
  canRetryFailedMessage,
  onRetryFailedMessage,
  onSelectThread,
}: {
  message: MessageDetail | null
  loading: boolean
  replyEnabled: boolean
  remoteImagesEnabled: boolean
  thread: MessageSummary[]
  onBack: () => void
  onStar: () => void
  onTrash: () => void
  onRestore: () => void
  onReplySent: () => void
  canRetryFailedMessage: boolean
  onRetryFailedMessage: () => void
  onSelectThread: (message: MessageSummary) => void
}) {
  const [replying, setReplying] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState('')
  const [inlineImageSources, setInlineImageSources] = useState<ReadonlyMap<string, string>>(new Map())
  const [inlineImagesLoading, setInlineImagesLoading] = useState(false)
  const [preparedFrame, setPreparedFrame] = useState<PreparedEmailFrame | null>(null)
  const [externalLink, setExternalLink] = useState<string | null>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const frameResizeObserverRef = useRef<ResizeObserver | null>(null)
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
    setRetrying(false)
    setRetryError('')
    setExternalLink(null)
    setPreparedFrame(null)
  }, [message?.id])
  useEffect(() => () => {
    frameResizeObserverRef.current?.disconnect()
    frameResizeObserverRef.current = null
  }, [message?.id])
  useEffect(() => {
    const controller = new AbortController()
    const inlineAttachments = message?.attachments.filter((attachment) => (
      attachment.contentId && attachment.contentType.startsWith('image/')
    )) ?? []
    setInlineImageSources(new Map())
    setInlineImagesLoading(inlineAttachments.length > 0)

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
      setInlineImagesLoading(false)
    })
    return () => controller.abort()
  }, [message])

  const emailDocument = useMemo(
    () => message?.html
      ? buildEmailDocument(message.html, remoteImagesEnabled, inlineImageSources)
      : '',
    [inlineImageSources, message?.html, remoteImagesEnabled],
  )

  const retryFailedMessage = useCallback(async () => {
    if (retrying) return
    setRetryError('')
    setRetrying(true)
    try {
      if (!message) return
      await failedMailApi.retry(message.id)
      onRetryFailedMessage()
    } catch (error) {
      setRetryError(errorMessage(error))
    } finally {
      setRetrying(false)
    }
  }, [message, onRetryFailedMessage, retrying])

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
      </div>
    )
  }

  const frameIsReady = emailFrameReady(
    message.id,
    message.html,
    emailDocument,
    inlineImagesLoading,
    preparedFrame,
  )

  return (
    <article
      className={`message-reader${frameIsReady ? '' : ' message-reader--preparing'}`}
      aria-busy={!frameIsReady}
    >
      <header className="reader-toolbar">
        <button className="icon-button mobile-back" type="button" onClick={onBack} aria-label={t('返回邮件列表')}>
          <ArrowLeft size={18} />
        </button>
        <h2 className="reader-toolbar__title">{t('邮件详情')}</h2>
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
        <MessageThread currentId={message.id} messages={thread} onSelect={onSelectThread} />

        {message.folder === 'trash' && message.purgeAfter && (
          <p className="trash-retention-notice">
            <Clock3 size={15} />
            {t('该邮件将在 {date} 自动永久删除。', {
              date: formatFullDate(message.purgeAfter),
            })}
          </p>
        )}

        {message.status === 'processing' && (
          <div className="message-notice"><LoaderCircle className="spin" size={17} />
            {t(message.direction === 'outgoing'
              ? '邮件已进入发送队列，系统正在可靠投递。'
              : '邮件正在安全解析，请稍后刷新。')}
          </div>
        )}
        {message.status === 'failed' && (
          <div className="message-notice message-notice--error">
            <AlertCircle size={17} />
            <span className="message-notice__copy">{t(
              message.direction === 'outgoing' ? '发送失败：{error}' : '解析失败：{error}',
              { error: retryError || message.processingError || t('未知错误') },
            )}</span>
            {message.direction === 'outgoing' && canRetryFailedMessage && (
              <button
                className="message-notice__action"
                type="button"
                onClick={() => void retryFailedMessage()}
                disabled={retrying}
              >
                {retrying ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}
                {t(retrying ? '正在重新发送…' : '重新发送')}
              </button>
            )}
          </div>
        )}
        {message.direction === 'outgoing' && message.deliveryStatus === 'delivered' && (
          <div className="message-notice message-notice--success">
            <CheckCircle2 size={17} />{t('收件服务器已确认送达。')}
          </div>
        )}
        {message.direction === 'outgoing' && message.deliveryStatus === 'delayed' && (
          <div className="message-notice">
            <Clock3 size={17} />{t('收件服务器暂时延迟接收，Resend 会继续尝试投递。')}
          </div>
        )}
        {message.direction === 'outgoing'
          && ['bounced', 'complained', 'failed', 'suppressed'].includes(message.deliveryStatus || '') && (
          <div className="message-notice message-notice--error">
            <AlertCircle size={17} />{t('邮件未能送达，详情可在 Resend 控制台查看。')}
          </div>
        )}

        {message.html ? (
          <iframe
            ref={frameRef}
            className="email-frame"
            sandbox={EMAIL_FRAME_SANDBOX}
            scrolling="no"
            srcDoc={emailDocument}
            title={t('邮件正文：{subject}', { subject: message.subject })}
            onLoad={(event) => {
              const frame = event.currentTarget
              const document = frame.contentDocument
              if (!document) return
              document.addEventListener('click', handleEmailLinkClick)
              document.addEventListener('keydown', handleEmailLinkKeyDown)

              const resize = () => {
                const height = `${fitEmailDocument(document)}px`
                if (frame.style.height !== height) frame.style.height = height
              }
              frameResizeObserverRef.current?.disconnect()
              resize()
              const observer = new ResizeObserver(() => requestAnimationFrame(resize))
              if (frame.parentElement) observer.observe(frame.parentElement)
              frameResizeObserverRef.current = observer
              requestAnimationFrame(() => {
                resize()
                setPreparedFrame((current) => (
                  current?.messageId === message.id && current.document === emailDocument
                    ? current
                    : { messageId: message.id, document: emailDocument }
                ))
              })
              document.querySelectorAll('img').forEach((image) => {
                if (!image.complete) image.addEventListener('load', resize, { once: true })
              })
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
      {!frameIsReady && (
        <div className="reader-state reader-state--loading reader-frame-preparing" role="status" aria-live="polite">
          <span className="reader-loading-visual" aria-hidden="true">
            <span className="reader-loading-mail"><Mail size={23} /></span>
          </span>
          <span className="reader-loading-copy">
            <strong>{t('正在打开邮件')}</strong>
            <small>{t('正在准备邮件布局')}</small>
          </span>
        </div>
      )}
    </article>
  )
}
