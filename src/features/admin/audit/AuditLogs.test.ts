import { describe, expect, it } from 'vitest'
import type { AuditLog } from '../../../shared/api'
import { actionCategory, auditActionLabel, detailText, targetName } from './AuditLogs'

function log(detail: Record<string, unknown>): AuditLog {
  return {
    id: 1,
    actor: null,
    action: 'icloud.alias.create',
    targetId: 'icloud_account_id',
    target: null,
    ip: '192.0.2.1',
    detail,
    createdAt: 1,
  }
}

describe('iCloud audit log presentation', () => {
  it('uses readable action and category labels', () => {
    expect(auditActionLabel('icloud.alias.create')).toBe('已创建 iCloud 隐藏邮箱')
    expect(actionCategory('icloud.alias.create')).toBe('iCloud')
  })

  it('shows the account name and alias details instead of only an internal id', () => {
    const entry = log({
      accountName: 'Personal iCloud',
      alias: 'shop@icloud.com',
      label: 'Shopping',
    })

    expect(targetName(entry)).toBe('Personal iCloud')
    expect(detailText(entry)).toBe('shop@icloud.com · 用途：Shopping')
  })
})
