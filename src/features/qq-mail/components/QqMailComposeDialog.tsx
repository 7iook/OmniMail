import { t } from '../../../shared/i18n'
import {
  SmtpComposeDialog,
  type SmtpComposeInput,
} from '../../../shared/ui/mail-workspace/SmtpComposeDialog'
import { QqMailIcon } from './QqMailIcon'

export type QqMailComposeInput = SmtpComposeInput

export function QqMailComposeDialog({ email, initialTo, initialSubject,
  busy, error, onCancel, onSubmit }: {
  email: string
  initialTo?: string
  initialSubject?: string
  busy: boolean
  error: string
  onCancel: () => void
  onSubmit: (input: QqMailComposeInput) => Promise<void>
}) {
  return <SmtpComposeDialog sender={email} title={t(initialTo ? '回复 QQ 邮件' : '新建 QQ 邮件')}
    providerLabel={t('QQ SMTP')} deliveryNote={t('通过 QQ 邮箱官方 SMTP 安全发送。')}
    senderIcon={<QqMailIcon width={14} height={14} aria-hidden="true" />}
    initialTo={initialTo} initialSubject={initialSubject}
    busy={busy} error={error} onCancel={onCancel} onSubmit={onSubmit} />
}
