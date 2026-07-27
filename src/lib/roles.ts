import type { UserRole } from './api'

export function isAdminRole(role: UserRole): boolean {
  return role === 'super_admin' || role === 'admin'
}

export function roleLabel(role: UserRole): string {
  const labels: Record<UserRole, string> = {
    super_admin: '主管理员',
    admin: '管理员',
    user: '普通用户',
    temporary: '临时用户',
  }
  return labels[role]
}
