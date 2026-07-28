import { useEffect, useRef, useState } from 'react'

const MAX_REFRESH_DELAY = 120
const REFRESH_LOCK = 'omnimail-mail-refresh-leader'

export function nextRefreshDelay(
  current: number,
  base: number,
  changed?: boolean | void,
): number {
  return changed === false
    ? Math.min(MAX_REFRESH_DELAY, Math.max(base, current * 2))
    : base
}

function useRefreshLeadership(enabled: boolean): boolean {
  const [leader, setLeader] = useState(false)

  useEffect(() => {
    if (!enabled) {
      setLeader(false)
      return
    }
    const locks = navigator.locks
    if (!locks?.request) {
      setLeader(true)
      return () => setLeader(false)
    }

    let active = true
    let queued: AbortController | undefined
    let release: (() => void) | undefined

    const yieldLeadership = (updateState: boolean) => {
      queued?.abort()
      queued = undefined
      release?.()
      release = undefined
      if (updateState) setLeader(false)
    }
    const acquireLeadership = () => {
      if (!active || document.visibilityState !== 'visible') return
      queued = new AbortController()
      let finish!: () => void
      const hold = new Promise<void>((resolve) => { finish = resolve })
      void locks.request(REFRESH_LOCK, { signal: queued.signal }, async () => {
        queued = undefined
        if (!active || document.visibilityState !== 'visible') return
        release = finish
        setLeader(true)
        await hold
        if (active) setLeader(false)
      }).catch((error: unknown) => {
        if (active && !(error instanceof DOMException && error.name === 'AbortError')) {
          setLeader(true)
        }
      })
    }
    const handleVisibility = () => {
      yieldLeadership(true)
      acquireLeadership()
    }

    document.addEventListener('visibilitychange', handleVisibility)
    acquireLeadership()
    return () => {
      active = false
      document.removeEventListener('visibilitychange', handleVisibility)
      yieldLeadership(false)
    }
  }, [enabled])

  return leader
}

export function useAutoRefresh(
  seconds: number,
  refresh: () => Promise<boolean | void>,
  enabled: boolean,
) {
  const callback = useRef(refresh)
  const leader = useRefreshLeadership(enabled)

  useEffect(() => {
    callback.current = refresh
  }, [refresh])

  useEffect(() => {
    if (!enabled || !leader || seconds <= 0) return
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
  }, [enabled, leader, seconds])
}
