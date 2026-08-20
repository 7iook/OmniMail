import { Cloud, Mail } from 'lucide-react'

export type MailSource = 'omnimail' | 'icloud'

export function PanelMailSourceTabs({ source, onChange, labelledBy }: {
  source: MailSource
  onChange: (source: MailSource) => void
  labelledBy?: string
}) {
  return (
    <div className="mail-source-switcher" role="tablist"
      aria-label={labelledBy ? undefined : '邮箱类型'} aria-labelledby={labelledBy}>
      <button className={source === 'omnimail' ? 'is-active' : ''} type="button"
        role="tab" aria-selected={source === 'omnimail'} onClick={() => onChange('omnimail')}>
        <Mail size={15} aria-hidden="true" />OmniMail
      </button>
      <button className={source === 'icloud' ? 'is-active' : ''} type="button"
        role="tab" aria-selected={source === 'icloud'} onClick={() => onChange('icloud')}>
        <Cloud size={15} aria-hidden="true" />iCloud
      </button>
    </div>
  )
}
