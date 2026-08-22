import { writeAudit } from './audit'
import { ImapConnectionError } from './imap-errors'
import { linuxDoMailCredentialsReady } from './linux-do-mail-credentials'
import type { LinuxDoMailImapClient } from './linux-do-mail-imap'
import {
  LinuxDoMailAccountStore,
  LinuxDoMailStoreError,
  publicLinuxDoMailAccount,
} from './linux-do-mail-store'
import type { LinuxDoMailAccount } from './linux-do-mail-types'
import type { Env, SessionUser } from './types'

function responseError(error: unknown): Response {
  if (error instanceof LinuxDoMailStoreError || error instanceof ImapConnectionError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  console.error('Linux DO Mail request failed', {
    message: error instanceof Error ? error.message : String(error),
  })
  return Response.json({ error: 'Linux DO Mail 暂时无法处理这个请求。' }, { status: 500 })
}

function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  })
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json<unknown>()
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error()
    return body as Record<string, unknown>
  } catch {
    throw new LinuxDoMailStoreError(400, '请求体必须是 JSON 对象。')
  }
}

function usernameField(value: unknown): string {
  const username = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!/^[^@\s]{1,64}@linux\.do$/.test(username) || username.length > 254) {
    throw new LinuxDoMailStoreError(400, '请填写完整的 @linux.do 邮箱地址。')
  }
  return username
}

function passwordField(value: unknown): string {
  const password = typeof value === 'string' ? value : ''
  if (!password || password.length > 512 || /[\r\n\0]/.test(password)) {
    throw new LinuxDoMailStoreError(400, '请填写有效的密码或认证令牌。')
  }
  return password
}

async function validateCredentials(username: string, password: string): Promise<void> {
  const client = await imapClient(username, password)
  try {
    await client.open()
    await client.test()
  } finally {
    await client.close()
  }
}

async function imapClient(username: string, password: string): Promise<LinuxDoMailImapClient> {
  const { LinuxDoMailImapClient } = await import('./linux-do-mail-imap')
  return new LinuxDoMailImapClient(username, password)
}

async function recordFailure(
  store: LinuxDoMailAccountStore,
  accountId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : 'IMAP 读取失败。'
  try { await store.recordValidation(accountId, message) } catch { /* preserve remote error */ }
}

export async function getLinuxDoMailAccount(env: Env, user: SessionUser): Promise<Response> {
  try {
    const enabled = linuxDoMailCredentialsReady(env)
    const account = enabled
      ? await new LinuxDoMailAccountStore(env, user.id).publicAccount()
      : null
    return privateJson({ enabled, account })
  } catch (error) {
    return responseError(error)
  }
}

export async function createLinuxDoMailAccount(
  env: Env,
  user: SessionUser,
  request: Request,
  ip: string,
): Promise<Response> {
  try {
    const body = await jsonBody(request)
    const username = usernameField(body.username)
    const password = passwordField(body.password)
    const store = new LinuxDoMailAccountStore(env, user.id)
    if (await store.publicAccount()) {
      throw new LinuxDoMailStoreError(409, '每个用户只能连接一个 Linux DO Mail 账号。')
    }
    await validateCredentials(username, password)
    const now = new Date().toISOString()
    const account: LinuxDoMailAccount = {
      id: `linuxdo_mail_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`,
      userId: user.id,
      username,
      password,
      status: 'active',
      lastValidated: now,
      lastError: '',
      createdAt: now,
    }
    await store.insert(account)
    await writeAudit(env, user.id, 'linuxdo_mail.account.connect', account.id, ip, { username })
    return privateJson({ account: publicLinuxDoMailAccount(account) }, 201)
  } catch (error) {
    return responseError(error)
  }
}

export async function deleteLinuxDoMailAccount(
  env: Env,
  user: SessionUser,
  ip: string,
): Promise<Response> {
  try {
    const store = new LinuxDoMailAccountStore(env, user.id)
    const account = await store.remove()
    await writeAudit(env, user.id, 'linuxdo_mail.account.disconnect', account.id, ip, {
      username: account.username,
    })
    return privateJson({ ok: true })
  } catch (error) {
    return responseError(error)
  }
}

export async function verifyLinuxDoMailAccount(
  env: Env,
  user: SessionUser,
  ip: string,
): Promise<Response> {
  try {
    const store = new LinuxDoMailAccountStore(env, user.id)
    const account = await store.get()
    try {
      await validateCredentials(account.username, account.password)
      await store.recordValidation(account.id)
    } catch (error) {
      await recordFailure(store, account.id, error)
      throw error
    }
    await writeAudit(env, user.id, 'linuxdo_mail.account.verify', account.id, ip, {
      username: account.username,
    })
    return privateJson({ ok: true, validatedAt: new Date().toISOString() })
  } catch (error) {
    return responseError(error)
  }
}

export async function updateLinuxDoMailCredential(
  env: Env,
  user: SessionUser,
  request: Request,
  ip: string,
): Promise<Response> {
  try {
    const password = passwordField((await jsonBody(request)).password)
    const store = new LinuxDoMailAccountStore(env, user.id)
    const account = await store.publicAccount()
    if (!account) throw new LinuxDoMailStoreError(404, '尚未连接 Linux DO Mail 账号。')
    await validateCredentials(account.username, password)
    const validatedAt = new Date().toISOString()
    await store.replacePassword(account.id, password, validatedAt)
    await writeAudit(env, user.id, 'linuxdo_mail.account.credential_update', account.id, ip, {
      username: account.username,
    })
    return privateJson({
      account: {
        ...account,
        status: 'active',
        lastValidated: validatedAt,
        lastError: '',
      },
    })
  } catch (error) {
    return responseError(error)
  }
}

export async function listLinuxDoMailInbox(env: Env, user: SessionUser): Promise<Response> {
  let client: LinuxDoMailImapClient | undefined
  try {
    const store = new LinuxDoMailAccountStore(env, user.id)
    const account = await store.get()
    client = await imapClient(account.username, account.password)
    try {
      await client.open()
      const messages = await client.listInbox(20)
      await store.recordValidation(account.id)
      return privateJson({ messages })
    } catch (error) {
      await recordFailure(store, account.id, error)
      throw error
    }
  } catch (error) {
    return responseError(error)
  } finally {
    await client?.close()
  }
}

export async function getLinuxDoMailMessage(
  env: Env,
  user: SessionUser,
  uid: string,
): Promise<Response> {
  let client: LinuxDoMailImapClient | undefined
  try {
    if (!/^\d+$/.test(uid) || Number(uid) < 1) {
      throw new LinuxDoMailStoreError(400, '邮件 UID 无效。')
    }
    const store = new LinuxDoMailAccountStore(env, user.id)
    const account = await store.get()
    client = await imapClient(account.username, account.password)
    try {
      await client.open()
      return privateJson({ message: await client.getMessage(uid) })
    } catch (error) {
      await recordFailure(store, account.id, error)
      throw error
    }
  } catch (error) {
    return responseError(error)
  } finally {
    await client?.close()
  }
}
