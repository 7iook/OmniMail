import {
  AlertCircle,
  ArrowLeft,
  Download,
  LoaderCircle,
  Mail,
  Paperclip,
  Reply,
  Send,
  Star,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { api, type MessageDetail } from '../lib/api'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '发生了未知错误。'
}

function formatFullDate(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
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

function buildEmailDocument(html: string): string {
  const policy = "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"
  const document = new DOMParser().parseFromString(html, 'text/html')
  document.querySelectorAll('script, iframe, object, embed, form, base, meta[http-equiv]').forEach((node) => node.remove())
  document.querySelectorAll('*').forEach((node) => {
    for (const attribute of [...node.attributes]) {
      if (attribute.name.toLowerCase().startsWith('on') || attribute.name.toLowerCase() === 'srcdoc') {
        node.removeAttribute(attribute.name)
      }
    }
  })
  document.querySelectorAll('a[href]').forEach((link) => link.removeAttribute('href'))
  const head = `
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${policy}">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      :root { color-scheme: light; }
      body { margin: 0; padding: 2px; color: #222; background: #fff; font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow-wrap: anywhere; }
      img { max-width: 100%; height: auto; }
      table { max-width: 100% !important; }
      pre { white-space: pre-wrap; }
      a { color: #1d1d1f; text-decoration: underline; }
    </style>`
  return `<!doctype html><html><head>${head}${document.head.innerHTML}</head><body>${document.body.innerHTML}</body></html>`
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
          <small>回复给</small>
          <strong>{message.senderName || message.senderAddress}</strong>
        </div>
        <button className="icon-button icon-button--small" type="button" onClick={onClose} aria-label="关闭回复">
          <X size={17} />
        </button>
      </div>
      <label className="sr-only" htmlFor="reply-body">回复内容</label>
      <textarea
        id="reply-body"
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="写下回复…"
        maxLength={50_000}
      />
      {error && <p className="inline-error" role="alert"><AlertCircle size={15} />{error}</p>}
      <div className="reply-composer__footer">
        <span>通过 Resend 发送</span>
        <button className="button button--primary button--small" type="submit" disabled={sending || !text.trim()}>
          {sending ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}
          发送回复
        </button>
      </div>
    </form>
  )
}

export function MessageReader({
  message,
  loading,
  replyEnabled,
  onBack,
  onStar,
  onTrash,
  onRestore,
  onReplySent,
}: {
  message: MessageDetail | null
  loading: boolean
  replyEnabled: boolean
  onBack: () => void
  onStar: () => void
  onTrash: () => void
  onRestore: () => void
  onReplySent: () => void
}) {
  const [replying, setReplying] = useState(false)

  useEffect(() => setReplying(false), [message?.id])

  if (loading) {
    return <div className="reader-state" role="status"><LoaderCircle className="spin" size={23} />正在打开邮件</div>
  }
  if (!message) {
    return (
      <div className="reader-state reader-state--empty">
        <span className="reader-empty-symbol"><Mail size={29} /></span>
        <h2>选择一封邮件</h2>
        <p>邮件内容会安全地显示在这里，远程图片默认被阻止。</p>
      </div>
    )
  }

  return (
    <article className="message-reader">
      <header className="reader-toolbar">
        <button className="icon-button mobile-back" type="button" onClick={onBack} aria-label="返回邮件列表">
          <ArrowLeft size={18} />
        </button>
        <div className="reader-toolbar__spacer" />
        {message.folder === 'trash' && (
          <button className="toolbar-button" type="button" onClick={onRestore}>
            <Undo2 size={16} /> 恢复
          </button>
        )}
        <button className="icon-button" type="button" onClick={onStar} aria-label={message.isStarred ? '取消星标' : '添加星标'}>
          <Star size={17} fill={message.isStarred ? 'currentColor' : 'none'} />
        </button>
        <button className="icon-button icon-button--danger" type="button" onClick={onTrash} aria-label={message.folder === 'trash' ? '永久删除' : '移入垃圾箱'}>
          <Trash2 size={17} />
        </button>
      </header>

      <div className="reader-content">
        <header className="message-heading">
          <h1>{message.subject || '无主题'}</h1>
          <div className="sender-block">
            <span className="sender-avatar">
              {(message.senderName || message.senderAddress || 'M').slice(0, 1).toUpperCase()}
            </span>
            <div>
              <strong>{message.senderName || message.senderAddress}</strong>
              {message.senderName && <span>&lt;{message.senderAddress}&gt;</span>}
              <small>
                {message.direction === 'outgoing'
                  ? `发给 ${message.recipients.join(', ')}`
                  : `发送至 ${message.mailboxAddress}`}
              </small>
            </div>
            <time dateTime={new Date(message.date).toISOString()}>{formatFullDate(message.date)}</time>
          </div>
        </header>

        {message.status === 'processing' && (
          <div className="message-notice"><LoaderCircle className="spin" size={17} />邮件正在安全解析，请稍后刷新。</div>
        )}
        {message.status === 'failed' && (
          <div className="message-notice message-notice--error">
            <AlertCircle size={17} />解析失败：{message.processingError || '未知错误'}
          </div>
        )}

        {message.html ? (
          <iframe
            className="email-frame"
            sandbox=""
            srcDoc={buildEmailDocument(message.html)}
            title={`邮件正文：${message.subject}`}
          />
        ) : (
          <div className="plain-body">{message.text || '这封邮件没有可显示的正文。'}</div>
        )}

        {message.attachments.length > 0 && (
          <section className="attachments" aria-labelledby="attachments-title">
            <h2 id="attachments-title"><Paperclip size={16} />附件</h2>
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
              <Download size={14} /> 下载原始邮件
            </a>
          )}
          {message.direction === 'incoming' && replyEnabled && message.status === 'ready' && !replying && (
            <button className="button button--secondary" type="button" onClick={() => setReplying(true)}>
              <Reply size={16} /> 回复
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
    </article>
  )
}
