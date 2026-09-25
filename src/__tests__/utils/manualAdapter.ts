/**
 * 测试工具：可手动控制完成时机的适配器。
 *
 * 仅用于单元测试，不属于库公开 API。
 */
import type {
  AdapterContext,
  AdapterProgressCallback,
  DownloadAdapter,
  TaskId,
} from '../../index.js';

/** 一个正在执行的手动任务句柄。 */
export interface ManualHandle {
  readonly id: TaskId;
  readonly url: string;
  readonly signal: AbortSignal;
  /** 以结果结束本次尝试。 */
  resolve: (value: string) => void;
  /** 以错误结束本次尝试。 */
  reject: (error: unknown) => void;
  /** 上报一次进度。 */
  report: (loaded: number, total: number | null) => void;
}

/**
 * execute 调用挂起，直到测试代码手动 resolve/reject；
 * 响应 AbortSignal（abort 时以 AbortError reject）。
 */
export class ManualAdapter implements DownloadAdapter<string> {
  /** 按启动顺序记录的全部句柄。 */
  readonly started: ManualHandle[] = [];
  #active = 0;
  /** 观测到的同时活动数峰值。 */
  maxActive = 0;

  /**
   * @param options.autoResolve 为 true 时，每次 execute 在一个微任务后自动成功。
   */
  constructor(
    private readonly options: { autoResolve?: boolean } = {},
  ) {}

  execute(
    context: AdapterContext,
    signal: AbortSignal,
    onProgress: AdapterProgressCallback,
  ): Promise<string> {
    const promise = new Promise<string>((resolve, reject) => {
      this.#active += 1;
      this.maxActive = Math.max(this.maxActive, this.#active);

      let settled = false;
      const finish = (
        action: () => void,
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        action();
      };

      const handle: ManualHandle = {
        id: context.id,
        url: context.url,
        signal,
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
        report: (loaded, total) => onProgress(loaded, total),
      };
      this.started.push(handle);

      signal.addEventListener(
        'abort',
        () => {
          finish(() => reject(new DOMException('The operation was aborted', 'AbortError')));
        },
        { once: true },
      );

      if (this.options.autoResolve) {
        queueMicrotask(() => {
          finish(() => resolve(`auto:${context.id}`));
        });
      }
    });

    promise.then(
      () => {
        this.#active -= 1;
      },
      () => {
        this.#active -= 1;
      },
    );
    return promise;
  }
}
