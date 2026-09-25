/**
 * Task 8：浏览器适配器——流式聚合、arrayBuffer 兜底、HTTP 错误、中止取消。
 *
 * node 环境：Blob/Headers/ReadableStream 使用 Node 内置实现，fetch 被 mock。
 * saveBlob / autoSave 涉及 DOM，见 saveBlob.test.ts（jsdom）。
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DownloadManager } from '../index.js';
import type { ProgressInfo } from '../index.js';

/** 构造最小可用的 mock Response。 */
function mockResponse(partial: {
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: Headers;
  body?: ReadableStream<Uint8Array> | null;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}): Response {
  return {
    ok: partial.ok,
    status: partial.status ?? 200,
    statusText: partial.statusText ?? 'OK',
    headers:
      partial.headers ??
      new Headers({ 'content-type': 'application/octet-stream' }),
    body: partial.body === undefined ? null : partial.body,
    arrayBuffer:
      partial.arrayBuffer ??
      (async () => new ArrayBuffer(0)),
  } as Response;
}

/** 分块后自然结束的 ReadableStream。 */
function chunkedStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

describe('browserAdapter streaming (TR-8.1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('aggregates chunks into a Blob and reports progress', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        mockResponse({
          ok: true,
          headers: new Headers({
            'content-type': 'application/pdf',
            'content-length': '10',
          }),
          body: chunkedStream([
            new Uint8Array([1, 2, 3, 4]),
            new Uint8Array([5, 6, 7, 8, 9, 10]),
          ]),
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DownloadManager({ concurrency: 1, maxRetries: 0 });
    const progress: ProgressInfo[] = [];
    const blob = await manager.download('https://e.com/f.pdf', {
      headers: { 'x-trace': '1' },
      onProgress: (info) => progress.push(info),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] ?? [];
    expect(calledUrl).toBe('https://e.com/f.pdf');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect((init?.headers as Record<string, string>)['x-trace']).toBe('1');

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(10);
    expect(blob.type).toBe('application/pdf');
    expect(progress).toEqual([
      { loaded: 4, total: 10, percent: 40 },
      { loaded: 10, total: 10, percent: 100 },
    ]);
  });
});

describe('arrayBuffer fallback (TR-8.2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('succeeds when response.body is unavailable', async () => {
    const arrayBufferMock = vi.fn(async () =>
      new Uint8Array([7, 8, 9]).buffer,
    );
    const fetchMock = vi.fn(async () =>
      mockResponse({
        ok: true,
        headers: new Headers({ 'content-type': 'text/plain' }),
        body: null,
        arrayBuffer: arrayBufferMock,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DownloadManager({ concurrency: 1, maxRetries: 0 });
    const progress: ProgressInfo[] = [];
    const blob = await manager.download('https://e.com/plain', {
      onProgress: (info) => progress.push(info),
    });

    expect(arrayBufferMock).toHaveBeenCalledTimes(1);
    expect(blob.size).toBe(3);
    expect(blob.type).toBe('text/plain');
    expect(progress).toEqual([
      { loaded: 3, total: 3, percent: 100 },
    ]);
  });
});

describe('http error mapping (TR-8.3)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects with DownloadError carrying status', async () => {
    const fetchMock = vi.fn(async () =>
      mockResponse({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: new Headers(),
        body: null,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DownloadManager({ concurrency: 1, maxRetries: 0 });
    const rejection = expect(
      manager.download('https://e.com/500'),
    ).rejects.toMatchObject({
      name: 'DownloadError',
      status: 500,
    });
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('abort during streaming (TR-8.4)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('cancels the reader and rejects with AbortError', async () => {
    let cancelCalled = false;
    // 首块可读后永久挂起，等待 cancel。
    const hangingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
      },
      cancel() {
        cancelCalled = true;
      },
    });
    const fetchMock = vi.fn(async () =>
      mockResponse({
        ok: true,
        headers: new Headers({ 'content-length': '100' }),
        body: hangingStream,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DownloadManager({ concurrency: 1, maxRetries: 0 });
    const controller = new AbortController();
    const progress: ProgressInfo[] = [];
    const promise = manager.download('https://e.com/big', {
      signal: controller.signal,
      onProgress: (info) => progress.push(info),
    });
    const rejection = expect(promise).rejects.toMatchObject({
      name: 'AbortError',
    });

    // 等首块进度到达后再中止。
    await vi.waitFor(() => {
      expect(progress[progress.length - 1]?.loaded).toBe(2);
    });
    controller.abort();
    await rejection;

    expect(cancelCalled).toBe(true);
    expect(manager.getStats().canceled).toBe(1);
  });
});
