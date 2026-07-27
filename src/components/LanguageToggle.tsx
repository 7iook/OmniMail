import { Languages } from 'lucide-react'
import { getLocale, setLocale, t, useLocale, type Locale } from '../lib/i18n'

export function LanguageToggle({ labeled = false }: { labeled?: boolean }) {
  useLocale()
  const locale = getLocale()
  const choices: Array<{ value: Locale; label: string; compact: string }> = [
    { value: 'zh-CN', label: '简体中文', compact: '中' },
    { value: 'en-US', label: 'English', compact: 'EN' },
  ]

  return (
    <div
      className={`language-selector ${labeled ? 'is-labeled' : ''}`}
      role="radiogroup"
      aria-label={t('界面语言')}
    >
      {labeled && <Languages size={15} aria-hidden="true" />}
      {choices.map((choice) => (
        <button
          className={locale === choice.value ? 'is-selected' : ''}
          type="button"
          role="radio"
          aria-checked={locale === choice.value}
          title={t(choice.label)}
          key={choice.value}
          onClick={() => setLocale(choice.value)}
        >
          {labeled ? t(choice.label) : choice.compact}
        </button>
      ))}
    </div>
  )
}
