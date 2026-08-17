import { describe, expect, it } from 'vitest'
import { parseICloudMessage } from './icloud-message-parser'

const encoder = new TextEncoder()
const multipartMessage = encoder.encode([
  'From: GitHub <noreply@github.com>',
  'To: alias@icloud.com',
  'Subject: Your GitHub launch code!',
  'Date: Mon, 17 Aug 2026 12:00:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="omnimail-test"',
  '',
  '--omnimail-test',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Enter code 20076446 at https://github.com/account_verifications',
  '--omnimail-test',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><body><h1>Your GitHub launch code!</h1><p>Enter <strong>20076446</strong>.</p><a href="https://github.com/account_verifications">Open GitHub</a></body></html>',
  '--omnimail-test--',
  '',
].join('\r\n'))

describe('iCloud IMAP message parsing', () => {
  it('keeps the HTML alternative for a full message detail', async () => {
    const message = await parseICloudMessage(multipartMessage, '42', true)

    expect(message.body).toContain('Enter code 20076446')
    expect(message.html).toContain('<strong>20076446</strong>')
    expect(message.html).toContain('https://github.com/account_verifications')
  })

  it('omits HTML from inbox summaries', async () => {
    const message = await parseICloudMessage(multipartMessage, '42')

    expect(message.preview).toContain('Enter code 20076446')
    expect(message.html).toBe('')
  })
})
