export async function onRequestPost(context) {
  const { env } = context;

  try {
    // 清空 img_url KV 命名空间
    let list_complete = false;
    let cursor = undefined;
    while (!list_complete) {
      const listResult = await env.img_url.list({ cursor });
      for (const key of listResult.keys) {
        await env.img_url.delete(key.name);
      }
      list_complete = listResult.list_complete;
      cursor = listResult.cursor;
    }
    console.log('Cleared img_url KV namespace.');

    // 清空 CHUNKS KV 命名空间
    list_complete = false;
    cursor = undefined;
    while (!list_complete) {
      const listResult = await env.CHUNKS.list({ cursor });
      for (const key of listResult.keys) {
        await env.CHUNKS.delete(key.name);
      }
      list_complete = listResult.list_complete;
      cursor = listResult.cursor;
    }
    console.log('Cleared CHUNKS KV namespace.');

    return new Response(JSON.stringify({ message: 'All data cleared successfully.' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error clearing KV namespaces:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
