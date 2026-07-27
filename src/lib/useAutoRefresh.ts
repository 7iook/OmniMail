import { useEffect, useRef } from 'react'

export function useAutoRefresh(
  seconds: number,
  refresh: () => Promise<void>,
  enabled: boolean,
) {
  const callback = useRef(refresh)

  useEffect(() => {
    callback.current = refresh
  }, [refresh])

  useEffect(() => {
    if (!enabled || seconds <= 0) return
    let running = false
    const timer = window.setInterval(async () => {
      if (running || document.visibilityState !== 'visible') return
      running = true
      try {
        await callback.current()
      } finally {
        running = false
      }
    }, seconds * 1000)
    return () => window.clearInterval(timer)
  }, [enabled, seconds])
}
