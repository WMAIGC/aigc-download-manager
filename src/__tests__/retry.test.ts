/**
 * Task 6：失败自动重试（指数退避、任务级覆盖、等待中取消、取消不重试、回调隔离）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadError } from '../core/errors.js';
import { DownloadManager } from '../core/DownloadManager.js';
import type {
  AdapterContext,
  AdapterProgressCallback,
  DownloadAdapter,
  RetryInfo,
} from '../index.js';

/** 按预设次数失败后成功（或始终失败）的脚本化适配器。 */
class ScriptedAdapter implements DownloadAdapter<string> {
  attempts = 0;
  readonly observedSignals: AbortSignal[] = [];

  constructor(
    private readonly config: {
      failTimes: number | 'always';
      errorKind?: 'download' | 'plain';
    } = { failTimes: 0 },
  ) {}

  async execute(
    ctx: AdapterContext,
    signal: AbortSignal,
    _onProgress: AdapterProgressCallback,
  ): Promise<string> {
    this.attempts += 1;
    this.observedSignals.push(signal);
    const failTimes =
      this.config.failTimes === 'always'
        ? Number.POSITIVE_INFINITY
        : this.config.failTimes;
    if (this.attempts <= failTimes) {
      if (this.config.errorKind === 'plain') {
        throw new Error(`plain failure ${this.attempts}`);
      }
      throw new DownloadError(`http failure ${this.attempts}`, {
        status: 500,
      });
    }
    return `ok:${ctx.id}`;
  }
}

describe('automatic retry (AC-8)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries twice with exponential backoff, then succeeds', async () => {
    const adapter = new ScriptedAdapter({ failTimes: 2 });
    const manager = new DownloadManager<string>({
      concurrency: 1,
      adapter,
      maxRetries: 2,
      retryDelay: 1000,
    });
    const retries: RetryInfo[] = [];

    const p = manager.download('https://e.com/f', {
      onRetry: (info) => retries.push(info),
    });

    // 第 1 次失败 → 等 1000ms → 第 2 次尝试。
    await vi.advanceTimersByTimeAsync(1000);
    // 第 2 次失败 → 等 2000ms → 第 3 次尝试成功。
    await vi.advanceTimersByTimeAsync(2000);

    await expect(p).resolves.toBe('ok:task-1');
    expect(adapter.attempts).toBe(3);
    expect(retries).toEqual([
      {
        attempt: 1,
        maxRetries: 2,
        delay: 1000,
        error: expect.objectContaining({ message: 'http failure 1' }),
      },
      {
        attempt: 2,
        maxRetries: 2,
        delay: 2000,
        error: expect.objectContaining({ message: 'http failure 2' }),
      },
    ]);
    expect(manager.getStats().completed).toBe(1);
  });

  it('fails permanently after exhausting retries', async () => {
    const adapter = new ScriptedAdapter({ failTimes: 'always' });
    const manager = new DownloadManager<string>({
      concurrency: 1,
      adapter,
      maxRetries: 2,
      retryDelay: 1000,
    });

    const p = manager.download('https://e.com/f');
    // 先挂载拒绝处理器，再推进假时钟，避免 unhandled rejection。
    const rejection = expect(p).rejects.toMatchObject({
      name: 'DownloadError',
      status: 500,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    await rejection;
    expect(adapter.attempts).toBe(3);
    expect(manager.getStats().failed).toBe(1);
  });

  it('honors task-level maxRetries and retryDelay overrides', async () => {
    const adapter = new ScriptedAdapter({ failTimes: 1 });
    const manager = new DownloadManager<string>({
      concurrency: 1,
      adapter,
      maxRetries: 5,
      retryDelay: 5000,
    });
    const retries: RetryInfo[] = [];

    const p = manager.download('https://e.com/f', {
      maxRetries: 1,
      retryDelay: 250,
      onRetry: (info) => retries.push(info),
    });

    await vi.advanceTimersByTimeAsync(250);
    await expect(p).resolves.toBe('ok:task-1');
    expect(adapter.attempts).toBe(2);
    expect(retries[0]).toMatchObject({
      attempt: 1,
      maxRetries: 1,
      delay: 250,
    });
  });

  it('normalizes a plain Error into DownloadError', async () => {
    const adapter = new ScriptedAdapter({
      failTimes: 'always',
      errorKind: 'plain',
    });
    const manager = new DownloadManager<string>({
      concurrency: 1,
      adapter,
      maxRetries: 0,
      retryDelay: 1000,
    });

    const p = manager.download('https://e.com/f');
    const rejection = expect(p).rejects.toMatchObject({
      name: 'DownloadError',
      message: 'plain failure 1',
    });
    await vi.advanceTimersByTimeAsync(0);
    await rejection;
    expect(adapter.attempts).toBe(1);
  });

  it('cancels during retry wait: timer is cleared and no more attempts happen', async () => {
    const adapter = new ScriptedAdapter({ failTimes: 1 });
    const manager = new DownloadManager<string>({
      concurrency: 1,
      adapter,
      maxRetries: 2,
      retryDelay: 1000,
    });
    const retries: RetryInfo[] = [];
    const controller = new AbortController();

    const p = manager.download('https://e.com/f', {
      signal: controller.signal,
      onRetry: (info) => retries.push(info),
    });
    const rejection = expect(p).rejects.toMatchObject({
      name: 'AbortError',
    });

    // 第 1 次失败进入等待；等待 500ms 后取消。
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5000);

    await rejection;
    expect(adapter.attempts).toBe(1);
    expect(retries).toHaveLength(1);
    expect(manager.getStats().canceled).toBe(1);
    expect(manager.getStats().queued).toBe(0);
  });

  it('does not retry failures caused by abort (TR-6.5)', async () => {
    // 活动中收到 abort 即拒绝 AbortError 的适配器。
    class AbortFailAdapter implements DownloadAdapter<string> {
      attempts = 0;

      async execute(
        _ctx: AdapterContext,
        signal: AbortSignal,
        _onProgress: AdapterProgressCallback,
      ): Promise<string> {
        this.attempts += 1;
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () =>
              reject(
                new DOMException('aborted by caller', 'AbortError'),
              ),
            { once: true },
          );
        });
      }
    }

    const adapter = new AbortFailAdapter();
    const manager = new DownloadManager<string>({
      concurrency: 1,
      adapter,
      maxRetries: 2,
      retryDelay: 1000,
    });
    const retries: RetryInfo[] = [];
    const controller = new AbortController();

    const p = manager.download('https://e.com/f', {
      signal: controller.signal,
      onRetry: (info) => retries.push(info),
    });
    const rejection = expect(p).rejects.toMatchObject({
      name: 'AbortError',
    });

    controller.abort();
    await vi.advanceTimersByTimeAsync(5000);

    await rejection;
    expect(adapter.attempts).toBe(1);
    expect(retries).toHaveLength(0);
  });

  it('isolates throwing onRetry callback from the retry flow', async () => {
    const adapter = new ScriptedAdapter({ failTimes: 1 });
    const manager = new DownloadManager<string>({
      concurrency: 1,
      adapter,
      maxRetries: 1,
      retryDelay: 100,
    });

    const p = manager.download('https://e.com/f', {
      onRetry: () => {
        throw new Error('user callback is broken');
      },
    });

    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBe('ok:task-1');
    expect(adapter.attempts).toBe(2);
  });
});
