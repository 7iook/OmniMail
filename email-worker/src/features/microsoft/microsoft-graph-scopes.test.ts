import { describe, expect, it } from 'vitest'
import {
  GRAPH_MAIL_READ_SCOPE,
  GRAPH_MAIL_READ_WRITE_SCOPE,
  GRAPH_SCOPE_FOR_OPERATION,
  MICROSOFT_GRAPH_TOKEN_SCOPE,
  graphScopeGranted,
} from './microsoft-graph-scopes'

describe('Microsoft Graph OAuth scopes', () => {
  it('requests mail read-write plus offline_access so refresh tokens keep rotating', () => {
    expect(MICROSOFT_GRAPH_TOKEN_SCOPE.split(' ')).toEqual([
      'https://graph.microsoft.com/Mail.Read',
      'https://graph.microsoft.com/Mail.ReadWrite',
      'https://graph.microsoft.com/User.Read',
      'offline_access',
    ])
  })

  it('never mixes the Outlook IMAP scope into a Graph token request', () => {
    expect(MICROSOFT_GRAPH_TOKEN_SCOPE).not.toContain('outlook.office.com')
  })

  it('qualifies every scope against the Graph resource, not the Outlook REST one', () => {
    for (const scope of Object.values(GRAPH_SCOPE_FOR_OPERATION)) {
      expect(scope.startsWith('https://graph.microsoft.com/')).toBe(true)
    }
  })

  it('needs write permission only for marking read, so a read-only mailbox still lists mail', () => {
    expect(GRAPH_SCOPE_FOR_OPERATION.listMessages).toBe(GRAPH_MAIL_READ_SCOPE)
    expect(GRAPH_SCOPE_FOR_OPERATION.getMessage).toBe(GRAPH_MAIL_READ_SCOPE)
    expect(GRAPH_SCOPE_FOR_OPERATION.markRead).toBe(GRAPH_MAIL_READ_WRITE_SCOPE)
  })

  it('matches a granted scope case-insensitively because Microsoft echoes mixed case', () => {
    const granted = 'https://graph.microsoft.com/MAIL.read https://graph.microsoft.com/User.Read'
    expect(graphScopeGranted(granted, GRAPH_MAIL_READ_SCOPE)).toBe(true)
    expect(graphScopeGranted(granted, GRAPH_MAIL_READ_WRITE_SCOPE)).toBe(false)
  })

  it('treats an empty granted scope as unknown rather than denied', () => {
    expect(graphScopeGranted('', GRAPH_MAIL_READ_SCOPE)).toBe(true)
    expect(graphScopeGranted('   ', GRAPH_MAIL_READ_WRITE_SCOPE)).toBe(true)
  })
})
