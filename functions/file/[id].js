export async function onRequest(context) {
  const { request, env, params } = context;

  const url = new URL(request.url);
  let fileUrl = "https://telegra.ph/" + url.pathname + url.search;
  // 提取 Telegram file_id（不带扩展名）
  const parts = url.pathname.split(".");
  const fileIdWithExt = parts[0].split("/").pop();
  const fileId = fileIdWithExt.includes('.') ? fileIdWithExt.split('.')[0] : fileIdWithExt;
  const requestedExt = parts.length > 1 ? parts.pop() : '';
  // 防盗链（严格）：必须携带本站或白名单 Referer；否则 403，并禁止缓存
  const referer = request.headers.get("Referer");
  const allowed = new Set([
    url.origin,
    ...String(env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  ]);
  let allowedReferer = env.ALLOWED_REFERER;
  if (referer || allowedReferer) {
    try {
      const r = new URL(referer);
      // 本地开发域名直接放行
      if (r.hostname === 'localhost' || r.hostname === '127.0.0.1') {
        allowedReferer = true;
      } else if (allowed.has(r.origin)) {
        allowedReferer = true;
      }
    } catch {}
  }
  if (!allowedReferer) {
    return new Response("Hotlink forbidden", {
      status: 403,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8"
      }
    });
  }

  let finalFileId = fileId;
  let contentType = "application/octet-stream";
  let downloadFilename = fileIdWithExt;
  let fetchedFileUrl = null; // 用于存储最终要获取的文件 URL
  let thumbnailId = null; // Initialize thumbnailId here

  if (env.img_url && fileId) {
    const kvKey = params.id; // The key is already fileId.ext
    console.log('functions/file/[id].js: Looking up KV key:', kvKey);
    const record = await env.img_url.getWithMetadata(kvKey);

    if (record && record.metadata) {
      const metadata = record.metadata;
      console.log('functions/file/[id].js: Found KV metadata:', metadata);
      const { mime, thumbnailId: storedThumbnailId } = metadata;
      contentType = mime || contentType;
      downloadFilename = `${fileId}.${requestedExt || mimeToExt(mime)}`;
      thumbnailId = storedThumbnailId; // Assign stored thumbnailId

      // 如果请求的是缩略图，并且存在 thumbnailId
      if (url.searchParams.get('thumbnail') === 'true' && thumbnailId) {
        finalFileId = thumbnailId;
        contentType = 'image/jpeg'; // Thumbnails are always JPEG
        downloadFilename = `${thumbnailId}.jpeg`;
        fetchedFileUrl = null; // Force fetch from Telegram for thumbnail
        console.log('functions/file/[id].js: Serving thumbnail for file ID:', finalFileId);
      } else {
        console.log('functions/file/[id].js: Not serving thumbnail or no thumbnail ID.');
      }
    } else {
      console.warn('functions/file/[id].js: KV record or metadata not found for key:', kvKey);
    }
  }

  // 总是从 Telegram API 获取文件路径
  if (!fetchedFileUrl) {
      console.log('functions/file/[id].js: Attempting to get file path from Telegram for finalFileId:', finalFileId);
      const filePath = await getFilePath(env, finalFileId);
      console.log('functions/file/[id].js: Telegram file path:', filePath);
      if (!filePath) {
          console.error('functions/file/[id].js: File path not found from Telegram for ID:', finalFileId);
          return new Response("File not found", { status: 404 });
      }
      fetchedFileUrl = `https://api.telegram.org/file/bot${env.TG_Bot_Token}/${filePath}`;
      console.log('functions/file/[id].js: Constructed Telegram file URL:', fetchedFileUrl);
  }

  const response = await fetch(fetchedFileUrl, {
    method: request.method,
    headers: request.headers,
    body: request.body
  });

  // Log response details
  console.log(response.ok, response.status);

  // If the response is OK, proceed with further checks
  if (response.ok) {
    const headers = new Headers(response.headers);
    // 移除可能存在的 Content-Disposition 头，确保我们能完全控制它
    headers.delete("Content-Disposition");
    // 强制浏览器内联预览而不是下载
    headers.set("Content-Disposition", `inline; filename="${downloadFilename}"`);
    headers.set("Content-Type", contentType);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }

  return response;
}

async function getFilePath(env, file_id) {
  try {
    const url = `https://api.telegram.org/bot${env.TG_Bot_Token}/getFile?file_id=${file_id}`;
    const res = await fetch(url, {
      method: "GET"
    });

    if (!res.ok) {
      console.error(`HTTP error! status: ${res.status}`);
      return null;
    }

    const responseData = await res.json();
    const { ok, result } = responseData;

    if (ok && result) {
      return result.file_path;
    } else {
      console.error("Error in response data:", responseData);
      return null;
    }
  } catch (error) {
    console.error("Error fetching file path:", error.message);
    return null;
  }
}

// 辅助函数：根据 MIME 类型推断扩展名
function mimeToExt(mime) {
    if (!mime) return '';
    if (mime.startsWith('image/')) return mime.split('/')[1] || 'jpg';
    if (mime.startsWith('video/')) return mime.split('/')[1] || 'mp4';
    if (mime.startsWith('audio/')) return mime.split('/')[1] || 'mp3';
    if (mime.startsWith('application/pdf')) return 'pdf';
    return '';
}

// 辅助函数：根据文件名推断 MIME 类型
function getMimeTypeFromFileName(fileName) {
    const ext = (fileName.includes('.') ? fileName.split('.').pop() : '').toLowerCase();
    switch (ext) {
        case 'jpg':
        case 'jpeg': return 'image/jpeg';
        case 'png': return 'image/png';
        case 'gif': return 'image/gif';
        case 'mp4': return 'video/mp4';
        case 'mov': return 'video/quicktime';
        case 'webm': return 'video/webm';
        case 'pdf': return 'application/pdf';
        case 'zip': return 'application/zip';
        case 'txt': return 'text/plain';
        default: return null;
    }
}
