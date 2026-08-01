import {
  type SyntheticEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { loadDeferredRemoteImages } from '../lib/emailContent'

export const EMAIL_FRAME_SANDBOX = 'allow-same-origin'
const EMAIL_FRAME_MIN_HEIGHT = 470
const FADE_OUT_MS = 90

export type PreparedEmailFrame = {
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

function watchImages(document: Document, resize: () => void) {
  document.querySelectorAll('img').forEach((image) => {
    if (!image.complete) image.addEventListener('load', resize, { once: true })
  })
}

export function useSmoothEmailFrame({
  messageId,
  initialDocument,
  displayedDocument,
  onLinkClick,
  onLinkKeyDown,
  onScrollActivity,
}: {
  messageId: string
  initialDocument: string
  displayedDocument: string
  onLinkClick: (event: Event) => void
  onLinkKeyDown: (event: KeyboardEvent) => void
  onScrollActivity: () => void
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const resizeObserver = useRef<ResizeObserver | null>(null)
  const resizeFrame = useRef<(() => void) | null>(null)
  const appliedDocument = useRef('')
  const frameReady = useRef(false)
  const timer = useRef<number | null>(null)
  const animationFrames = useRef<number[]>([])
  const [preparedFrame, setPreparedFrame] = useState<PreparedEmailFrame | null>(null)
  const [loadVersion, setLoadVersion] = useState(0)

  const cancelTransition = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    for (const frame of animationFrames.current) window.cancelAnimationFrame(frame)
    animationFrames.current = []
    const body = frameRef.current?.contentDocument?.body
    if (body) body.style.opacity = '1'
  }, [])

  useLayoutEffect(() => {
    cancelTransition()
    frameReady.current = false
    appliedDocument.current = ''
  }, [cancelTransition, initialDocument, messageId])

  useEffect(() => () => {
    cancelTransition()
    resizeObserver.current?.disconnect()
  }, [cancelTransition])

  useEffect(() => {
    if (!frameReady.current
      || !displayedDocument
      || appliedDocument.current === displayedDocument) return
    const document = frameRef.current?.contentDocument
    if (!document?.body) return
    const next = new DOMParser().parseFromString(displayedDocument, 'text/html')
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    document.body.style.opacity = '0'
    timer.current = window.setTimeout(() => {
      document.head.innerHTML = next.head.innerHTML
      document.body.innerHTML = next.body.innerHTML
      document.body.style.opacity = '0'
      appliedDocument.current = displayedDocument
      const resize = resizeFrame.current
      if (resize) {
        resize()
        watchImages(document, resize)
        animationFrames.current.push(window.requestAnimationFrame(() => {
          loadDeferredRemoteImages(document, resize)
        }))
      }
      animationFrames.current.push(window.requestAnimationFrame(() => {
        animationFrames.current.push(window.requestAnimationFrame(() => {
          document.body.style.opacity = '1'
        }))
      }))
    }, reducedMotion ? 0 : FADE_OUT_MS)
    return cancelTransition
  }, [cancelTransition, displayedDocument, loadVersion])

  const onLoad = useCallback((event: SyntheticEvent<HTMLIFrameElement>) => {
    const frame = event.currentTarget
    const document = frame.contentDocument
    if (!document) return
    cancelTransition()
    frameReady.current = true
    appliedDocument.current = initialDocument
    document.body.style.opacity = '1'
    document.addEventListener('click', onLinkClick)
    document.addEventListener('keydown', onLinkKeyDown)
    document.addEventListener('wheel', onScrollActivity, { passive: true })
    document.addEventListener('touchmove', onScrollActivity, { passive: true })

    const resize = () => {
      const height = `${fitEmailDocument(document)}px`
      if (frame.style.height !== height) frame.style.height = height
    }
    resizeFrame.current = resize
    resizeObserver.current?.disconnect()
    resize()
    const observer = new ResizeObserver(() => window.requestAnimationFrame(resize))
    if (frame.parentElement) observer.observe(frame.parentElement)
    resizeObserver.current = observer
    watchImages(document, resize)
    window.requestAnimationFrame(() => {
      resize()
      setPreparedFrame({ messageId, document: initialDocument })
      window.requestAnimationFrame(() => loadDeferredRemoteImages(document, resize))
      setLoadVersion((current) => current + 1)
    })
  }, [cancelTransition, initialDocument, messageId, onLinkClick, onLinkKeyDown, onScrollActivity])

  return { frameRef, onLoad, preparedFrame }
}
