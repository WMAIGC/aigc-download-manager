/**
 * download-manager 公开类型定义。
 *
 * 设计约定：
 * - 任务结果只从 `manager.download()` 返回的 Promise 出口传递；
 * - 进度/重试是可选回调侧信道；
 * - 事件仅用于队列级观察，不承载任务结果。
 */

/** 任务生命周期状态。 */
export type TaskState = 'queued' | 'active' | 'completed' | 'failed' | 'canceled';

/** 不透明任务 id，仅用于快照与事件载荷，不应用于控制任务。 */
export type TaskId = string;

/** 优先级：数值越大越优先；默认 0。 */
export type Priority = number;

/**
 * 任务进度信息。
 *
 * 当服务器未提供 content-length（或无法获知总字节）时，
 * {@link ProgressInfo.total} 与 {@link ProgressInfo.percent} 为 `null`。
 */
export interface ProgressInfo {
  /** 已接收字节数（单调递增）。 */
  loaded: number;
  /** 总字节数；未知时为 `null`。 */
  total: number | null;
  /** 完成百分比 0-100（末次为 100）；总字节未知时为 `null`。 */
  percent: number | null;
}

/** 第 N 次重试的通知信息（经 `options.onRetry` 回调）。 */
export interface RetryInfo {
  /** 第几次重试，从 1 开始（首次失败后的重试为 1）。 */
  attempt: number;
  /** 允许的最大重试次数。 */
  maxRetries: number;
  /** 本次重试开始前的等待毫秒数。 */
  delay: number;
  /** 触发本次重试的错误。 */
  error: unknown;
}

/**
 * download() 的任务选项。
 *
 * 适配器可通过泛型扩展该接口以声明自己的额外选项（见 {@link DownloadAdapter}）。
 */
export interface DownloadOptions {
  /** 优先级，数值越大越先出队；默认 0。 */
  priority?: Priority;
  /** 最大自动重试次数，覆盖管理器全局配置；默认 2。 */
  maxRetries?: number;
  /** 重试基础退避毫秒数（实际退避 = retryDelay × 2^(attempt-1)），覆盖全局配置；默认 1000。 */
  retryDelay?: number;
  /** 自定义请求头（透传给适配器）。 */
  headers?: HeadersInit;
  /** 外部取消信号：abort 后任务以 AbortError 拒绝，与 fetch 行为一致。 */
  signal?: AbortSignal;
  /** 进度回调（可选侧信道）；回调抛错会被隔离，不影响下载。 */
  onProgress?: (info: ProgressInfo) => void;
  /** 重试回调（可选侧信道）；回调抛错会被隔离，不影响重试。 */
  onRetry?: (info: RetryInfo) => void;
  /** （浏览器适配器）下载完成后自动触发浏览器保存。 */
  autoSave?: boolean;
  /** （浏览器适配器）autoSave 使用的文件名。 */
  filename?: string;
}

/**
 * 适配器执行上下文。
 *
 * @typeParam TOptions - 当前任务的选项类型。
 */
export interface AdapterContext<TOptions extends DownloadOptions = DownloadOptions> {
  /** 不透明任务 id。 */
  readonly id: TaskId;
  /** 下载地址。 */
  readonly url: string;
  /** 该任务的归一化选项（已合并管理器默认值）。 */
  readonly options: Readonly<TOptions>;
}

/**
 * 适配器上报进度的回调签名。
 *
 * 适配器只需汇报原始字节数；总字节未知时传 `null`，百分比由核心计算。
 */
export type AdapterProgressCallback = (
  loaded: number,
  total: number | null,
) => void;

/**
 * 下载适配器：队列核心与实际下载执行之间的唯一边界。
 *
 * 实现方只需：
 * 1. 根据上下文发起下载；
 * 2. 在收到数据时调用 `onProgress`；
 * 3. 响应 `signal` 中止；
 * 4. 成功 resolve 结果，失败 reject（取消时 reject `name === 'AbortError'` 的错误）。
 *
 * 核心不直接依赖 fetch/DOM 等任何平台 API。
 *
 * @typeParam TResult - 下载成功的结果类型（官方浏览器适配器为 `Blob`）。
 * @typeParam TOptions - 该适配器支持的任务选项类型。
 */
export interface DownloadAdapter<
  TResult = unknown,
  TOptions extends DownloadOptions = DownloadOptions,
> {
  /**
   * 执行一次下载尝试（重试时核心会再次调用本方法）。
   *
   * @param context - 任务上下文（id、url、options）。
   * @param signal - 核心下发的取消信号；外部 signal 与 clear() 最终都会汇聚到它。
   * @param onProgress - 原始字节进度回调。
   * @returns 下载结果。
   */
  execute(
    context: AdapterContext<TOptions>,
    signal: AbortSignal,
    onProgress: AdapterProgressCallback,
  ): Promise<TResult>;
}

/**
 * 任务只读快照（{@link DownloadManager.getTasks} 返回值元素）。
 *
 * 为纯数据副本，修改快照不会影响管理器内部状态。
 *
 * @typeParam TResult - 下载结果类型。
 */
export interface TaskSnapshot<TResult = unknown> {
  /** 不透明任务 id。 */
  readonly id: TaskId;
  /** 下载地址。 */
  readonly url: string;
  /** 当前状态。 */
  readonly state: TaskState;
  /** 优先级。 */
  readonly priority: Priority;
  /** 最新进度。 */
  readonly progress: ProgressInfo;
  /** 成功结果；未成功时为 `null`。 */
  readonly result: TResult | null;
  /** 失败/取消错误；无错误时为 `null`。 */
  readonly error: DownloadErrorView | null;
}

/**
 * 快照中错误的结构化视图（不要求是 {@link DownloadError} 实例，
 * 但字段稳定，可序列化展示）。
 */
export interface DownloadErrorView {
  /** 错误名（`'DownloadError'`、`'AbortError'` 等）。 */
  readonly name: string;
  /** 错误描述。 */
  readonly message: string;
  /** HTTP 状态码（如适用）。 */
  readonly status?: number;
}

/** 各状态任务计数快照。 */
export interface QueueStats {
  /** 等待出队数。 */
  readonly queued: number;
  /** 下载中数。 */
  readonly active: number;
  /** 成功完成数。 */
  readonly completed: number;
  /** 失败数。 */
  readonly failed: number;
  /** 已取消数。 */
  readonly canceled: number;
  /** 全部任务数（含已终态）。 */
  readonly total: number;
}

/**
 * DownloadManager 构造选项。
 *
 * @typeParam TResult - 适配器结果类型。
 * @typeParam TOptions - 适配器支持的任务选项类型。
 */
export interface ManagerOptions<
  TResult = unknown,
  TOptions extends DownloadOptions = DownloadOptions,
> {
  /** 同时下载数上限，正整数，默认 3。 */
  concurrency?: number;
  /** 全局最大重试次数，默认 2。 */
  maxRetries?: number;
  /** 全局重试基础退避毫秒数，默认 1000。 */
  retryDelay?: number;
  /** 下载适配器（队列核心通过它执行实际下载）。 */
  adapter: DownloadAdapter<TResult, TOptions>;
}

/** queueUpdate 事件载荷：任一任务状态迁移后触发。 */
export interface QueueUpdateEvent<TResult = unknown> {
  /** 迁移后最新的全量计数。 */
  readonly stats: QueueStats;
  /** 触发本次迁移的任务快照。 */
  readonly task: TaskSnapshot<TResult>;
}

/** progress 事件载荷：全任务进度广播。 */
export interface ProgressEvent {
  /** 产生进度的任务 id。 */
  readonly id: TaskId;
  /** 最新进度。 */
  readonly loaded: number;
  /** 总字节数；未知时为 `null`。 */
  readonly total: number | null;
  /** 完成百分比；未知时为 `null`。 */
  readonly percent: number | null;
}

/**
 * 管理器事件映射（事件白名单）。
 *
 * 刻意只保留队列观察所需的两个事件；
 * 任务成功/失败/取消/重试一律通过 Promise 或任务选项回调获取。
 */
export interface ManagerEventMap<TResult = unknown> {
  /** 任一任务状态迁移后触发。 */
  queueUpdate: QueueUpdateEvent<TResult>;
  /** 任一任务上报进度时广播。 */
  progress: ProgressEvent;
}
