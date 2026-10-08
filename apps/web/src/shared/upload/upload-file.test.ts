import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageUploadError, uploadFile } from './upload-file';

type Listener = (event: unknown) => void;

class FakeXhr {
  static instances: FakeXhr[] = [];
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown;
  status = 0;
  responseText = '';
  aborted = false;
  listeners: Record<string, Listener[]> = {};
  uploadListeners: Record<string, Listener[]> = {};
  upload = {
    addEventListener: (name: string, listener: Listener) => {
      (this.uploadListeners[name] ??= []).push(listener);
    },
  };

  constructor() {
    FakeXhr.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  addEventListener(name: string, listener: Listener) {
    (this.listeners[name] ??= []).push(listener);
  }

  send(body: unknown) {
    this.body = body;
  }

  abort() {
    this.aborted = true;
    this.emit('abort');
  }

  emit(name: string, event: unknown = {}) {
    for (const listener of this.listeners[name] ?? []) listener(event);
  }

  progress(loaded: number, total: number) {
    for (const listener of this.uploadListeners.progress ?? [])
      listener({ lengthComputable: true, loaded, total });
  }

  finish(status: number, responseText = '') {
    this.status = status;
    this.responseText = responseText;
    this.emit('load');
  }
}

const file = new File(['video-bytes'], 'clip.mp4', { type: 'video/mp4' });
const input = {
  url: 'http://storage.test/video-originals',
  fields: { key: 'originals/v/f.mp4', 'Content-Type': 'video/mp4' },
  file,
};

describe('uploadFile storage form transport', () => {
  beforeEach(() => {
    FakeXhr.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('posts the signed fields first and the file last, with no custom headers', async () => {
    const pending = uploadFile(input);
    const xhr = FakeXhr.instances[0]!;
    xhr.finish(204);
    await pending;

    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe(input.url);
    expect(xhr.headers).toEqual({});
    const form = xhr.body as FormData;
    expect([...form.keys()]).toEqual(['key', 'Content-Type', 'file']);
    expect(form.get('key')).toBe('originals/v/f.mp4');
    expect((form.get('file') as File).name).toBe('clip.mp4');
  });

  it('reports rounded upload progress', async () => {
    const onProgress = vi.fn();
    const pending = uploadFile({ ...input, onProgress });
    const xhr = FakeXhr.instances[0]!;

    xhr.progress(1, 3);
    xhr.progress(3, 3);
    xhr.finish(204);
    await pending;

    expect(onProgress.mock.calls).toEqual([[33], [100]]);
  });

  it('cancels an in-flight upload with an AbortError', async () => {
    const controller = new AbortController();
    const pending = uploadFile({ ...input, signal: controller.signal });
    const xhr = FakeXhr.instances[0]!;

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(xhr.aborted).toBe(true);
  });

  it('does not start when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      uploadFile({ ...input, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeXhr.instances[0]?.body).toBeUndefined();
  });

  it.each([
    ['EntityTooLarge', 400, 'larger than the size declared'],
    ['EntityTooSmall', 400, 'smaller than the size declared'],
    ['AccessDenied', 403, 'expired or was not permitted'],
  ])(
    'maps the storage rejection %s to a safe message',
    async (code, status, text) => {
      const pending = uploadFile(input);
      FakeXhr.instances[0]!.finish(
        status,
        `<?xml version="1.0"?><Error><Code>${code}</Code><Message>secret detail</Message></Error>`,
      );

      const error = await pending.catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(StorageUploadError);
      expect(error).toMatchObject({ kind: 'rejected', status, code });
      expect((error as Error).message).toContain(text);
      expect((error as Error).message).not.toContain('secret detail');
    },
  );

  it('distinguishes a network failure from a storage rejection', async () => {
    const pending = uploadFile(input);
    FakeXhr.instances[0]!.emit('error');

    await expect(pending).rejects.toMatchObject({
      name: 'StorageUploadError',
      kind: 'network',
    });
  });
});
