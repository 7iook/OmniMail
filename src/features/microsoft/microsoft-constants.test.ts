import { describe, expect, it } from 'vitest'
import { isMicrosoftJunkFolderPath, MICROSOFT_JUNK_FOLDER_PATH } from './microsoft-constants'

describe('Microsoft Junk Email folder path constant', () => {
  it('mirrors the backend\'s fixed literal path', () => {
    expect(MICROSOFT_JUNK_FOLDER_PATH).toBe('Junk Email')
  })

  it('matches case-insensitively', () => {
    expect(isMicrosoftJunkFolderPath('Junk Email')).toBe(true)
    expect(isMicrosoftJunkFolderPath('JUNK EMAIL')).toBe(true)
    expect(isMicrosoftJunkFolderPath('junk email')).toBe(true)
  })

  it('does not match other folders', () => {
    expect(isMicrosoftJunkFolderPath('INBOX')).toBe(false)
    expect(isMicrosoftJunkFolderPath('Sent Items')).toBe(false)
  })
})
