import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useId, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { MicrosoftAuthMode } from '../../../shared/api'
import { t } from '../../../shared/i18n'

const options = [
  { value: 'oauth2' as const, label: 'OAuth2' },
  { value: 'password' as const, label: '密码兼容模式' },
]

export function MicrosoftAuthModeSelect({ value, onChange }: {
  value: MicrosoftAuthMode
  onChange: (value: MicrosoftAuthMode) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const menuId = useId()
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))

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
      event.preventDefault(); event.stopPropagation(); closeMenu()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    showMenu(event.key === 'ArrowUp' ? options.length - 1 : selectedIndex)
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const current = optionRefs.current.findIndex((option) => option === document.activeElement)
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); closeMenu(true)
      return
    }
    if (event.key === 'Tab') { setOpen(false); return }
    let next = current
    if (event.key === 'ArrowDown') next = Math.min(options.length - 1, current + 1)
    else if (event.key === 'ArrowUp') next = Math.max(0, current - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = options.length - 1
    else return
    event.preventDefault()
    optionRefs.current[next]?.focus()
  }

  return <div className={`microsoft-auth-select${open ? ' is-open' : ''}`} ref={root}>
    <button ref={trigger} className="microsoft-auth-select__trigger" type="button" role="combobox"
      aria-label={t('认证方式')} aria-haspopup="listbox" aria-expanded={open} aria-controls={menuId}
      onClick={() => open ? closeMenu() : showMenu()} onKeyDown={handleTriggerKeyDown}>
      <span>{t(options[selectedIndex].label)}</span>
      <ChevronDown size={16} aria-hidden="true" />
    </button>
    {open && <div className="microsoft-auth-select__menu" id={menuId} role="listbox"
      aria-label={t('认证方式')} onKeyDown={handleMenuKeyDown}>
      {options.map((option, index) => <button type="button" role="option"
        ref={(node) => { optionRefs.current[index] = node }} key={option.value}
        className={option.value === value ? 'is-selected' : ''}
        aria-selected={option.value === value} tabIndex={option.value === value ? 0 : -1}
        onClick={() => { onChange(option.value); closeMenu(true) }}>
        <span>{t(option.label)}</span>{option.value === value && <Check size={16} aria-hidden="true" />}
      </button>)}
    </div>}
  </div>
}
