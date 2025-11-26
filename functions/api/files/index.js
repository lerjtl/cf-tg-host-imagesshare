export async function onRequest(context) {
  const { request, env } = context
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const url = new URL(request.url)
  const limitParam = parseInt(url.searchParams.get('limit') || '10', 10)
  const limit = Number.isFinite(limitParam) && limitParam > 0 && limitParam <= 1000 ? limitParam : 100
  const cursor = url.searchParams.get('cursor') || undefined

  if (!env.img_url) {
    return new Response(JSON.stringify({ error: 'KV binding img_url not found' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }

  const result = await env.img_url.list({ limit, cursor })
  const keys = result.keys || []

  const fileList = await Promise.all(keys.map(async (key) => {
    const { name, metadata } = key;
    const { mime, thumbnailId } = metadata || {};
    return { id: name, mime, thumbnailId };
  }));

  const body = JSON.stringify({
    keys: fileList,
    list_complete: result.list_complete === true,
    cursor: result.cursor || null,
  })

  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
}
