import type {
  AppConfig,
  ManagedDomain,
  MailboxAddress,
  MailCounts,
  MessageDetail,
  MessageSummary,
  PageInfo,
  User,
} from '../../src/lib/api-types'

export interface AuthStatus {
  apiOrigin: string
  authenticated: boolean
  user: User | null
}

export interface InboxResult {
  unchanged: boolean
  version: number
  messages: MessageSummary[]
  counts: MailCounts
  page: PageInfo
}

export type ExtensionRequest =
  | { type: 'auth:status' }
  | { type: 'auth:authorize'; apiOrigin: string }
  | { type: 'auth:logout' }
  | { type: 'api:config' }
  | { type: 'api:mailboxes' }
  | { type: 'api:domains' }
  | { type: 'api:messages'; mailbox?: string }
  | { type: 'api:message'; id: string }
  | { type: 'api:create-mailbox'; address: string }
  | { type: 'api:mark-read'; id: string }
  | { type: 'page:fill-email'; email: string }
  | { type: 'settings:set-floating'; enabled: boolean }
  | { type: 'settings:get' }

export interface ExtensionSettings {
  floatingEnabled: boolean
}

export type ExtensionResponse =
  | AuthStatus
  | AppConfig
  | ExtensionSettings
  | InboxResult
  | { mailboxes: MailboxAddress[] }
  | { domains: ManagedDomain[] }
  | { message: MessageDetail; thread: MessageSummary[] }
  | { mailbox: MailboxAddress }
  | { ok: true }

export function sendExtensionMessage<T extends ExtensionResponse>(
  request: ExtensionRequest,
): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(request, (response: T | { error?: string } | undefined) => {
      const runtimeError = chrome.runtime.lastError
      if (runtimeError) {
        reject(new Error(runtimeError.message))
        return
      }
      if (!response || ('error' in response && response.error)) {
        reject(new Error(response?.error || '扩展后台没有响应。'))
        return
      }
      resolve(response as T)
    })
  })
}
