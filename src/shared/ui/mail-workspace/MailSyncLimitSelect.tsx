import type { MailSyncLimit } from '../../api'
import { t } from '../../i18n'

const SYNC_LIMITS: MailSyncLimit[] = [10, 20, 50]

export function MailSyncLimitSelect({ id, value, disabled, onChange }: {
  id: string
  value: MailSyncLimit
  disabled: boolean
  onChange: (value: MailSyncLimit) => void
}) {
  const helpId = `${id}-help`
  return <label className="mail-sync-limit" htmlFor={id}>
    <span>{t('本次最多同步')}</span>
    <select id={id} value={value} disabled={disabled} aria-describedby={helpId}
      onChange={(event) => onChange(Number(event.target.value) as MailSyncLimit)}>
      {SYNC_LIMITS.map((limit) => <option value={limit} key={limit}>
        {t('{count} 封邮件', { count: limit })}
      </option>)}
    </select>
    <small id={helpId}>{t('只影响这次手动同步；后台同步默认每次最多 20 封。')}</small>
  </label>
}
