/**
 * Task 3：队列核心——download、调度、并发硬上限、FIFO 补位、
 * 动态并发、非法参数、快照隔离。
 */
import { describe, expect, it } from 'vitest';
import { DownloadManager } from '../core/DownloadManager.js';
import { ManualAdapter } from './utils/manualAdapter.js';

function createManager(
  concurrency = 3,
  autoResolve = false,
): {
  manager: DownloadManager<string>;
  adapter: ManualAdapter;
} {
  const adapter = new ManualAdapter({ autoResolve });
  const manager = new DownloadManager<string>({ concurrency, adapter });
  return { manager, adapter };
}

describe('concurrency hard limit (AC-2)', () => {
  it('never runs more than concurrency tasks at once', async () => {
    const { manager, adapter } = createManager(3, true);
    const promises: Array<Promise<string>> = [];
    for (let i = 0; i < 10; i += 1) {
      promises.push(manager.download(`https://e.com/${i}`));
    }

    // 同步入队完成后，恰好启动 3 个活动任务。
    expect(adapter.started).toHaveLength(3);

    const results = await Promise.all(promises);

    expect(adapter.maxActive).toBe(3);
    expect(results).toHaveLength(10);
    expect(adapter.started).toHaveLength(10);
  });
});

describe('slot refill and promise results (AC-3)', () => {
  it('starts the next queued task immediately after a slot frees', async () => {
    const { manager, adapter } = createManager(2);
    const promises = [
      manager.download('https://e.com/0'),
      manager.download('https://e.com/1'),
      manager.download('https://e.com/2'),
      manager.download('https://e.com/3'),
      manager.download('https://e.com/4'),
    ];

    expect(adapter.started.map((h) => h.url)).toEqual([
      'https://e.com/0',
      'https://e.com/1',
    ]);

    adapter.started[0]?.resolve('r0');
    expect(await promises[0]).toBe('r0');
    expect(adapter.started.map((h) => h.url)).toContain('https://e.com/2');
    expect(adapter.started).toHaveLength(3);

    adapter.started[1]?.resolve('r1');
    expect(await promises[1]).toBe('r1');
    expect(adapter.started).toHaveLength(4);

    // 每结束一个活动任务立即补位，直到 5 个全部启动并完成。
    adapter.started[2]?.resolve('r2');
    expect(await promises[2]).toBe('r2');
    expect(adapter.started).toHaveLength(5);

    adapter.started[3]?.resolve('r3');
    expect(await promises[3]).toBe('r3');
    adapter.started[4]?.resolve('r4');
    expect(await promises[4]).toBe('r4');

    const results = await Promise.all(promises);
    expect(results).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
    expect(manager.getStats().completed).toBe(5);
    expect(
      manager.getTasks().every((t) => t.state === 'completed'),
    ).toBe(true);
  });

  it('rejects when url is invalid', async () => {
    const { manager } = createManager(1);
    await expect(manager.download('')).rejects.toMatchObject({
      name: 'DownloadError',
    });
  });
});

describe('dynamic concurrency (AC-5)', () => {
  it('raises immediately and shrinks without aborting active tasks', async () => {
    const { manager, adapter } = createManager(2);
    const promises: Array<Promise<string>> = [];
    for (let i = 0; i < 5; i += 1) {
      promises.push(manager.download(`https://e.com/${i}`));
    }
    expect(adapter.started).toHaveLength(2);

    manager.setConcurrency(4);
    expect(adapter.started).toHaveLength(4);
    expect(adapter.maxActive).toBe(4);

    manager.setConcurrency(1);
    // 收缩不中断活动任务。
    expect(adapter.started.every((h) => !h.signal.aborted)).toBe(true);

    // 结束 4 个活动任务后，只剩 1 个排队任务；它启动后活动数始终 ≤ 1。
    const activeFour = adapter.started.slice();
    for (const handle of activeFour) {
      handle.resolve('ok');
    }
    await Promise.all(promises.slice(0, 4));
    expect(adapter.started).toHaveLength(5);

    adapter.started[4]?.resolve('ok');
    await Promise.all(promises);
    expect(adapter.maxActive).toBe(4);
    expect(manager.getStats().completed).toBe(5);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fraction', 1.5],
    ['NaN', Number.NaN],
  ])('rejects invalid concurrency (%s)', (_label, value) => {
    const adapter = new ManualAdapter();
    expect(() => new DownloadManager({ concurrency: value, adapter })).toThrow(
      /positive integer/,
    );
    const manager = new DownloadManager({ concurrency: 2, adapter });
    expect(() => manager.setConcurrency(value)).toThrow(/positive integer/);
  });
});

describe('snapshot isolation (TR-3.5)', () => {
  it('returns detached data copies', async () => {
    const { manager, adapter } = createManager(1);
    const p = manager.download('https://e.com/0', {
      onProgress: () => undefined,
    });

    const first = manager.getTasks()[0];
    const second = manager.getTasks()[0];
    expect(first).toBeDefined();
    // 每次返回全新对象与嵌套副本。
    expect(first).not.toBe(second);
    expect(first?.progress).not.toBe(second?.progress);

    const mutable = first as unknown as {
      state: string;
      progress: { loaded: number };
    };
    mutable.state = 'completed';
    mutable.progress.loaded = 999;

    const again = manager.getTasks()[0];
    expect(again?.state).toBe('active');
    expect(again?.progress.loaded).toBe(0);

    adapter.started[0]?.resolve('ok');
    await p;
  });
});
