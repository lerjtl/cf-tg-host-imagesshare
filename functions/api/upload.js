export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        // 检查是否是最终上传请求
        const isFinalUpload = request.headers.get('X-Final-Upload') === 'true';

        // 提前检查所有必要的环境变量，确保它们已被绑定和配置
        if (!env.TG_Bot_Token || !env.TG_Chat_ID || !env.CHUNKS || !env.img_url) {
            const missing = [];
            if (!env.TG_Bot_Token) missing.push('TG_Bot_Token');
            if (!env.TG_Chat_ID) missing.push('TG_Chat_ID');
            if (!env.CHUNKS) missing.push('CHUNKS KV binding');
            if (!env.img_url) missing.push('IMG_URL KV binding');
            const errorMessage = `Missing Cloudflare Pages environment variables/KV bindings: ${missing.join(', ')}. Please configure them in your Pages project settings.`;
            console.error('[onRequestPost - Environment Check]', errorMessage);
            throw new Error(errorMessage); // 直接抛出错误
        }

        if (isFinalUpload) {
            console.log('[onRequestPost - Final Upload] Received final upload request.');

            const fileId = request.headers.get('X-File-ID');
            const fileNameEncoded = request.headers.get('X-File-Name');
            const fileName = fileNameEncoded ? decodeURIComponent(fileNameEncoded) : 'unknown_file'; // Decode the filename
            const fileSize = parseInt(request.headers.get('X-File-Size') || '0', 10);
            const totalChunks = parseInt(request.headers.get('X-Total-Chunks') || '0', 10);

            if (!fileId || !fileName || !fileSize || isNaN(totalChunks)) {
                console.error('[onRequestPost - Final Upload] Missing or invalid final upload headers.', { fileId, fileName, fileSize, totalChunks });
                throw new Error('Missing or invalid final upload headers'); // 直接抛出错误
            }

            const fileParts = [];
            for (let i = 0; i < totalChunks; i++) {
                const chunkKey = `${fileId}_chunk_${i}`;
                const chunk = await env.CHUNKS.get(chunkKey, 'arrayBuffer');
                if (chunk) {
                    fileParts.push(chunk);
                } else {
                    console.error(`[onRequestPost - Final Upload] Missing chunk ${i} for file ${fileId}`);
                    throw new Error(`Missing chunk ${i} for file ${fileId}`); // 直接抛出错误
                }
            }

            console.log('[onRequestPost - Final Upload] Starting to merge ArrayBuffers for file:', fileName, '(', totalChunks, 'chunks)');
            const mergedBuffer = await mergeArrayBuffers(fileParts);
            console.log('[onRequestPost - Final Upload] Merged ArrayBuffers. Merged file size:', mergedBuffer.byteLength, 'bytes');
            // 确保 File 构造函数接收有效的 MIME 类型
            const mimeTypeFromHeader = request.headers.get('X-File-Mime-Type') || 'application/octet-stream';
            const file = new File([mergedBuffer], fileName, { type: mimeTypeFromHeader });
            console.log('[onRequestPost - Final Upload] Created File object:', { name: file.name, type: file.type, size: file.size });

            const ext = (fileName.includes('.') ? fileName.split('.').pop() : '').toLowerCase();
            const mime = file.type || '';
            const size = file.size;

            // 检查文件大小是否超过 Telegram 限制 (约 50MB)
            if (size > 50 * 1024 * 1024) {
                console.error('[onRequestPost - Final Upload] File size exceeds Telegram API direct upload limit (50MB):', size);
                throw new Error('File size exceeds Telegram API direct upload limit (50MB)'); // 直接抛出错误
            }

            const results = [];
            const mediaCandidates = [];
            const documents = [];

            const hardImageAsDoc = ['heic', 'heif', 'webp', 'ico'].includes(ext) || size > 5 * 1024 * 1024;
            if (mime.startsWith('image/')) {
                if (hardImageAsDoc) {
                    documents.push({ file: file, ext: ext || 'jpg', mime: mime });
                } else {
                    mediaCandidates.push({ file: file, kind: 'photo', ext, mime: mime });
                }
            } else if (mime.startsWith('video/')) {
                mediaCandidates.push({ file: file, kind: 'video', ext, mime: mime });
            } else {
                documents.push({ file: file, ext, mime: mime });
            }
            console.log('[onRequestPost - Final Upload] File classified:', { mediaCandidatesCount: mediaCandidates.length, documentsCount: documents.length });

            if (mediaCandidates.length === 1) {
                const { file: f, kind, ext, mime } = mediaCandidates[0];
                const fd = new FormData();
                fd.append('chat_id', env.TG_Chat_ID);
                const endpoint = kind === 'photo' ? 'sendPhoto' : 'sendVideo';
                const field = kind === 'photo' ? 'photo' : 'video';
                fd.append(field, f);

                const url = `https://api.telegram.org/bot${env.TG_Bot_Token}/${endpoint}`;
                console.log('[onRequestPost - Final Upload] Sending single media request to:', url);
                
                const data = await postToTelegram(url, fd, endpoint, 60000, 2);
                console.log('[onRequestPost - Final Upload] Telegram API response for single media:', JSON.stringify(data, null, 2));
                const idObj = getFileId(data);
                if (!idObj || !idObj.file_id) {
                    console.error('[onRequestPost - Final Upload] Failed to get file ID from Telegram response for single media.', { data });
                    throw new Error('Failed to get file ID');
                }
                results.push({ src: `/file/${idObj.file_id}.${ext}` });
                console.log('[onRequestPost - Final Upload] Calling putMeta for single media.', { fileId: idObj.file_id, ext, mime, thumbnailId: idObj.thumbnail_id });
                await putMeta(idObj.file_id, ext, mime, env, idObj.thumbnail_id);
                console.log('[onRequestPost - Final Upload] Single media upload successful. File ID:', idObj.file_id, 'Thumbnail ID:', idObj.thumbnail_id, 'Metadata saved.');
                
            } else if (mediaCandidates.length >= 2) {
                const batches = chunk(mediaCandidates, 10);
                for (const batch of batches) {
                    const fd = new FormData();
                    fd.append('chat_id', env.TG_Chat_ID);
                    const media = [];
                    batch.forEach((item, idx) => {
                        const attachName = `file${idx}`;
                        media.push({ type: item.kind, media: `attach://${attachName}` });
                        fd.append(attachName, item.file);
                    });
                    fd.append('media', JSON.stringify(media));

                    const url = `https://api.telegram.org/bot${env.TG_Bot_Token}/sendMediaGroup`;
                    console.log('[onRequestPost - Final Upload] Sending media group request to:', url);
                    
                    const data = await postToTelegram(url, fd, 'sendMediaGroup', 60000, 2);
                    console.log('[onRequestPost - Final Upload] Telegram API response for media group:', JSON.stringify(data, null, 2));
                    const idObjs = getFileIdsFromGroup(data); // Note: getFileIdsFromGroup now returns thumbnail IDs
                    if (!idObjs.length) {
                        console.error('[onRequestPost - Final Upload] Failed to get file IDs from Telegram response for media group.', { data });
                        throw new Error('Failed to get file IDs from media group');
                    }
                    for (let i = 0; i < idObjs.length; i++) {
                        const idObj = idObjs[i];
                        const ext = batch[i]?.ext || 'jpg';
                        const mime = batch[i]?.mime || '';
                        results.push({ src: `/file/${idObj.file_id}.${ext}` });
                        console.log('[onRequestPost - Final Upload] Calling putMeta for media group item.', { fileId: idObj.file_id, ext, mime, thumbnailId: idObj.thumbnail_id });
                        await putMeta(idObj.file_id, ext, mime, env, idObj.thumbnail_id);
                        console.log('[onRequestPost - Final Upload] Media group item uploaded. File ID:', idObj.file_id, 'Thumbnail ID:', idObj.thumbnail_id, 'Metadata saved.');
                    }
                    
                }
            }

            for (const doc of documents) {
                const fd = new FormData();
                fd.append('chat_id', env.TG_Chat_ID);
                fd.append('document', doc.file);
                const url = `https://api.telegram.org/bot${env.TG_Bot_Token}/sendDocument`;
                console.log('[onRequestPost - Final Upload] Sending document request to:', url);
                const data = await postToTelegram(url, fd, 'sendDocument', 60000, 2);
                console.log('[onRequestPost - Final Upload] Telegram API response for document:', JSON.stringify(data, null, 2));
                const idObj = getFileId(data);
                if (!idObj || !idObj.file_id) {
                    console.error('[onRequestPost - Final Upload] Failed to get file ID from Telegram response for document.', { data });
                    throw new Error('Failed to get file ID');
                }
                const ext = doc.ext || 'bin';
                results.push({ src: `/file/${idObj.file_id}.${ext}` });
                console.log('[onRequestPost - Final Upload] Calling putMeta for document.', { fileId: idObj.file_id, ext, mime: doc.mime, thumbnailId: idObj.thumbnail_id });
                await putMeta(idObj.file_id, ext, doc.mime || '', env, idObj.thumbnail_id);
                console.log('[onRequestPost - Final Upload] Document upload successful. File ID:', idObj.file_id, 'Thumbnail ID:', idObj.thumbnail_id, 'Metadata saved.');
            }

            // 清理 KV 存储中的块
            for (let i = 0; i < totalChunks; i++) {
                console.log(`[onRequestPost - Final Upload] Deleting chunk ${i} for file ${fileId}`);
                await env.CHUNKS.delete(`${fileId}_chunk_${i}`);
            }
            console.log('[onRequestPost - Final Upload] All chunks deleted from KV.');

            if (results.length === 0) {
                const errorMessage = 'No files were successfully uploaded to Telegram. Check Telegram API for errors.';
                console.error('[onRequestPost - Final Upload]', errorMessage);
                throw new Error(errorMessage); // Throw an error instead of returning 500 directly in this block
            }

            return new Response(
                JSON.stringify({ urls: results.map(r => r.src) }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                }
            );
        } else {
            // This is a chunk upload request (PUT method is handled by onRequestPut, this POST is for legacy or single-file non-chunked upload)
            // Given the frontend now uses chunked PUT and then a final POST, this 'else' block should ideally not be hit for file uploads.
            // However, we'll keep the original non-chunked POST logic for robustness if somehow a non-chunked POST comes through.
            console.log('[onRequestPost - Non-Final Upload] Received non-final upload request.');
            
            const clonedRequest = request.clone();
            const formData = await clonedRequest.formData();

            // 同时兼容单文件与多文件：读取所有名为 file 的表单域
            const files = formData.getAll('file') || [];
            if (!files.length) {
                console.error('[onRequestPost - Non-Final Upload] No file uploaded.');
                throw new Error('No file uploaded');
            }

            const results = [];

            // 将文件按类型拆分：图片 / 视频 作为媒体组候选；其他作为文档单发
            const mediaCandidates = []; // { file, kind: 'photo' | 'video', ext, mime }
            const documents = []; // { file, ext, mime }

            for (const f of files) {
                const name = f.name || 'file';
                const ext = (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
                const type = f.type || '';
                const size = typeof f.size === 'number' ? f.size : 0;
                // 对于 Telegram 容易处理失败的图片格式或较大的图片，直接走 document 提高成功率
                const hardImageAsDoc = ['heic', 'heif', 'webp', 'ico'].includes(ext) || size > 5 * 1024 * 1024; // >5MB 走 document
                if (type.startsWith('image/')) {
                    if (hardImageAsDoc) {
                        documents.push({ file: f, ext: ext || 'jpg', mime: type });
                    } else {
                        mediaCandidates.push({ file: f, kind: 'photo', ext, mime: type });
                    }
                }
                else if (type.startsWith('video/')) {
                    mediaCandidates.push({ file: f, kind: 'video', ext, mime: type });
                } else {
                    documents.push({ file: f, ext, mime: type });
                }
            }
            console.log('[onRequestPost - Non-Final Upload] File classified:', { mediaCandidatesCount: mediaCandidates.length, documentsCount: documents.length });

            // 处理媒体候选：
            // - 若仅 1 个媒体：分别用 sendPhoto / sendVideo
            // - 若 >= 2 个：按 10 个为一批使用 sendMediaGroup
            if (mediaCandidates.length === 1) {
                const { file, kind, ext, mime } = mediaCandidates[0];
                const fd = new FormData();
                fd.append('chat_id', env.TG_Chat_ID);
                const endpoint = kind === 'photo' ? 'sendPhoto' : 'sendVideo';
                const field = kind === 'photo' ? 'photo' : 'video';
                fd.append(field, file);

                const url = `https://api.telegram.org/bot${env.TG_Bot_Token}/${endpoint}`;
                console.log('[onRequestPost - Non-Final Upload] Sending single media request to:', url);
                
                const data = await postToTelegram(url, fd, endpoint, 60000, 2);
                console.log('[onRequestPost - Non-Final Upload] Telegram API response for single media:', JSON.stringify(data, null, 2));
                const idObj = getFileId(data);
                if (!idObj || !idObj.file_id) {
                    console.error('[onRequestPost - Non-Final Upload] Failed to get file ID from Telegram response for single media.', { data });
                    throw new Error('Failed to get file ID');
                }
                results.push({ src: `/file/${idObj.file_id}.${ext}` });
                console.log('[onRequestPost - Non-Final Upload] Calling putMeta for single media.', { fileId: idObj.file_id, ext, mime, thumbnailId: idObj.thumbnail_id });
                await putMeta(idObj.file_id, ext, mime, env, idObj.thumbnail_id);
                console.log('[onRequestPost - Non-Final Upload] Single media upload successful. File ID:', idObj.file_id, 'Thumbnail ID:', idObj.thumbnail_id, 'Metadata saved.');
                
            } else if (mediaCandidates.length >= 2) {
                const batches = chunk(mediaCandidates, 10);
                for (const batch of batches) {
                    const fd = new FormData();
                    fd.append('chat_id', env.TG_Chat_ID);
                    const media = [];
                    batch.forEach((item, idx) => {
                        const attachName = `file${idx}`;
                        media.push({ type: item.kind, media: `attach://${attachName}` });
                        fd.append(attachName, item.file);
                    });
                    fd.append('media', JSON.stringify(media));

                    const url = `https://api.telegram.org/bot${env.TG_Bot_Token}/sendMediaGroup`;
                    console.log('[onRequestPost - Non-Final Upload] Sending media group request to:', url);
                    
                    const data = await postToTelegram(url, fd, 'sendMediaGroup', 60000, 2);
                    console.log('[onRequestPost - Non-Final Upload] Telegram API response for media group:', JSON.stringify(data, null, 2));
                    const idObjs = getFileIdsFromGroup(data);
                    if (!idObjs.length) {
                        console.error('[onRequestPost - Non-Final Upload] Failed to get file IDs from Telegram response for media group.', { data });
                        throw new Error('Failed to get file IDs from media group');
                    }
                    for (let i = 0; i < idObjs.length; i++) {
                        const idObj = idObjs[i];
                        const ext = batch[i]?.ext || 'jpg';
                        const mime = batch[i]?.mime || '';
                        results.push({ src: `/file/${idObj.file_id}.${ext}` });
                        console.log('[onRequestPost - Non-Final Upload] Calling putMeta for media group item.', { fileId: idObj.file_id, ext, mime, thumbnailId: idObj.thumbnail_id });
                        await putMeta(idObj.file_id, ext, mime, env, idObj.thumbnail_id);
                        console.log('[onRequestPost - Non-Final Upload] Media group item uploaded. File ID:', idObj.file_id, 'Thumbnail ID:', idObj.thumbnail_id, 'Metadata saved.');
                    }
                    
                }
            }

            for (const doc of documents) {
                const fd = new FormData();
                fd.append('chat_id', env.TG_Chat_ID);
                fd.append('document', doc.file);
                const url = `https://api.telegram.org/bot${env.TG_Bot_Token}/sendDocument`;
                console.log('[onRequestPost - Final Upload] Sending document request to:', url);
                const data = await postToTelegram(url, fd, 'sendDocument', 60000, 2);
                console.log('[onRequestPost - Final Upload] Telegram API response for document:', JSON.stringify(data, null, 2));
                const idObj = getFileId(data);
                if (!idObj || !idObj.file_id) {
                    console.error('[onRequestPost - Final Upload] Failed to get file ID from Telegram response for document.', { data });
                    throw new Error('Failed to get file ID');
                }
                const ext = doc.ext || 'bin';
                results.push({ src: `/file/${idObj.file_id}.${ext}` });
                console.log('[onRequestPost - Final Upload] Calling putMeta for document.', { fileId: idObj.file_id, ext, mime: doc.mime, thumbnailId: idObj.thumbnail_id });
                await putMeta(idObj.file_id, ext, doc.mime || '', env, idObj.thumbnail_id);
                console.log('[onRequestPost - Final Upload] Document upload successful. File ID:', idObj.file_id, 'Thumbnail ID:', idObj.thumbnail_id, 'Metadata saved.');
            }

            // 统一返回 { urls: [...] }，便于前端批量解析
            return new Response(
                JSON.stringify({ urls: results.map(r => r.src) }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                }
            );
        }
    } catch (topLevelError) {
        console.error('[onRequestPost - Top Level Catch] Uncaught error:', topLevelError && topLevelError.message ? topLevelError.message : topLevelError);
        return new Response(
            JSON.stringify({ error: topLevelError && topLevelError.message ? topLevelError.message : 'An unexpected error occurred in the upload function.' }),
            {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

export async function onRequestPut(context) {
    const { request, env } = context;
    const fileId = request.headers.get('X-File-ID');
    const fileName = request.headers.get('X-File-Name');
    const fileSize = parseInt(request.headers.get('X-File-Size') || '0', 10);
    const chunkIndex = parseInt(request.headers.get('X-Chunk-Index') || '0', 10);
    const totalChunks = parseInt(request.headers.get('X-Total-Chunks') || '0', 10);

    if (!fileId || !fileName || !fileSize || isNaN(chunkIndex) || isNaN(totalChunks)) {
        return new Response(JSON.stringify({ error: 'Missing or invalid chunk headers' }), { status: 400 });
    }

    try {
        const chunkData = await request.arrayBuffer();
        const chunkKey = `${fileId}_chunk_${chunkIndex}`;
        await env.CHUNKS.put(chunkKey, chunkData);

        return new Response(JSON.stringify({ message: `Chunk ${chunkIndex}/${totalChunks} uploaded` }), { status: 200 });

    } catch (error) {
        console.error('Upload chunk error:', error);
        return new Response(
            JSON.stringify({ error: error.message }),
            {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

function getFileId(response) {
    if (!response.ok || !response.result) {
        console.error('getFileId: Invalid response:', response);
        return null;
    }

    const result = response.result;
    console.log('getFileId: Processing result:', JSON.stringify(result, null, 2));
    
    let fileId = null;
    let thumbnailId = null;

    if (result.photo) {
        // 对于照片，Telegram 会返回一个尺寸数组，选择最大的作为 file_id
        fileId = result.photo.reduce((prev, current) =>
            (prev.file_size > current.file_size) ? prev : current
        ).file_id;
        // 对于照片，Telegram 不会提供单独的 thumbnailId，通常前端会用较小尺寸的 photo 作为缩略图。
        // 为保持一致性，我们选择最小的尺寸作为 thumbnailId。
        thumbnailId = result.photo.reduce((prev, current) =>
            (prev.file_size < current.file_size) ? prev : current
        ).file_id; // Use smallest photo as thumbnail ID
        console.log('getFileId: Found photo file_id:', fileId, 'thumbnailId:', thumbnailId);
    }
    if (result.document) {
        fileId = result.document.file_id;
        console.log('getFileId: Found document file_id:', fileId);
        // 确保 thumbnail 存在且有 file_id
        if (result.document.thumbnail && result.document.thumbnail.file_id) {
            thumbnailId = result.document.thumbnail.file_id;
            console.log('getFileId: Found document thumbnail_id:', thumbnailId);
        }
    }
    if (result.video) {
        fileId = result.video.file_id;
        console.log('getFileId: Found video file_id:', fileId);
        // 确保 thumbnail 存在且有 file_id
        if (result.video.thumbnail && result.video.thumbnail.file_id) {
            thumbnailId = result.video.thumbnail.file_id;
            console.log('getFileId: Found video thumbnail_id:', thumbnailId);
        }
    }
    if (result.sticker) {
        fileId = result.sticker.file_id;
        console.log('getFileId: Found sticker file_id:', fileId);
        // Sticker 也可以有缩略图
        if (result.sticker.thumbnail && result.sticker.thumbnail.file_id) {
            thumbnailId = result.sticker.thumbnail.file_id;
            console.log('getFileId: Found sticker thumbnail_id:', thumbnailId);
        }
    }

    if (!fileId) {
        console.error('getFileId: No file_id found in result. Available keys:', Object.keys(result));
        return null;
    }
    return { file_id: fileId, thumbnail_id: thumbnailId };
}

// 从 sendMediaGroup 返回结果中提取每个消息的文件 id（保持顺序）
function getFileIdsFromGroup(response) {
    if (!response.ok || !Array.isArray(response.result)) return [];
    const ids = [];
    for (const msg of response.result) {
        let fileId = null;
        let thumbnailId = null;
        if (msg.photo && Array.isArray(msg.photo) && msg.photo.length) {
            const best = msg.photo.reduce((prev, current) => (prev.file_size > current.file_size) ? prev : current);
            fileId = best.file_id;
            // For photos, Telegram might not return a distinct thumbnail. Use the smallest photo as thumbnail if needed, or null.
            const smallestPhoto = msg.photo.reduce((prev, current) => (prev.file_size < current.file_size) ? prev : current);
            thumbnailId = smallestPhoto.file_id; // Using smallest photo as thumbnail ID
        } else if (msg.video && msg.video.file_id) {
            fileId = msg.video.file_id;
            // 确保 thumbnail 存在且有 file_id
            if (msg.video.thumbnail && msg.video.thumbnail.file_id) {
                thumbnailId = msg.video.thumbnail.file_id;
            }
        } else if (msg.document && msg.document.file_id) {
            fileId = msg.document.file_id;
            // 确保 thumbnail 存在且有 file_id
            if (msg.document.thumbnail && msg.document.thumbnail.file_id) {
                thumbnailId = msg.document.thumbnail.file_id;
            }
        } else if (msg.sticker && msg.sticker.file_id) {
            fileId = msg.sticker.file_id;
            // Sticker 也可以有缩略图
            if (msg.sticker.thumbnail && msg.sticker.thumbnail.file_id) {
                thumbnailId = msg.sticker.thumbnail.file_id;
            }
        }
        if (fileId) {
            ids.push({ file_id: fileId, thumbnail_id: thumbnailId });
        }
    }
    return ids;
}

// 简单分块工具
function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) {
        out.push(arr.slice(i, i + size));
    }
    return out;
}

// 为外部请求增加超时控制（默认 60s）
async function fetchWithTimeout(url, options = {}, timeoutMs = 60000, label = 'request') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(url, { ...options, signal: controller.signal });
        return resp;
    } catch (err) {
        if (err && (err.name === 'AbortError' || err.message?.includes('The operation was aborted'))) {
            console.error(`[timeout] ${label} 超时（>${timeoutMs}ms）`);
            throw new Error(`${label} 超时，请稍后重试`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// 针对 Telegram 请求的重试封装（指数退避）
async function postToTelegram(url, formData, label, timeoutMs = 60000, retries = 2) {
    let attempt = 0;
    let delay = 600; // 首次退避 600ms
    while (true) {
        try {
            const resp = await fetchWithTimeout(url, { method: 'POST', body: formData }, timeoutMs, label);
            const data = await resp.json();
            if (resp.ok && data.ok) return data; // Check both HTTP status and Telegram API response 'ok' field
            if (!data.ok) {
                console.error('Telegram API response data.ok is false:', data);
                throw new Error(data.description || 'Telegram API error: ' + JSON.stringify(data));
            }
            // 仅对 5xx/429/503 进行重试
            if (attempt < retries && (resp.status >= 500 || resp.status === 429 || resp.status === 503)) {
                console.warn(`[retry] ${label} 响应 ${resp.status}，${delay}ms 后重试（第 ${attempt + 1} 次）`);
                await new Promise(r => setTimeout(r, delay));
                attempt += 1;
                delay *= 2;
                continue;
            }
            console.error('Error response from Telegram API:', data);
            throw new Error(data.description || 'Upload to Telegram failed');
        } catch (err) {
            // 对超时/网络错误重试
            const msg = String(err && err.message ? err.message : err);
            if (attempt < retries && (msg.includes('超时') || msg.includes('network') || msg.includes('aborted') || msg.includes('503'))) {
                console.warn(`[retry] ${label} ${msg}，${delay}ms 后重试（第 ${attempt + 1} 次）`);
                await new Promise(r => setTimeout(r, delay));
                attempt += 1;
                delay *= 2;
                continue;
            }
            throw err;
        }
    }
}

// 合并多个 ArrayBuffer 为一个
async function mergeArrayBuffers(buffers) {
    let totalLength = 0;
    for (const buffer of buffers) {
        totalLength += buffer.byteLength;
    }
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const buffer of buffers) {
        result.set(new Uint8Array(buffer), offset);
        offset += buffer.byteLength;
    }
    return result.buffer;
}


// 写入最小 KV 元数据，便于管理后台读取
async function putMeta(fileId, ext, mime, env, thumbnailId = null) {
    try {
        if (!env || !env.img_url) {
            throw new Error('KV binding env.img_url is not available. Cannot store metadata.');
        }
        const value = JSON.stringify({ mime, thumbnailId });
        const metadata = {
            TimeStamp: Date.now(),
        };
        // 直接使用 fileId.ext 作为键保存元数据
        const key = ext ? `${fileId}.${ext}` : fileId;
        await env.img_url.put(key, value, { metadata });
        console.log(`KV put successful for key: ${key}, thumbnailId: ${thumbnailId}`);
    } catch (e) {
        // 记录具体的 KV put 错误
        console.error('KV put error:', e && e.message ? e.message : e, 'for key:', fileId);
        throw e; // Re-throw the error to ensure it's caught by onRequestPost's outer catch
    }
}

// 根据文件名获取 MIME 类型
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
