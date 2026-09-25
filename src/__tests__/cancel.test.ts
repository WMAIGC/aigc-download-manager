/**
 * Task 5：AbortSignal 取消与 clear()。
 */
import { describe, expect, it, vi } from 'vitest';
import { DownloadManager } from '../core/DownloadManager.js';
import { ManualAdapter } from './utils/manualAdapter.js';

describe('queued task cancellation (TR-5.1)', () => {
  it('never executes and rejects with AbortError, freeing the slot', async () => {
    const adapter = new ManualAdapter();
    const manager = new DownloadManager<string>({ concurrency: 1, adapter });

    const aController = new AbortController();
    const bController = new AbortController();
    const a = manager.download('A', { signal: aController.signal });
    const b = manager.download('B', { signal: bController.signal });
    const c = manager.download('C');
    expect(adapter.started.map((h) => h.url)).toEqual(['A']);

    // 取消排队中的 B。
    bController.abort();
    await expect(b).rejects.toMatchObject({ name: 'AbortError' });

    // B 从未执行；槽位补位给 C 不需要等待 A 结束（B 不占槽，但 C 仍受并发=1限制）。
    expect(
      manager.getTasks().find((t) => t.url === 'B')?.state,
    ).toBe('canceled');
    expect(adapter.started.some((h) => h.url === 'B')).toBe(false);

    // A 结束后 C 启动并完成。
    adapter.started[0]?.resolve('a');
    await a;
    expect(adapter.started.map((h) => h.url)).toEqual(['A', 'C']);
    adapter.started[1]?.resolve('c');
    await c;
    expect(manager.getStats().canceled).toBe(1);
  });
});

describe('active task cancellation (TR-5.2)', () => {
  it('aborts the adapter signal and settles as canceled', async () => {
    const adapter = new ManualAdapter();
    const manager = new DownloadManager<string>({ concurrency: 2, adapter });

    const controller = new AbortController();
    const a = manager.download('A', { signal: controller.signal });
    manager.download('B');

    const activeHandle = adapter.started[0];
    expect(activeHandle?.signal.aborted).toBe(false);

    controller.abort();

    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    expect(activeHandle?.signal.aborted).toBe(true);
    expect(
      manager.getTasks()[0]?.state,
    ).toBe('canceled');
  });

  it('treats an abort arriving together with success as canceled', async () => {
    const adapter = new ManualAdapter();
    const manager = new DownloadManager<string>({ concurrency: 1, adapter });

    const controller = new AbortController();
    const p = manager.download('A', { signal: controller.signal });
    controller.abort();
    // 适配器即使"迟到地"返回成功，取消仍优先。
    adapter.started[0]?.resolve('late-success');

    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(manager.getTasks()[0]?.state).toBe('canceled');
  });
});

describe('pre-aborted signal (TR-5.3)', () => {
  it('rejects immediately without enqueuing or executing', async () => {
    const adapter = new ManualAdapter();
    const manager = new DownloadManager<string>({ concurrency: 1, adapter });

    const controller = new AbortController();
    controller.abort();
    const beforeTotal = manager.getStats().total;

    await expect(
      manager.download('X', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(adapter.started).toHaveLength(0);
    expect(manager.getStats().total).toBe(beforeTotal);
    expect(manager.getStats().active + manager.getStats().queued).toBe(0);
  });
});

describe('clear() (TR-5.4)', () => {
  it('cancels every queued and active task', async () => {
    const adapter = new ManualAdapter();
    const manager = new DownloadManager<string>({ concurrency: 1, adapter });

    const c1 = new AbortController();
    const c2 = new AbortController();
    const a = manager.download('A', { signal: c1.signal });
    const b = manager.download('B', { signal: c2.signal });

    manager.clear();

    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    await expect(b).rejects.toMatchObject({ name: 'AbortError' });
    expect(adapter.started[0]?.signal.aborted).toBe(true);

    const stats = manager.getStats();
    expect(stats.queued + stats.active).toBe(0);
    expect(stats.canceled).toBe(2);

    // clear 之后队列仍可接收新任务。
    const next = manager.download('NEXT');
    expect(adapter.started.some((h) => h.url === 'NEXT')).toBe(true);
    const nextHandle = adapter.started.find((h) => h.url === 'NEXT');
    nextHandle?.resolve('next');
    expect(await next).toBe('next');
  });
});

describe('idempotency and listener cleanup (TR-5.5)', () => {
  it('removes the abort listener after terminal state and ignores repeats', async () => {
    const adapter = new ManualAdapter();
    const manager = new DownloadManager<string>({ concurrency: 1, adapter });

    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    const p = manager.download('A', { signal: controller.signal });
    adapter.started[0]?.resolve('ok');
    await p;

    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    removeSpy.mockRestore();

    // 终态后再 abort 无副作用，且不抛错。
    expect(() => controller.abort()).not.toThrow();
    expect(manager.getTasks()[0]?.state).toBe('completed');
  });

  it('double abort and aborting an already terminal task are no-ops', async () => {
    const adapter = new ManualAdapter();
    const manager = new DownloadManager<string>({ concurrency: 1, adapter });

    const controller = new AbortController();
    const p = manager.download('A', { signal: controller.signal });
    controller.abort();
    expect(() => controller.abort()).not.toThrow();

    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    const stats = manager.getStats();
    expect(stats.canceled).toBe(1);
  });
});
