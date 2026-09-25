/**
 * Task 8：saveBlob DOM 行为与 autoSave 端到端链路（jsdom 环境）。
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DownloadManager, saveBlob } from '../index.js';

function mockArrayBufferResponse(): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'text/csv' }),
    body: null,
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  } as Response;
}

describe('saveBlob (TR-8.5)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('creates an object URL, clicks an anchor with download attr, and revokes', () => {
    const createSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:mock-url');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    const appendSpy = vi.spyOn(document.body, 'appendChild');

    const blob = new Blob(['hello'], { type: 'text/plain' });
    saveBlob(blob, 'hello.txt');

    expect(createSpy).toHaveBeenCalledWith(blob);
    expect(appendSpy).toHaveBeenCalledTimes(1);
    const anchor = appendSpy.mock.calls[0]?.[0] as HTMLAnchorElement;
    expect(anchor).toBeInstanceOf(HTMLAnchorElement);
    expect(anchor.href).toBe('blob:mock-url');
    expect(anchor.download).toBe('hello.txt');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy).toHaveBeenCalledWith('blob:mock-url');
    expect(document.querySelector('a')).toBeNull(); // click 后已移除
  });
});

describe('autoSave integration (TR-8.5)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('invokes the save path automatically after a successful download', async () => {
    const fetchMock = vi.fn(async () => mockArrayBufferResponse());
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:auto');
    const revokeSpy = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => {});
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});

    const manager = new DownloadManager({ concurrency: 1, maxRetries: 0 });
    const blob = await manager.download('https://e.com/report.csv', {
      autoSave: true,
      filename: 'report.csv',
    });

    expect(blob.size).toBe(4);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy).toHaveBeenCalledWith('blob:auto');
    const anchor = clickSpy.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('report.csv');
  });
});
