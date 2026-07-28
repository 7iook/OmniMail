const MAX_REMOTE_IMAGE_BYTES = 5 * 1024 * 1024

export function safeRemoteImageUrl(value: string | null): URL | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:'
      || url.hostname !== 'claude.ai'
      || url.port !== ''
      || url.username !== ''
      || url.password !== ''
      || url.pathname !== '/images/claude_logo_full.png'
    ) return null
    return url
  } catch {
    return null
  }
}

export async function proxyRemoteImage(request: Request): Promise<Response> {
  const source = safeRemoteImageUrl(new URL(request.url).searchParams.get('url'))
  if (!source) return Response.json({ error: '图片地址不允许代理。' }, { status: 400 })

  let upstream: Response
  try {
    upstream = await fetch(source, {
      headers: { Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' },
      redirect: 'manual',
    })
  } catch {
    return Response.json({ error: '图片加载失败。' }, { status: 502 })
  }
  if (!upstream.ok) return Response.json({ error: '图片加载失败。' }, { status: 502 })

  const contentType = upstream.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
  const contentLength = Number(upstream.headers.get('Content-Length'))
  if (!contentType?.startsWith('image/')) {
    return Response.json({ error: '返回内容不是图片。' }, { status: 415 })
  }
  if (Number.isFinite(contentLength) && contentLength > MAX_REMOTE_IMAGE_BYTES) {
    return Response.json({ error: '图片过大。' }, { status: 413 })
  }

  return new Response(upstream.body, {
    headers: {
      'Cache-Control': 'private, max-age=86400',
      'Content-Type': contentType,
    },
  })
}
