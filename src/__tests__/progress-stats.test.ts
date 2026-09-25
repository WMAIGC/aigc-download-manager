/**
 * Task 7：进度上报（回调 + progress 事件）、未知总量、queueUpdate 载荷、
 * 各时点统计、用户回调异常隔离。
 */
import { describe, expect, it } from 'vitest';
import { DownloadManager } from '../core/DownloadManager.js';
import type { ProgressInfo, QueueStats } from '../index.js';
import { ManualAdapter } from './utils/manualAdapter.js';

describe('progress reporting (AC-9)', () => {
  it('delivers normalized progress to onProgress and progress event', async () => {
    const adapter = new ManualAdapter();
    const manager = new DownloadManager<string>({ concurrency: 1, adapter });

    const callbackValues: ProgressInfo[] = [];
    const eventValues: Array<{ id: string } & ProgressInfo> = [];
    manager.on('progress', (info) => {
      eventValues.push(info);
    });

    const p = manager.download('https://e.com/f', {
      onProgress: (info) => callbackValues.push(info),
    });
    const handle = adapter.started[0];

    handle?.report(50, 100);
    handle?.report(1, 3); // 四舍五入
    handle?.report(120, 100); // 截断到 100
    handle?.resolve('done');
    await p;

    expect(callbackValues).toEqual([
      { loaded: 50, total: 100, percent: 50 },
      { loaded: 1, total: 3, percent: 33 },
      { loaded: 120, total: 100, percent: 100 },
    ]);
    expect(eventValues).toEqual([
      { id: 'task-1', loaded: 50, total: 100, percent: 50 },
      { id: 'task-1', loaded: 1, total: 3, percent: 33 },
      { id: 'task-1', loaded: 120, total: 100, percent: 100 },
    ]);

    // 终态快照保留最后一次进度。
    expect(manager.getTasks()[0]?.progress).toEqual({
      loaded: 120,
      total: 100,
      percent: 100,
    });
  });

  it('reports percent=null for unknown or invalid total', () => {
    const adapter = new ManualAdapter();
    const manager = new DownloadManager<string>({ concurrency: 1, adapter });

    const values: ProgressInfo[] = [];
    manager.download('https://e.com/f', {
      onProgress: (info) => values.push(info),
    });
    const handle = adapter.started[0];

    handle?.report(30, null);
    handle?.report(30, 0);
    handle?.report(30, -5);
    handle?.report(30, Number.NaN);
    handle?.report(30, Number.POSITIVE_INFINITY);

    expect(values.every((v) => v.percent === null && v.total === null)).toBe(
      true,
    );
    expect(values.map((v) => v.loaded)).toEqual([30, 30, 30, 30, 30]);
  });

  it('isolates a throwing onProgress callback', async () => {
    const adapter = new ManualAdapter();
    const manager = new DownloadManager<string>({ concurrency: 1, adapter });

    const p = manager.download('https://e.com/f', {
      onProgress: () => {
        throw new Error('progress consumer broken');
      },
    });
    const handle = adapter.started[0];

    expect(() => {
      handle?.report(10, 100);
      handle?.report(20, 100);
    }).not.toThrow();

    handle?.resolve('done');
    await expect(p).resolves.toBe('done');
  });
});

describe('queueUpdate event payload (TR-7.3)', () => {
  it('emits queued -> active -> completed with fresh stats and snapshot', async () => {
    const adapter = new ManualAdapter();
    const manager = new DownloadManager<string>({ concurrency: 1, adapter });

    const events: Array<{
      state: string;
      stats: QueueStats;
      url: string;
      id: string;
    }> = [];
    manager.on('queueUpdate', ({ stats, task }) => {
      events.push({
        state: task.state,
        stats: { ...stats },
        url: task.url,
        id: task.id,
      });
    });

    const p = manager.download('https://e.com/f', { priority: 3 });
    adapter.started[0]?.resolve('done');
    await p;

    expect(events.map((e) => e.state)).toEqual([
      'queued',
      'active',
      'completed',
    ]);
    expect(events[0]?.stats).toMatchObject({
      queued: 1,
      active: 0,
      total: 1,
    });
    expect(events[1]?.stats).toMatchObject({
      queued: 0,
      active: 1,
      total: 1,
    });
    expect(events[2]?.stats).toMatchObject({
      active: 0,
      completed: 1,
      total: 1,
    });
    expect(events.every((e) => e.url === 'https://e.com/f')).toBe(true);
    expect(events[2]?.id).toBe('task-1');
    expect(
      manager.getTasks()[0]?.priority,
    ).toBe(3);
  });
});

describe('getStats at lifecycle points (TR-7.4)', () => {
  it('counts queued, active, completed, failed and canceled correctly', async () => {
    // 关闭自动重试，失败即终态，便于精确核对各计数。
    const adapter = new ManualAdapter();
    const manager = new DownloadManager<string>({
      concurrency: 2,
      maxRetries: 0,
      adapter,
    });

    const a = manager.download('A');
    const b = manager.download('B');
    const c = manager.download('C');
    expect(manager.getStats()).toMatchObject({
      queued: 1,
      active: 2,
      total: 3,
    });

    // A 完成 → C 补位。
    adapter.started.find((h) => h.url === 'A')?.resolve('a');
    await a;
    expect(manager.getStats()).toMatchObject({
      queued: 0,
      active: 2,
      completed: 1,
      total: 3,
    });

    // B 永久失败。
    adapter.started.find((h) => h.url === 'B')?.reject(new Error('boom'));
    await expect(b).rejects.toMatchObject({ name: 'DownloadError' });
    expect(manager.getStats().failed).toBe(1);

    // D 启动后立即取消。
    const controller = new AbortController();
    const d = manager.download('D', { signal: controller.signal });
    controller.abort();
    await expect(d).rejects.toMatchObject({ name: 'AbortError' });
    expect(manager.getStats().canceled).toBe(1);

    // E 启动后永久失败（槽位此时：C 活动 + E 活动）。
    const e = manager.download('E');
    const eHandle = adapter.started.find((h) => h.url === 'E');
    eHandle?.reject(new Error('permanent'));
    await expect(e).rejects.toMatchObject({ name: 'DownloadError' });

    // C 完成。
    adapter.started.find((h) => h.url === 'C')?.resolve('c');
    await expect(c).resolves.toBe('c');

    const stats = manager.getStats();
    expect(stats.completed).toBe(2); // A、C
    expect(stats.failed).toBe(2); // B、E
    expect(stats.canceled).toBe(1); // D
    expect(stats.queued + stats.active).toBe(0);
    expect(stats.total).toBe(5);
  });

  it('returns immutable-at-call-site snapshot stats (new object each time)', () => {
    const adapter = new ManualAdapter();
    const manager = new DownloadManager<string>({ concurrency: 1, adapter });
    manager.download('A');

    const s1 = manager.getStats();
    const s2 = manager.getStats();
    expect(s1).not.toBe(s2);
    expect(s1).toEqual(s2);
    (s1 as { queued: number }).queued = 999;
    expect(manager.getStats().queued).toBe(0);
  });
});
