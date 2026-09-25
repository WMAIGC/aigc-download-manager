/**
 * download-manager — Promise 优先的浏览器下载队列库。
 *
 * @example
 * ```ts
 * const manager = new DownloadManager({ concurrency: 3 });
 * const blob = await manager.download('/files/a.pdf', {
 *   signal: controller.signal,
 *   onProgress: ({ percent }) => console.log(percent),
 * });
 * ```
 *
 * @packageDocumentation
 */
import { browserAdapter } from './adapters/browserAdapter.js';
import { saveBlob } from './adapters/saveBlob.js';
import { DownloadManager as CoreDownloadManager } from './core/DownloadManager.js';
import type {
  DownloadAdapter,
  DownloadOptions,
  ManagerOptions,
} from './core/types.js';

export { VERSION } from './version.js';

export {
  DownloadError,
  createAbortError,
  isAbortError,
} from './core/errors.js';

export { TypedEmitter } from './core/TypedEmitter.js';

export { browserAdapter } from './adapters/browserAdapter.js';
export { saveBlob } from './adapters/saveBlob.js';

/**
 * DownloadManager 构造选项：适配器可省略，省略时默认使用浏览器 fetch 适配器。
 *
 * @typeParam TResult - 下载结果类型（默认 Blob；自定义适配器时显式指定）。
 * @typeParam TOptions - 适配器支持的任务选项类型。
 */
export type DownloadManagerInit<
  TResult = Blob,
  TOptions extends DownloadOptions = DownloadOptions,
> = Omit<ManagerOptions<TResult, TOptions>, 'adapter'> & {
  /** 自定义下载适配器；省略时使用 {@link browserAdapter}。 */
  adapter?: DownloadAdapter<TResult, TOptions>;
};

/**
 * 下载队列管理器。
 *
 * 默认通过 fetch 适配器返回 `Promise<Blob>`；需要自定义平台/协议时，
 * 显式传入实现 {@link DownloadAdapter} 的适配器。
 *
 * @typeParam TResult - 下载结果类型（默认 Blob）。
 * @typeParam TOptions - 适配器任务选项类型。
 */
export class DownloadManager<
  TResult = Blob,
  TOptions extends DownloadOptions = DownloadOptions,
> extends CoreDownloadManager<TResult, TOptions> {
  /**
   * @param options - 队列选项（concurrency/maxRetries/retryDelay/adapter）。
   */
  constructor(options: DownloadManagerInit<TResult, TOptions> = {}) {
    super({
      ...options,
      // 未显式注入适配器时使用官方浏览器适配器。默认泛型即 Blob/DownloadOptions；
      // 使用自定义适配器（其他 TResult 类型）时必须显式提供 adapter。
      adapter:
        options.adapter ??
        (browserAdapter as unknown as DownloadAdapter<TResult, TOptions>),
    });
  }
}

export type {
  AdapterContext,
  AdapterProgressCallback,
  DownloadAdapter,
  DownloadOptions,
  DownloadErrorView,
  ManagerEventMap,
  ManagerOptions,
  Priority,
  ProgressEvent,
  ProgressInfo,
  QueueStats,
  QueueUpdateEvent,
  RetryInfo,
  TaskId,
  TaskSnapshot,
  TaskState,
} from './core/types.js';
