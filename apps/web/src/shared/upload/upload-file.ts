export interface UploadFileInput {
  url: string;
  file: File;
  headers?: Record<string, string>;
  onProgress?: (percentage: number) => void;
  signal?: AbortSignal;
}

export function uploadFile(input: UploadFileInput): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    request.open('PUT', input.url);
    for (const [name, value] of Object.entries(input.headers ?? {}))
      request.setRequestHeader(name, value);
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable)
        input.onProgress?.(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener('load', () => {
      input.signal?.removeEventListener('abort', abort);
      if (request.status >= 200 && request.status < 300) resolve();
      else
        reject(
          new Error(`Storage upload failed with status ${request.status}`),
        );
    });
    request.addEventListener('error', () => {
      input.signal?.removeEventListener('abort', abort);
      reject(new Error('Storage upload failed because of a network error'));
    });
    request.addEventListener('abort', () => {
      input.signal?.removeEventListener('abort', abort);
      reject(new DOMException('Upload cancelled', 'AbortError'));
    });
    if (input.signal?.aborted) return abort();
    input.signal?.addEventListener('abort', abort, { once: true });
    request.send(input.file);
  });
}
