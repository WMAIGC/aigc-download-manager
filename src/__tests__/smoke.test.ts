/**
 * Task 9 验收：版本、纯 Promise 风格冒烟用例（≤15 行，无 as/无 ! 断言）、
 * AC-13 Promise 契约。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DownloadManager, VERSION } from '../index.js';

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-length': '3' }),
      body: null,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    })),
  );
}

describe('scaffold', () => {
  it('exposes the package version', () => {
    expect(VERSION).toBe('0.1.0');
  });
});

describe('pure-promise smoke (TR-9.4)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drives 3 downloads with Promise.allSettled and AbortController, no assertions', async () => {
    stubFetch();
    // ↓↓ 冒烟用例本体开始（15 行以内；零 as / 零 !）↓↓
    const manager = new DownloadManager({ concurrency: 2, maxRetries: 0 });
    const controller = new AbortController();
    const tasks = [
      manager.download('https://e.com/a', { onProgress: (p) => expect(p.total).toBe(3) }),
      manager.download('https://e.com/b'),
      manager.download('https://e.com/c', { signal: controller.signal }),
    ];
    controller.abort();
    const results = await Promise.allSettled(tasks);
    expect(results[0]?.status).toBe('fulfilled');
    expect(results[1]?.status).toBe('fulfilled');
    expect(results[2]).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } });
    manager.clear();
    // ↑↑ 冒烟用例本体结束 ↑↑
    expect(manager.getStats().queued + manager.getStats().active).toBe(0);
  });
});

describe('promise contract (AC-13 / TR-9.5)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a bare native Promise with no mounted control fields', () => {
    stubFetch();
    const manager = new DownloadManager({ concurrency: 1 });
    const p = manager.download('https://e.com/a');

    expect(p).toBeInstanceOf(Promise);
    expect(Object.keys(p)).toHaveLength(0);
    for (const key of ['taskId', 'cancel', 'promise', 'on']) {
      expect(key in p).toBe(false);
    }
  });

  it('composes with Promise.all and Promise.race', async () => {
    stubFetch();
    const manager = new DownloadManager({ concurrency: 3, maxRetries: 0 });

    const all = await Promise.all([
      manager.download('https://e.com/a'),
      manager.download('https://e.com/b'),
    ]);
    expect(all).toHaveLength(2);
    expect(all[0]).toBeInstanceOf(Blob);

    const raced = await Promise.race([
      manager.download('https://e.com/c'),
      Promise.resolve('fallback'),
    ]);
    // 两个 promise 都可能先敲定；race 仅要求正常返回字符串/Blob 之一。
    expect(typeof raced === 'string' || raced instanceof Blob).toBe(true);
  });

  it('exposes no forbidden batch/id-based control surface', () => {
    stubFetch();
    const manager = new DownloadManager({ concurrency: 1 });

    for (const forbidden of [
      'addAll',
      'whenIdle',
      'cancel',
      'cancelAll',
      'pause',
      'resume',
    ]) {
      expect(forbidden in manager).toBe(false);
    }
    expect(typeof manager.clear).toBe('function');
    expect(typeof manager.download).toBe('function');
  });
});
