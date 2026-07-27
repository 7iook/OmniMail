import type { Env, SessionUser } from './types'

interface SummaryRow {
  total_received: number
  period_received: number
  today_received: number
  unique_senders: number
}

interface DailyRow {
  day: number
  count: number
}

interface SourceDomainRow {
  domain: string
  count: number
}

interface SenderRow {
  address: string
  name: string | null
  count: number
}

export function normalizeStatisticsDays(value: string | null): 7 | 30 | 90 {
  const days = Number(value)
  return days === 7 || days === 90 ? days : 30
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function isAdministrator(user: SessionUser): boolean {
  return user.role === 'super_admin' || user.role === 'admin'
}

export async function mailStatistics(
  env: Env,
  user: SessionUser,
  request: Request,
): Promise<Response> {
  if (!isAdministrator(user)) return json({ error: '只有管理员可以查看全站统计。' }, 403)
  const days = normalizeStatisticsDays(new URL(request.url).searchParams.get('days'))
  const now = Math.floor(Date.now() / 1000)
  const today = Math.floor(now / 86400) * 86400
  const start = today - (days - 1) * 86400
  const sourceDomain = `CASE
    WHEN INSTR(sender_address, '@') > 0
    THEN LOWER(SUBSTR(sender_address, INSTR(sender_address, '@') + 1))
    ELSE '未知来源'
  END`

  const results = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS total_received,
              SUM(CASE WHEN received_at >= ? THEN 1 ELSE 0 END) AS period_received,
              SUM(CASE WHEN received_at >= ? THEN 1 ELSE 0 END) AS today_received,
              COUNT(DISTINCT CASE
                WHEN received_at >= ? THEN LOWER(sender_address)
              END) AS unique_senders
         FROM messages
        WHERE direction = 'incoming'`,
    ).bind(start, today, start),
    env.DB.prepare(
      `SELECT CAST(received_at / 86400 AS INTEGER) * 86400 AS day,
              COUNT(*) AS count
         FROM messages
        WHERE direction = 'incoming' AND received_at >= ?
        GROUP BY day
        ORDER BY day`,
    ).bind(start),
    env.DB.prepare(
      `SELECT ${sourceDomain} AS domain, COUNT(*) AS count
         FROM messages
        WHERE direction = 'incoming' AND received_at >= ?
        GROUP BY domain
        ORDER BY count DESC, domain
        LIMIT 8`,
    ).bind(start),
    env.DB.prepare(
      `SELECT LOWER(sender_address) AS address,
              MAX(NULLIF(sender_name, '')) AS name,
              COUNT(*) AS count
         FROM messages
        WHERE direction = 'incoming' AND received_at >= ?
        GROUP BY address
        ORDER BY count DESC, address
        LIMIT 8`,
    ).bind(start),
  ])

  const summary = (results[0].results[0] || {}) as unknown as Partial<SummaryRow>
  const dailyRows = results[1].results as unknown as DailyRow[]
  const dailyCounts = new Map(dailyRows.map((row) => [row.day, row.count]))
  const daily = Array.from({ length: days }, (_, index) => {
    const day = start + index * 86400
    return { day, count: dailyCounts.get(day) || 0 }
  })

  return json({
    days,
    generatedAt: now,
    summary: {
      totalReceived: Number(summary.total_received || 0),
      periodReceived: Number(summary.period_received || 0),
      todayReceived: Number(summary.today_received || 0),
      uniqueSenders: Number(summary.unique_senders || 0),
    },
    daily,
    sourceDomains: results[2].results as unknown as SourceDomainRow[],
    topSenders: results[3].results as unknown as SenderRow[],
  })
}
