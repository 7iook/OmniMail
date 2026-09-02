import type { MicrosoftImportResult, MicrosoftTransportAttempt } from '../../../shared/api'
import { t } from '../../../shared/i18n'

/** Channel names are proper nouns and stay untranslated, like "OAuth2" elsewhere. */
const TRANSPORT_LABELS: Record<MicrosoftTransportAttempt['transport'], string> = {
  graph: 'Graph',
  imap: 'IMAP',
}

/**
 * The one-line reason shown under a failed import row.
 *
 * When the worker reports per-channel `attempts`, each one is rendered as
 * `<channel>：<server sentence>` so the user sees which channel refused and why
 * (I-7). The sentence comes from the worker's message table — this never maps a
 * code to text of its own. A single attempt is still labelled, so a Graph-only
 * failure cannot read as "both channels failed".
 */
export function microsoftImportResultError(
  result: Pick<MicrosoftImportResult, 'code' | 'error' | 'attempts'>,
): string {
  if (result.attempts?.length) {
    return result.attempts
      .map((attempt) => t('{channel}：{message}', {
        channel: TRANSPORT_LABELS[attempt.transport] ?? attempt.transport,
        message: attempt.message || attempt.code,
      }))
      .join(' · ')
  }
  if (result.error) return result.error
  if (result.code === 'duplicate') return t('账号已存在。')
  return t('账号验证失败，请检查凭据与权限。')
}
