import { Check, ChevronDown, Globe2 } from 'lucide-react'
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import type { ICloudHost } from '../lib/api'
import { t } from '../lib/i18n'

const regions: Array<{ value: ICloudHost; label: string; domain: string }> = [
  { value: 'icloud.com', label: '全球', domain: 'icloud.com' },
  { value: 'icloud.com.cn', label: '中国大陆', domain: 'icloud.com.cn' },
]

export function ICloudRegionSelect({ value, onChange }: {
  value: ICloudHost
  onChange: (value: ICloudHost) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const menuId = useId()
  const selectedIndex = Math.max(0, regions.findIndex((region) => region.value === value))
  const selected = regions[selectedIndex]

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  function showMenu(index = selectedIndex) {
    setOpen(true)
    requestAnimationFrame(() => optionRefs.current[index]?.focus())
  }

  function closeMenu(focusTrigger = false) {
    setOpen(false)
    if (focusTrigger) requestAnimationFrame(() => trigger.current?.focus())
  }

  function handleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    showMenu(event.key === 'ArrowUp' ? regions.length - 1 : selectedIndex)
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const current = optionRefs.current.findIndex((option) => option === document.activeElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMenu(true)
      return
    }
    if (event.key === 'Tab') {
      setOpen(false)
      return
    }
    let next = current
    if (event.key === 'ArrowDown') next = Math.min(regions.length - 1, current + 1)
    else if (event.key === 'ArrowUp') next = Math.max(0, current - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = regions.length - 1
    else return
    event.preventDefault()
    optionRefs.current[next]?.focus()
  }

  return (
    <div className={`icloud-region-select${open ? ' is-open' : ''}`} ref={root}>
      <button ref={trigger} className="icloud-region-select__trigger" type="button"
        role="combobox" aria-label={t('iCloud 区域')} aria-haspopup="listbox"
        aria-expanded={open} aria-controls={menuId}
        onClick={() => open ? closeMenu() : showMenu()} onKeyDown={handleTriggerKeyDown}>
        <span className="icloud-region-select__icon"><Globe2 size={16} aria-hidden="true" /></span>
        <span><strong>{t(selected.label)}</strong><small>{selected.domain}</small></span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="icloud-region-select__menu" id={menuId} role="listbox"
          aria-label={t('iCloud 区域')} onKeyDown={handleMenuKeyDown}>
          {regions.map((region, index) => (
            <button ref={(node) => { optionRefs.current[index] = node }}
              className={region.value === value ? 'is-selected' : ''} type="button"
              role="option" aria-selected={region.value === value}
              tabIndex={region.value === value ? 0 : -1} key={region.value}
              onClick={() => { onChange(region.value); closeMenu(true) }}>
              <span className="icloud-region-select__icon"><Globe2 size={16} aria-hidden="true" /></span>
              <span><strong>{t(region.label)}</strong><small>{region.domain}</small></span>
              {region.value === value && <Check size={16} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
