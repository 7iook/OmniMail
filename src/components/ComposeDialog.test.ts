import { describe, expect, it } from 'vitest'
import { mergeLoadedDraftFields, type ComposeDraftFields } from './ComposeDialog'
import type { MailboxAddress } from '../lib/api'

const mailboxes: MailboxAddress[] = [
  { address: 'owner@example.com', domain: 'example.com', isPrimary: true, isActive: true },
  { address: 'owner@other.example', domain: 'other.example', isPrimary: false, isActive: true },
]

describe('compose draft loading', () => {
  it('does not overwrite a subject entered while the saved draft is loading', () => {
    const current: ComposeDraftFields = {
      mailboxAddress: 'owner@example.com',
      to: '',
      subject: 'New eSIM Acasă 80 cannot register on roaming network in China',
      text: '',
    }
    const loaded: ComposeDraftFields = {
      mailboxAddress: 'owner@other.example',
      to: 'support@example.net',
      subject: 'Older saved subject',
      text: 'Older saved body',
    }

    expect(mergeLoadedDraftFields(current, loaded, new Set(['subject']), mailboxes)).toEqual({
      mailboxAddress: 'owner@other.example',
      to: 'support@example.net',
      subject: current.subject,
      text: 'Older saved body',
    })
  })

  it('keeps the current mailbox when a saved mailbox is no longer available', () => {
    const current: ComposeDraftFields = {
      mailboxAddress: 'owner@example.com',
      to: '',
      subject: '',
      text: '',
    }

    expect(mergeLoadedDraftFields(current, {
      ...current,
      mailboxAddress: 'disabled@example.net',
    }, new Set(), mailboxes).mailboxAddress).toBe('owner@example.com')
  })
})
