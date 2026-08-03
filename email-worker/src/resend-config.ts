import type { Env } from './types'

export type ResendConfig = {
  apiKey: string
  from?: string
}

function domainConfigs(env: Env): Map<string, ResendConfig> {
  const raw = env.RESEND_DOMAIN_CONFIGS?.trim()
  if (!raw) return new Map()
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map()
    const configs = new Map<string, ResendConfig>()
    for (const [domain, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const normalizedDomain = domain.trim().toLowerCase()
      const candidate = value as { apiKey?: unknown; from?: unknown }
      const apiKey = typeof candidate.apiKey === 'string' ? candidate.apiKey.trim() : ''
      const from = typeof candidate.from === 'string' ? candidate.from.trim() : ''
      if (normalizedDomain && apiKey) {
        configs.set(normalizedDomain, { apiKey, from: from || undefined })
      }
    }
    return configs
  } catch {
    return new Map()
  }
}

export function resendConfigForAddress(env: Env, address: string): ResendConfig | null {
  const separator = address.lastIndexOf('@')
  if (separator <= 0) return null
  const domain = address.slice(separator + 1).trim().toLowerCase()
  const domainConfig = domainConfigs(env).get(domain)
  if (domainConfig) return domainConfig
  const apiKey = env.RESEND_API_KEY?.trim()
  if (!apiKey) return null
  const from = env.RESEND_FROM?.trim()
  return { apiKey, from: from || undefined }
}

export function hasResendConfig(env: Env): boolean {
  return Boolean(env.RESEND_API_KEY?.trim()) || domainConfigs(env).size > 0
}
