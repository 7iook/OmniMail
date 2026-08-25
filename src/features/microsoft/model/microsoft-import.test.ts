import { describe, expect, it } from 'vitest'
import { MICROSOFT_IMPORT_ALTERNATE_FORMAT, MICROSOFT_IMPORT_FORMATS,
  parseMicrosoftImportText } from './microsoft-import'

const clientId = '00000000-0000-4000-8000-000000000000'

describe('Microsoft line import preview', () => {
  it('recognizes full, password-only, and empty-password OAuth2 formats', () => {
    expect(MICROSOFT_IMPORT_FORMATS).toEqual([
      'email----password----refresh_token----client_id',
      'email----password',
      'email--------refresh_token----client_id',
    ])
    expect(MICROSOFT_IMPORT_ALTERNATE_FORMAT)
      .toBe('email----password----client_id----refresh_token')
    const rows = parseMicrosoftImportText([
      `full@outlook.com----password----refresh-one----${clientId}`,
      `reversed@outlook.com----password----${clientId}----refresh-reversed`,
      'password@outlook.com----app-password',
      `oauth@outlook.com--------refresh-two----${clientId}`,
      `oauth-reversed@outlook.com--------${clientId}----refresh-three`,
    ].join('\n'))
    expect(rows.map(({ preview }) => preview.mode)).toEqual([
      'oauth2_combination', 'oauth2_combination', 'password', 'oauth2', 'oauth2',
    ])
    expect(rows[0].input).toMatchObject({
      authMode: 'oauth2', refreshToken: 'refresh-one', clientId, password: undefined,
    })
    expect(rows[1].input).toMatchObject({
      authMode: 'oauth2', refreshToken: 'refresh-reversed', clientId, password: undefined,
    })
    expect(rows[4].input).toMatchObject({
      authMode: 'oauth2', refreshToken: 'refresh-three', clientId, password: undefined,
    })
  })

  it('strips a BOM and empty lines, normalizes email, and marks batch duplicates', () => {
    const rows = parseMicrosoftImportText(
      `\uFEFF User@Outlook.com----password\n\nuser@outlook.com----password-two`,
    )
    expect(rows).toHaveLength(2)
    expect(rows[0].preview).toMatchObject({ email: 'user@outlook.com', status: 'ready' })
    expect(rows[1].preview).toMatchObject({ email: 'user@outlook.com', status: 'duplicate' })
  })

  it('returns line-specific errors without retaining secrets in preview output', () => {
    const rows = parseMicrosoftImportText([
      'not-an-email----password',
      'user@outlook.com----password----refresh----not-a-uuid',
      `ambiguous@outlook.com----password----${clientId}----${clientId}`,
      'extra@outlook.com----pass----with----delimiter----extra',
    ].join('\n'))
    expect(rows.map(({ preview }) => preview.status)).toEqual(['error', 'error', 'error', 'error'])
    expect(rows[1].preview.error).toContain('两段顺序均可')
    expect(rows[2].preview.error).toContain('必须且只能')
    expect(rows[3].preview.error).toContain('分字段')
    const previews = JSON.stringify(rows.map(({ preview }) => preview))
    expect(previews).not.toContain('not-a-uuid')
    expect(previews).not.toContain(clientId)
  })
})
