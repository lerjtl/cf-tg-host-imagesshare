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

  if (env.img_url && fileId) {
    const kvKey = fileIdWithExt;
    const record = await env.img_url.getWithMetadata(kvKey);

    if (record && record.metadata) {
      const metadata = record.metadata as any;
      const { mime, thumbnailId } = metadata;
      contentType = mime || contentType;
      downloadFilename = `${fileId}.${requestedExt || mimeToExt(mime)}`;

      // 如果请求的是缩略图，并且存在 thumbnailId
      if (url.searchParams.get('thumbnail') === 'true' && thumbnailId) {
        finalFileId = thumbnailId;
        // 尝试推断缩略图的 MIME 类型，默认为 image/jpeg
        contentType = 'image/jpeg';
        downloadFilename = `${thumbnailId}.jpeg`;
      } else if (requestedExt) {
        // 如果请求的扩展名与 KV 中存储的扩展名不符，则更新 mime 类型
        const extFromMime = mimeToExt(mime);
        if (requestedExt.toLowerCase() !== extFromMime.toLowerCase()) {
            contentType = getMimeTypeFromFileName(requestedExt) || contentType;
        }
      }
    } else {
      // 如果 KV 中没有元数据，尝试根据请求的扩展名设置 Content-Type
      contentType = getMimeTypeFromFileName(requestedExt) || contentType;
    }
  }

  const filePath = await getFilePath(env, finalFileId);
  if (!filePath) {
    return new Response("File not found", { status: 404 });
  }
  fileUrl = `https://api.telegram.org/file/bot${env.TG_Bot_Token}/${filePath}`;

  const response = await fetch(fileUrl, {
    method: request.method,
    headers: request.headers,
    body: request.body
  });

  // Log response details
  console.log(response.ok, response.status);

  // If the response is OK, proceed with further checks
  if (response.ok) {
    const headers = new Headers(response.headers);
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
