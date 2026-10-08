export interface UploadFileInput {
  /** Storage form endpoint from the upload intent. */
  url: string;
  /** Signed policy fields from the upload intent, in the order received. */
  fields: Record<string, string>;
  file: File;
  onProgress?: (percentage: number) => void;
  signal?: AbortSignal;
}

/**
 * The storage service refused the bytes ('rejected') or could not be reached
 * ('network'). A rejection is deterministic for these bytes and credentials;
 * a network failure leaves the stored state unknown.
 */
export class StorageUploadError extends Error {
  constructor(
    message: string,
    readonly kind: 'rejected' | 'network',
    readonly status = 0,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'StorageUploadError';
  }
}

const REJECTION_MESSAGES: Partial<Record<string, string>> = {
  EntityTooLarge: 'The file is larger than the size declared for this upload.',
  EntityTooSmall: 'The file is smaller than the size declared for this upload.',
  AccessDenied:
    'Storage refused the upload because it expired or was not permitted. Retry to get a fresh upload.',
  InvalidPolicyDocument: 'Storage refused the upload policy. Retry the upload.',
};

function storageErrorCode(responseText: string): string | undefined {
  return /<Code>([A-Za-z]{1,64})<\/Code>/.exec(responseText)?.[1];
}

/**
 * Uploads with a multipart form POST, as object-storage POST policies require.
 * The signed fields must precede the file, and no custom headers are set so the
 * browser can add its own multipart boundary. Progress and cancellation use the
 * same XHR events as any browser upload.
 */
export function uploadFile(input: UploadFileInput): Promise<void> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new DOMException('Upload cancelled', 'AbortError'));
      return;
    }
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const settle = () => input.signal?.removeEventListener('abort', abort);
    request.open('POST', input.url);
    request.upload.addEventListener('progress', (event) => {
      const progress = event as ProgressEvent;
      if (progress.lengthComputable)
        input.onProgress?.(
          Math.round((progress.loaded / progress.total) * 100),
        );
    });
    request.addEventListener('load', () => {
      settle();
      if (request.status >= 200 && request.status < 300) {
        resolve();
        return;
      }
      const code = storageErrorCode(request.responseText ?? '');
      reject(
        new StorageUploadError(
          (code && REJECTION_MESSAGES[code]) ||
            `Storage rejected the upload (status ${request.status}).`,
          'rejected',
          request.status,
          code,
        ),
      );
    });
    request.addEventListener('error', () => {
      settle();
      reject(
        new StorageUploadError(
          'The upload was interrupted by a network error.',
          'network',
        ),
      );
    });
    request.addEventListener('abort', () => {
      settle();
      reject(new DOMException('Upload cancelled', 'AbortError'));
    });
    input.signal?.addEventListener('abort', abort, { once: true });

    const form = new FormData();
    for (const [name, value] of Object.entries(input.fields))
      form.append(name, value);
    form.append('file', input.file);
    request.send(form);
  });
}
