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
      xhr.setRequestHeader('X-File-ID', encodeURIComponent(fileId));
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
      xhr.setRequestHeader('X-File-Size', String(file.size));
      xhr.setRequestHeader('X-Chunk-Index', String(i));
      xhr.setRequestHeader('X-Total-Chunks', String(totalChunks));
      xhr.setRequestHeader('Content-Type', file.type);

      const chunkUploadPromise = new Promise<void>((resolveChunk, rejectChunk) => {
        xhr.upload.onprogress = (evt) => {
          const chunkLoaded = evt.loaded;
          const currentTotalLoaded = uploadedBytes + chunkLoaded;
          const percent = file.size ? Math.round((currentTotalLoaded / file.size) * 100) : 0;
          onProgress({ loaded: currentTotalLoaded, total: file.size, percent });
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            uploadedBytes += chunk.size;
            const percent = file.size ? Math.round((uploadedBytes / file.size) * 100) : 0;
            onProgress({ loaded: uploadedBytes, total: file.size, percent });
            resolveChunk();
          } else {
            rejectChunk(new Error(xhr.responseText || `Chunk ${i} upload failed with status ${xhr.status}`));
          }
        };

        xhr.onerror = () => rejectChunk(new Error(`Chunk ${i} network error`));
        xhr.ontimeout = () => rejectChunk(new Error(`Chunk ${i} upload timed out`));
        xhr.timeout = 60000; // 60 seconds timeout
        xhr.send(chunk);
      });

      await chunkUploadPromise;
    }

    resolve(fileId);
  });
}