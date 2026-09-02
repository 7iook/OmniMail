import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MicrosoftTransportAttempt } from '../../../shared/api'
import { ensureEnglishTranslations, setLocale } from '../../../shared/i18n'
import { microsoftImportResultError } from './microsoft-import-result'

const graphDenied: MicrosoftTransportAttempt = {
  transport: 'graph', category: 'permission', code: 'graph_permission_denied', status: 403,
  message: 'Microsoft 授权缺少 Outlook 邮件权限（Graph 403），请重新授权。',
}
const imapRejected: MicrosoftTransportAttempt = {
  transport: 'imap', category: 'auth', code: 'imap_access_rejected', status: 401,
  message: 'Microsoft 拒绝 IMAP OAuth2 登录；请检查权限或租户是否启用 IMAP。',
}

describe('Microsoft import row failure text', () => {
  beforeAll(() => ensureEnglishTranslations())
  afterAll(() => setLocale('zh-CN'))

  it('labels every attempted channel with the sentence the worker sent', () => {
    expect(microsoftImportResultError({
      code: 'transport_unavailable', error: '两个通道都失败了。', attempts: [graphDenied, imapRejected],
    })).toBe(
      'Graph：Microsoft 授权缺少 Outlook 邮件权限（Graph 403），请重新授权。'
      + ' · IMAP：Microsoft 拒绝 IMAP OAuth2 登录；请检查权限或租户是否启用 IMAP。',
    )
  })

  it('still labels a single attempt so one refusal never reads as both channels failing', () => {
    expect(microsoftImportResultError({ code: 'graph_permission_denied', attempts: [graphDenied] }))
      .toBe('Graph：Microsoft 授权缺少 Outlook 邮件权限（Graph 403），请重新授权。')
  })

  it('never invents a sentence: an attempt without one shows its code', () => {
    expect(microsoftImportResultError({ attempts: [{ ...imapRejected, message: '' }] }))
      .toBe('IMAP：imap_access_rejected')
  })

  it('keeps the old fallback chain when there are no attempts', () => {
    expect(microsoftImportResultError({ error: '服务端句子。', code: 'duplicate' })).toBe('服务端句子。')
    expect(microsoftImportResultError({ code: 'duplicate' })).toBe('账号已存在。')
    expect(microsoftImportResultError({ attempts: [] })).toBe('账号验证失败，请检查凭据与权限。')
    expect(microsoftImportResultError({})).toBe('账号验证失败，请检查凭据与权限。')
  })

  it('translates only the frame in English; the server sentence stays verbatim', () => {
    setLocale('en-US')
    expect(microsoftImportResultError({ attempts: [graphDenied, imapRejected] })).toBe(
      'Graph: Microsoft 授权缺少 Outlook 邮件权限（Graph 403），请重新授权。'
      + ' · IMAP: Microsoft 拒绝 IMAP OAuth2 登录；请检查权限或租户是否启用 IMAP。',
    )
    expect(microsoftImportResultError({})).toBe('Account verification failed. Check the credential and permissions.')
  })
})
