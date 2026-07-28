import { useEffect, useRef } from 'react'

const MAX_REFRESH_DELAY = 120

export function nextRefreshDelay(
  current: number,
  base: number,
  changed?: boolean | void,
): number {
  return changed === false
    ? Math.min(MAX_REFRESH_DELAY, Math.max(base, current * 2))
    : base
}

export function useAutoRefresh(
  seconds: number,
  refresh: () => Promise<boolean | void>,
  enabled: boolean,
) {
  const callback = useRef(refresh)

  useEffect(() => {
    callback.current = refresh
  }, [refresh])

  useEffect(() => {
    if (!enabled || seconds <= 0) return
    let stopped = false
    let running = false
    let delay = seconds
    let timer: number | undefined

    const schedule = () => {
      if (!stopped) timer = window.setTimeout(() => void run(), delay * 1000)
    }
    const run = async () => {
      if (running) return
      if (document.visibilityState !== 'visible') {
        schedule()
        return
      }
      running = true
      try {
        delay = nextRefreshDelay(delay, seconds, await callback.current())
      } finally {
        running = false
        schedule()
      }
    }
    const refreshVisiblePage = () => {
      if (document.visibilityState !== 'visible') return
      delay = seconds
      if (timer !== undefined) window.clearTimeout(timer)
      void run()
    }

    document.addEventListener('visibilitychange', refreshVisiblePage)
    window.addEventListener('focus', refreshVisiblePage)
    schedule()
    return () => {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', refreshVisiblePage)
      window.removeEventListener('focus', refreshVisiblePage)
    }
  }, [enabled, seconds])
}
