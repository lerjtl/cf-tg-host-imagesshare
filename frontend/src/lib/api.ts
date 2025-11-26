export async function api<T = any>(input: RequestInfo, init: RequestInit = {}): Promise<T> {
  const res = await fetch(input, { credentials: 'include', ...init })
  if (res.status === 401) throw new Error('Unauthorized')
  const ct = res.headers.get('Content-Type') || ''
  if (ct.includes('application/json')) return (await res.json()) as T
  const text = await res.text()
  try { return JSON.parse(text) as T } catch { throw new Error(text || '请求失败') }
}

export async function login(username: string, password: string) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || '登录失败')
  }
  return true
}

export async function logout() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
}

export type ListQuery = { limit?: number; cursor?: string }
export async function listFiles(q: ListQuery) {
  const qs = new URLSearchParams()
  if (q.limit) qs.set('limit', String(q.limit))
  if (q.cursor) qs.set('cursor', q.cursor)
  return api<{ keys: any[]; cursor?: string; list_complete?: boolean }>(`/api/files?${qs.toString()}`)
}

export async function del(id: string) {
  return api(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
export async function upload(file: File) {
  return uploadWithProgress(file, () => {})
}

export type UploadProgress = { loaded: number; total: number; percent: number }
export function uploadWithProgress(file: File, onProgress: (p: UploadProgress) => void): Promise<any> {
  return new Promise(async (resolve, reject) => {
    const chunkSize = 5 * 1024 * 1024; // 5MB chunks
    const totalChunks = Math.ceil(file.size / chunkSize);
    const fileId = `${file.name}-${file.size}-${Date.now()}`;
    let uploadedBytes = 0;

    onProgress({ loaded: 0, total: file.size, percent: 0 });

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const chunk = file.slice(start, end);

      const xhr = new XMLHttpRequest();
      xhr.open('PUT', '/api/upload'); // Use PUT for chunk uploads
      xhr.withCredentials = true;
      xhr.setRequestHeader('X-File-ID', fileId);
      xhr.setRequestHeader('X-File-Name', file.name);
      xhr.setRequestHeader('X-File-Size', String(file.size));
      xhr.setRequestHeader('X-Chunk-Index', String(i));
      xhr.setRequestHeader('X-Total-Chunks', String(totalChunks));
      xhr.setRequestHeader('Content-Type', file.type);

      const chunkUploadPromise = new Promise<void>((resolveChunk, rejectChunk) => {
        xhr.upload.onprogress = (evt) => {
          // Only update progress for the current chunk being uploaded
          const chunkLoaded = evt.loaded;
          const currentTotalLoaded = uploadedBytes + chunkLoaded;
          const percent = file.size ? Math.round((currentTotalLoaded / file.size) * 100) : 0;
          onProgress({ loaded: currentTotalLoaded, total: file.size, percent });
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            uploadedBytes += chunk.size;
            resolveChunk();
          } else {
            rejectChunk(new Error(xhr.responseText || `Chunk ${i} upload failed`));
          }
        };

        xhr.onerror = () => rejectChunk(new Error(`Chunk ${i} network error`));
        xhr.send(chunk);
      });

      try {
        await chunkUploadPromise;
      } catch (error) {
        reject(error);
        return;
      }
    }

    // After all chunks are uploaded, the server should have returned the final response for the last chunk
    // So we don't need a separate final request here.
    // The last chunk's response will contain the result of the merged file upload.
    // However, the current implementation in onRequestPut returns success for the last chunk and then initiates Telegram upload.
    // We need to wait for the Telegram upload to complete.
    // For simplicity, I will assume the last chunk upload response will contain the final result for now.
    // In a real-world scenario, a separate /api/upload/complete endpoint might be needed.
    // For now, let's just make a dummy request to /api/upload to trigger the final merge and get the result.
    const finalRes = await fetch('/api/upload', {
      method: 'POST',
      headers: {
        'X-File-ID': fileId,
        'X-File-Name': file.name,
        'X-File-Size': String(file.size),
        'X-Total-Chunks': String(totalChunks),
        'X-Final-Upload': 'true', // Indicate this is the finalization request
      },
      credentials: 'include',
    });
    if (!finalRes.ok) {
      // Check for specific error message for file size limit
      const errorText = await finalRes.text();
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error === 'File size exceeds Telegram API direct upload limit (50MB)') {
          reject(new Error(errorJson.error));
          return;
        }
      } catch (e) {
        // Not a JSON error, proceed with generic error
      }
      throw new Error(errorText || 'Final upload failed');
    }
    resolve(finalRes.json().catch(() => ({})));
  });
}
