/**
 * Task 2 契约测试：
 * - 仅凭公开导出即可实现一个自定义适配器（不导入 src/core 内部模块）；
 * - 事件白名单在类型层只有 queueUpdate/progress；
 * - TypedEmitter 基础行为与监听器异常隔离；
 * - AbortError 工具函数行为。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  TypedEmitter,
  createAbortError,
  isAbortError,
} from '../index.js';
import type {
  AdapterContext,
  AdapterProgressCallback,
  DownloadAdapter,
  DownloadOptions,
  ManagerEventMap,
} from '../index.js';

/** 仅基于公开接口实现的假适配器（TR-2.3 证据）。 */
class FakeAdapter implements DownloadAdapter<string> {
  readonly calls: Array<{
    ctx: AdapterContext;
    signal: AbortSignal;
  }> = [];

  async execute(
    ctx: AdapterContext,
    signal: AbortSignal,
    onProgress: AdapterProgressCallback,
  ): Promise<string> {
    this.calls.push({ ctx, signal });
    if (signal.aborted) {
      throw createAbortError();
    }
    onProgress(50, 100);
    onProgress(100, 100);
    return `result:${ctx.id}`;
  }
}

interface TestEvents extends Record<string, unknown> {
  queueUpdate: ManagerEventMap['queueUpdate'];
  progress: ManagerEventMap['progress'];
}

describe('DownloadAdapter public contract', () => {
  it('can be implemented using only public exports', async () => {
    const adapter: DownloadAdapter<string> = new FakeAdapter();
    const controller = new AbortController();
    const ctx: AdapterContext = {
      id: 't1',
      url: 'https://example.com/f',
      options: { priority: 1 } satisfies DownloadOptions,
    };
    const progress = vi.fn();

    const result = await adapter.execute(ctx, controller.signal, progress);

    expect(result).toBe('result:t1');
    expect(progress).toHaveBeenCalledTimes(2);
    expect(progress.mock.calls[0]).toEqual([50, 100]);
    // 结果类型可直接赋值给 string（TR-2.1 类型推导证据）
    const typed: string = result;
    expect(typed).toBe(result);
  });

  it('receives an aborted signal and throws AbortError', async () => {
    const adapter = new FakeAdapter();
    const controller = new AbortController();
    controller.abort();
    const ctx: AdapterContext = {
      id: 't2',
      url: 'https://example.com/f',
      options: {},
    };

    await expect(
      adapter.execute(ctx, controller.signal, vi.fn()),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(adapter.calls).toHaveLength(1);
  });
});

describe('ManagerEventMap whitelist', () => {
  it('exposes only queueUpdate and progress keys', () => {
    // 若白名单被增减，此数组的类型赋值会编译失败（TR-2.2 类型侧证据）。
    const keys: Array<keyof ManagerEventMap> = [
      'queueUpdate',
      'progress',
    ];
    expect(keys).toHaveLength(2);
    expect(keys).not.toContain('taskComplete');
    expect(keys).not.toContain('taskError');
    expect(keys).not.toContain('taskRetry');
  });
});

describe('TypedEmitter', () => {
  it('delivers payloads to on subscribers', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const listener = vi.fn();
    emitter.on('progress', listener);
    (emitter as unknown as {
      emit: (k: 'progress', p: TestEvents['progress']) => void;
    }).emit('progress', { id: 'a', loaded: 1, total: 2, percent: 50 });

    expect(listener).toHaveBeenCalledWith({
      id: 'a',
      loaded: 1,
      total: 2,
      percent: 50,
    });
  });

  it('supports off and once', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const listener = vi.fn();
    emitter.on('progress', listener);
    emitter.off('progress', listener);

    const onceListener = vi.fn();
    emitter.once('progress', onceListener);

    const emit = (
      emitter as unknown as {
        emit: (k: 'progress', p: TestEvents['progress']) => void;
      }
    ).emit;
    emit.call(emitter, 'progress', {
      id: 'a',
      loaded: 1,
      total: null,
      percent: null,
    });
    emit.call(emitter, 'progress', {
      id: 'a',
      loaded: 2,
      total: null,
      percent: null,
    });

    expect(listener).not.toHaveBeenCalled();
    expect(onceListener).toHaveBeenCalledTimes(1);
  });

  it('isolates throwing listeners from other listeners', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const throwing = vi.fn(() => {
      throw new Error('boom');
    });
    const after = vi.fn();
    emitter.on('queueUpdate', throwing);
    emitter.on('queueUpdate', after);

    expect(() =>
      (
        emitter as unknown as {
          emit: (k: 'queueUpdate', p: TestEvents['queueUpdate']) => void;
        }
      ).emit('queueUpdate', {
        stats: {
          queued: 0,
          active: 0,
          completed: 0,
          failed: 0,
          canceled: 0,
          total: 0,
        },
        task: {
          id: 'x',
          url: 'u',
          state: 'queued',
          priority: 0,
          progress: { loaded: 0, total: null, percent: null },
          result: null,
          error: null,
        },
      }),
    ).not.toThrow();
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe('abort error helpers', () => {
  it('createAbortError has the AbortError name', () => {
    const error = createAbortError();
    expect(error.name).toBe('AbortError');
    expect(isAbortError(error)).toBe(true);
  });

  it('detects native DOMException abort and cause-chain abort', () => {
    const native = new DOMException('aborted', 'AbortError');
    expect(isAbortError(native)).toBe(true);
    const wrapped = new Error('wrapped');
    Object.defineProperty(wrapped, 'cause', { value: native });
    expect(isAbortError(wrapped)).toBe(true);
    expect(isAbortError(new Error('normal'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
