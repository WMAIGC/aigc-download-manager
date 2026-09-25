/**
 * Task 4：优先级调度——priority 降序、同级 FIFO、运行中插入高优先级。
 */
import { describe, expect, it } from 'vitest';
import { DownloadManager } from '../core/DownloadManager.js';
import { ManualAdapter } from './utils/manualAdapter.js';

function startedUrls(adapter: ManualAdapter): string[] {
  return adapter.started.map((h) => h.url);
}

describe('priority scheduling (AC-4)', () => {
  it('starts A(occupied), then high-priority C, then FIFO B', async () => {
    const adapter = new ManualAdapter();
    const manager = new DownloadManager<string>({ concurrency: 1, adapter });

    const a = manager.download('A');
    const b = manager.download('B', { priority: 0 });
    const c = manager.download('C', { priority: 5 });
    expect(startedUrls(adapter)).toEqual(['A']);

    adapter.started[0]?.resolve('a');
    await a;
    expect(startedUrls(adapter)).toEqual(['A', 'C']);

    adapter.started[1]?.resolve('c');
    await c;
    expect(startedUrls(adapter)).toEqual(['A', 'C', 'B']);

    adapter.started[2]?.resolve('b');
    await Promise.all([a, b, c]);
  });

  it('keeps strict FIFO within the same priority', async () => {
    const adapter = new ManualAdapter();
    const manager = new DownloadManager<string>({ concurrency: 1, adapter });

    const promises = ['A', 'B', 'C', 'D'].map((name) =>
      manager.download(name, { priority: 2 }),
    );
    expect(startedUrls(adapter)).toEqual(['A']);

    for (let i = 0; i < 4; i += 1) {
      adapter.started[i]?.resolve(`r${i}`);
      await promises[i];
      expect(startedUrls(adapter)).toEqual([
        'A',
        'B',
        'C',
        'D',
      ].slice(0, i + 2));
    }
  });

  it('prefers a newly added higher-priority task at the next free slot', async () => {
    const adapter = new ManualAdapter();
    const manager = new DownloadManager<string>({ concurrency: 1, adapter });

    const lowA = manager.download('lowA', { priority: 0 });
    const lowB = manager.download('lowB', { priority: 0 });
    expect(startedUrls(adapter)).toEqual(['lowA']);

    // 运行中插入高优先级任务。
    const late = manager.download('late-high', { priority: 9 });

    adapter.started[0]?.resolve('a');
    await lowA;
    expect(startedUrls(adapter)).toEqual(['lowA', 'late-high']);

    adapter.started[1]?.resolve('late');
    await late;
    expect(startedUrls(adapter)).toEqual(['lowA', 'late-high', 'lowB']);

    adapter.started[2]?.resolve('b');
    await lowB;
  });

  it('respects negative priorities below default 0', async () => {
    const adapter = new ManualAdapter();
    const manager = new DownloadManager<string>({ concurrency: 1, adapter });

    const neg = manager.download('neg', { priority: -5 });
    const normal = manager.download('normal');
    expect(startedUrls(adapter)).toEqual(['neg']); // neg 先占用唯一槽位

    adapter.started[0]?.resolve('neg');
    await neg;
    expect(startedUrls(adapter)).toEqual(['neg', 'normal']);
    adapter.started[1]?.resolve('normal');
    await normal;
  });
});
