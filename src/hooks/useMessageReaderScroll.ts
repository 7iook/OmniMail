import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'

export function subjectPassedReaderTop(
  subjectBottom: number,
  readerTop: number,
  isIntersecting: boolean,
): boolean {
  return !isIntersecting && subjectBottom <= readerTop
}

export function useMessageReaderScroll(
  messageId: string,
  readerRoot: RefObject<HTMLDivElement | null>,
) {
  const subjectHeading = useRef<HTMLHeadingElement>(null)
  const [pinnedSubjectId, setPinnedSubjectId] = useState<string | null>(null)

  useEffect(() => {
    setPinnedSubjectId(null)
    const root = readerRoot.current
    const heading = subjectHeading.current
    if (!messageId || !root || !heading) return

    const observer = new IntersectionObserver(([entry]) => {
      const readerTop = entry.rootBounds?.top ?? root.getBoundingClientRect().top
      setPinnedSubjectId(subjectPassedReaderTop(
        entry.boundingClientRect.bottom,
        readerTop,
        entry.isIntersecting,
      ) ? messageId : null)
    }, { root })
    observer.observe(heading)
    return () => observer.disconnect()
  }, [messageId, readerRoot])

  const scrollToTop = useCallback(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    readerRoot.current?.scrollTo({
      top: 0,
      behavior: reducedMotion ? 'auto' : 'smooth',
    })
  }, [readerRoot])

  return {
    scrollToTop,
    subjectHeading,
    subjectPinned: Boolean(messageId && pinnedSubjectId === messageId),
  }
}
