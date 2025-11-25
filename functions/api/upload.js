export async function onRequestPost(context) {
    const { request, env } = context;

    try {

        const clonedRequest = request.clone();
        const formData = await clonedRequest.formData();

        // 同时兼容单文件与多文件：读取所有名为 file 的表单域
        const files = formData.getAll('file') || [];
        if (!files.length) {
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
            } else if (type.startsWith('video/')) {
                mediaCandidates.push({ file: f, kind: 'video', ext, mime: type });
            } else {
                documents.push({ file: f, ext, mime: type });
            }
        }

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
            console.log('Sending request to:', url);
            try {
                const data = await postToTelegram(url, fd, endpoint, 60000, 2);
                const id = getFileId(data);
                if (!id) throw new Error('Failed to get file ID');
                results.push({ src: `/file/${id}.${ext}` });
                await putMeta(id, ext, mime, env);
            } catch (e) {
                const msg = String(e && e.message ? e.message : e);
                // 单媒体失败时，对图片回退为 document 再试
                if (kind === 'photo' && msg.includes('IMAGE_PROCESS_FAILED')) {
                    const fd2 = new FormData();
                    fd2.append('chat_id', env.TG_Chat_ID);
                    fd2.append('document', file);
                    const url2 = `https://api.telegram.org/bot${env.TG_Bot_Token}/sendDocument`;
                    console.warn('sendPhoto 失败，回退 sendDocument:', msg);
                    const data2 = await postToTelegram(url2, fd2, 'sendDocument', 60000, 2);
                    const id2 = getFileId(data2);
                    if (!id2) throw new Error('Failed to get file ID');
                    results.push({ src: `/file/${id2}.${ext || 'jpg'}` });
                    await putMeta(id2, ext || 'jpg', mime, env);
                } else {
                    throw e;
                }
            }
        } else if (mediaCandidates.length >= 2) {
            // 按批次（最多 10 个）调用 sendMediaGroup
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
                console.log('Sending request to:', url);
                try {
                    const data = await postToTelegram(url, fd, 'sendMediaGroup', 60000, 2);
                    const ids = getFileIdsFromGroup(data);
                    if (!ids.length) throw new Error('Failed to get file IDs from media group');
                    // 将批次内的 id 与各自扩展名对应，顺序与 batch 一致
                    for (let i = 0; i < ids.length; i++) {
                        const id = ids[i];
                        const ext = batch[i]?.ext || 'jpg';
                        const mime = batch[i]?.mime || '';
                        results.push({ src: `/file/${id}.${ext}` });
                        await putMeta(id, ext, mime, env);
                    }
                } catch (e) {
                    const msg = String(e && e.message ? e.message : e);
                    // 若相册发送出现 IMAGE_PROCESS_FAILED，则逐个回退为 document 发送
                    if (msg.includes('IMAGE_PROCESS_FAILED')) {
                        console.warn('sendMediaGroup 失败，改为逐个 sendDocument:', msg);
                        for (const it of batch) {
                            const fd2 = new FormData();
                            fd2.append('chat_id', env.TG_Chat_ID);
                            fd2.append('document', it.file);
                            const url2 = `https://api.telegram.org/bot${env.TG_Bot_Token}/sendDocument`;
                            const data2 = await postToTelegram(url2, fd2, 'sendDocument', 60000, 2);
                            const id2 = getFileId(data2);
                            if (!id2) throw new Error('Failed to get file ID');
                            const ext2 = it.ext || 'jpg';
                            results.push({ src: `/file/${id2}.${ext2}` });
                            await putMeta(id2, ext2, it.mime || '', env);
                        }
                    } else {
                        throw e;
                    }
                }
            }
        }

        // 非媒体（或不在相册里的）作为 document 单独发送
        for (const doc of documents) {
            const fd = new FormData();
            fd.append('chat_id', env.TG_Chat_ID);
            fd.append('document', doc.file);
            const url = `https://api.telegram.org/bot${env.TG_Bot_Token}/sendDocument`;
            console.log('Sending request to:', url);
            const data = await postToTelegram(url, fd, 'sendDocument', 60000, 2);
            const id = getFileId(data);
            if (!id) throw new Error('Failed to get file ID');
            const ext = doc.ext || 'bin';
            results.push({ src: `/file/${id}.${ext}` });
            await putMeta(id, ext, doc.mime || '', env);
        }

        // 统一返回 { urls: [...] }，便于前端批量解析
        return new Response(
            JSON.stringify({ urls: results.map(r => r.src) }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        console.error('Upload error:', error);
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
    
    if (result.photo) {
        const fileId = result.photo.reduce((prev, current) =>
            (prev.file_size > current.file_size) ? prev : current
        ).file_id;
        console.log('getFileId: Found photo file_id:', fileId);
        return fileId;
    }
    if (result.document) {
        console.log('getFileId: Found document file_id:', result.document.file_id);
        return result.document.file_id;
    }
    if (result.video) {
        console.log('getFileId: Found video file_id:', result.video.file_id);
        return result.video.file_id;
    }
    if (result.sticker) {
        console.log('getFileId: Found sticker file_id:', result.sticker.file_id);
        return result.sticker.file_id;
    }

    console.error('getFileId: No file_id found in result. Available keys:', Object.keys(result));
    return null;
}

// 从 sendMediaGroup 返回结果中提取每个消息的文件 id（保持顺序）
function getFileIdsFromGroup(response) {
    if (!response.ok || !Array.isArray(response.result)) return [];
    const ids = [];
    for (const msg of response.result) {
        if (msg.photo && Array.isArray(msg.photo) && msg.photo.length) {
            const best = msg.photo.reduce((prev, current) => (prev.file_size > current.file_size) ? prev : current);
            ids.push(best.file_id);
        } else if (msg.video && msg.video.file_id) {
            ids.push(msg.video.file_id);
        } else if (msg.document && msg.document.file_id) {
            ids.push(msg.document.file_id);
        } else if (msg.sticker && msg.sticker.file_id) {
            ids.push(msg.sticker.file_id);
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
    let delay = 6000; // 首次退避 600ms
    while (true) {
        try {
            const resp = await fetchWithTimeout(url, { method: 'POST', body: formData }, timeoutMs, label);
            const data = await resp.json();
            if (resp.ok) return data;
            // 仅对 5xx/429 进行重试
            if (attempt < retries && (resp.status >= 500 || resp.status === 429)) {
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
            if (attempt < retries && (msg.includes('超时') || msg.includes('network') || msg.includes('aborted'))) {
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

// 写入最小 KV 元数据，便于管理后台读取
async function putMeta(fileId, ext, mime, env) {
    try {
        if (!env || !env.img_url) return;
        const value = JSON.stringify({ mime });
        const metadata = {
            TimeStamp: Date.now(),
        };
        // 直接使用 fileId.ext 作为键保存元数据
        const key = ext ? `${fileId}.${ext}` : fileId;
        await env.img_url.put(key, value, { metadata });
    } catch (e) {
        // 仅记录，不影响主流程
        console.log('KV put error', e && e.message ? e.message : e);
    }
}
