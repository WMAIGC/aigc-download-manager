/**
 * 平台无关的下载队列核心。
 *
 * 职责边界：
 * - 负责任务生命周期、FIFO/优先级调度、并发槽位、AbortSignal 联动、
 *   指数退避重试、进度归一化与队列统计；
 * - 不直接出现 fetch/DOM 等任何浏览器 API（实际下载由注入的适配器执行）。
 *
 * 结果契约：`download()` 返回原生 Promise，resolve 成功结果、
 * reject {@link DownloadError}（取消时 name 为 'AbortError'）。
 */
import {
  createAbortError,
  DownloadError,
  isAbortError,
} from './errors.js';
import { safeCall } from './safeCall.js';
import { TypedEmitter } from './TypedEmitter.js';
import type {
  AdapterContext,
  AdapterProgressCallback,
  DownloadAdapter,
  DownloadErrorView,
  DownloadOptions,
  ManagerEventMap,
  ManagerOptions,
  Priority,
  ProgressInfo,
  QueueStats,
  TaskId,
  TaskSnapshot,
  TaskState,
} from './types.js';

/** QueueStats 的可变版本（统计计数在聚合时需要自增）。 */
type MutableQueueStats = {
  -readonly [K in keyof QueueStats]: QueueStats[K];
};

/** 默认并发上限。 */
const DEFAULT_CONCURRENCY = 3;
/** 默认最大重试次数。 */
const DEFAULT_MAX_RETRIES = 2;
/** 默认重试基础退避（毫秒）。 */
const DEFAULT_RETRY_DELAY = 1000;

/** 合并默认值后的任务选项（内部使用）。 */
type ResolvedOptions<TOptions extends DownloadOptions> = Required<
  Pick<TOptions, 'priority' | 'maxRetries' | 'retryDelay'>
> &
  Omit<TOptions, 'priority' | 'maxRetries' | 'retryDelay'>;

/**
 * 内部任务记录（不对外暴露）。
 */
interface InternalTask<TResult, TOptions extends DownloadOptions> {
  readonly id: TaskId;
  /** 自增序号，保证同级 FIFO。 */
  readonly seq: number;
  readonly url: string;
  readonly options: ResolvedOptions<TOptions>;
  state: TaskState;
  readonly promise: Promise<TResult>;
  readonly resolve: (value: TResult) => void;
  readonly reject: (error: DownloadError) => void;
  /** 内部信号：外部 signal 与 clear() 最终都汇聚到该 controller。 */
  readonly controller: AbortController;
  /** 外部信号 abort 联动回调引用（终态时用于移除监听）。 */
  onExternalAbort: () => void;
  /** 已执行尝试次数。 */
  attempts: number;
  /** 重试等待定时器；非等待中为 null。 */
  retryTimer: ReturnType<typeof setTimeout> | null;
  progress: ProgressInfo;
  result: TResult | null;
  error: DownloadError | null;
}

/**
 * 下载队列管理器（核心，需注入适配器）。
 *
 * 浏览器场景请使用包入口提供的默认子类（默认注入 browserAdapter）；
 * 需要自定义适配器时可直接构造本类。
 *
 * @typeParam TResult - 适配器下载结果类型。
 * @typeParam TOptions - 适配器任务选项类型。
 */
export class DownloadManager<
  TResult = unknown,
  TOptions extends DownloadOptions = DownloadOptions,
> extends TypedEmitter<ManagerEventMap<TResult>> {
  readonly #adapter: DownloadAdapter<TResult, TOptions>;
  #concurrency: number;
  readonly #maxRetries: number;
  readonly #retryDelay: number;
  #seq = 0;

  /** 可被调度的排队任务（重试等待中的任务不在此列）。 */
  readonly #waiting: Array<InternalTask<TResult, TOptions>> = [];
  /** 重试退避等待中的任务。 */
  readonly #retrying = new Set<InternalTask<TResult, TOptions>>();
  /** 活动任务。 */
  readonly #active = new Set<InternalTask<TResult, TOptions>>();
  /** 全部任务注册表（含终态），保持插入顺序。 */
  readonly #registry = new Map<TaskId, InternalTask<TResult, TOptions>>();

  /**
   * @param options - 管理器选项（适配器必填）。
   */
  constructor(options: ManagerOptions<TResult, TOptions>) {
    super();
    this.#adapter = options.adapter;
    this.#concurrency = validateConcurrency(
      options.concurrency ?? DEFAULT_CONCURRENCY,
    );
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#retryDelay = options.retryDelay ?? DEFAULT_RETRY_DELAY;
  }

  /**
   * 添加一个下载任务并立即返回原生 Promise。
   *
   * 成功时 resolve 适配器结果；失败时 reject {@link DownloadError}；
   * 取消时 reject `name === 'AbortError'` 的错误。
   *
   * @param url - 下载地址。
   * @param options - 任务选项（signal、onProgress、priority 等）。
   * @returns 下载结果 Promise（不挂载任何额外字段）。
   */
  download(
    url: string,
    options?: TOptions,
  ): Promise<TResult> {
    if (typeof url !== 'string' || url.length === 0) {
      return Promise.reject(
        new DownloadError('download(): url must be a non-empty string'),
      );
    }

    // 预 abort：立即拒绝，绝不入队、不占槽位。
    if (options?.signal?.aborted) {
      return Promise.reject(createAbortError());
    }

    const seq = ++this.#seq;
    const id = `task-${seq}`;
    const controller = new AbortController();

    let resolveFn!: (value: TResult) => void;
    let rejectFn!: (error: DownloadError) => void;
    const promise = new Promise<TResult>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    const task: InternalTask<TResult, TOptions> = {
      id,
      seq,
      url,
      options: resolveOptions<TOptions>(
        options,
        this.#maxRetries,
        this.#retryDelay,
      ),
      state: 'queued',
      promise,
      resolve: resolveFn,
      reject: rejectFn,
      controller,
      onExternalAbort: () => undefined,
      attempts: 0,
      retryTimer: null,
      progress: { loaded: 0, total: null, percent: null },
      result: null,
      error: null,
    };

    // 外部信号联动：唯一的外部取消通路，终态后移除监听。
    const externalSignal = options?.signal;
    if (externalSignal) {
      task.onExternalAbort = (): void => this.#cancelTask(task);
      externalSignal.addEventListener('abort', task.onExternalAbort, {
        once: true,
      });
    }

    this.#registry.set(id, task);
    this.#waiting.push(task);
    this.#emitQueueUpdate(task);
    this.#pump();

    return promise;
  }

  /**
   * 中断全部 queued/active 任务（queued/重试等待立即结束，
   * active 经适配器响应 abort 后结束）。方法本身同步返回。
   */
  clear(): void {
    for (const task of [...this.#registry.values()]) {
      if (isTerminalState(task.state)) {
        continue;
      }
      this.#cancelTask(task);
    }
  }

  /**
   * 获取全部任务的只读快照（含已终态任务，按添加顺序）。
   *
   * @returns 快照数组（纯数据副本，可安全持有/修改）。
   */
  getTasks(): Array<TaskSnapshot<TResult>> {
    return [...this.#registry.values()].map((task) => this.#snapshot(task));
  }

  /**
   * 获取各状态任务计数快照。
   *
   * @returns 最新计数。
   */
  getStats(): QueueStats {
    return this.#computeStats();
  }

  /**
   * 动态调整并发上限。
   *
   * 调大立即补位；调小不中断活动任务，待其自然结束后生效。
   *
   * @param concurrency - 新的并发上限（正整数）。
   */
  setConcurrency(concurrency: number): void {
    this.#concurrency = validateConcurrency(concurrency);
    this.#pump();
  }

  // ── 内部实现 ────────────────────────────────────────────────

  /**
   * 调度泵：在并发槽允许时不断从等待队列取下一个任务执行。
   */
  #pump(): void {
    while (this.#active.size < this.#concurrency && this.#waiting.length > 0) {
      const task = this.#pickNext();
      if (!task) {
        return;
      }
      this.#start(task);
    }
  }

  /**
   * 选择下一个任务：priority 降序，同优先级按 seq 升序（FIFO）。
   *
   * 一期采用线性扫描 O(n)（n 为等待队列长度）；下载任务规模下足够，
   * 若未来等待队列显著增大，可将本方法替换为二叉堆而不影响其他逻辑
   * （唯一的出队选择点）。
   *
   * @returns 被选中的任务；等待队列为空时返回 undefined。
   */
  #pickNext(): InternalTask<TResult, TOptions> | undefined {
    let bestIndex = -1;
    let bestTask: InternalTask<TResult, TOptions> | undefined;
    for (let i = 0; i < this.#waiting.length; i += 1) {
      const candidate = this.#waiting[i];
      if (!candidate) {
        continue;
      }
      if (
        bestTask === undefined ||
        (candidate.options.priority ?? 0) >
          (bestTask.options.priority ?? 0)
      ) {
        bestTask = candidate;
        bestIndex = i;
      }
      // 同优先级不替换：遍历按数组顺序（即添加顺序），保留 FIFO。
    }
    if (bestIndex === -1) {
      return undefined;
    }
    const [picked] = this.#waiting.splice(bestIndex, 1);
    return picked;
  }

  #start(task: InternalTask<TResult, TOptions>): void {
    task.state = 'active';
    task.attempts += 1;
    this.#active.add(task);
    this.#emitQueueUpdate(task);

    const context: AdapterContext<TOptions> = {
      id: task.id,
      url: task.url,
      // 泛型交叉类型在严格函数下无法自动收窄为 Readonly<TOptions>，
      // 结构上必然包含 TOptions 全部字段，此处为安全转换。
      options: task.options as Readonly<TOptions>,
    };
    const onProgress: AdapterProgressCallback = (loaded, total): void => {
      this.#reportProgress(task, loaded, total);
    };

    this.#adapter
      .execute(context, task.controller.signal, onProgress)
      .then(
        (result) => {
          this.#handleSettled(task, result);
        },
        (error: unknown) => {
          this.#handleSettled(task, error, true);
        },
      );
  }

  #reportProgress(
    task: InternalTask<TResult, TOptions>,
    loaded: number,
    total: number | null,
  ): void {
    const safeTotal =
      typeof total === 'number' && Number.isFinite(total) && total > 0
        ? total
        : null;
    const percent =
      safeTotal === null
        ? null
        : Math.min(100, Math.max(0, Math.round((loaded / safeTotal) * 100)));

    task.progress = { loaded, total: safeTotal, percent };
    safeCall(task.options.onProgress, task.progress);
    this.emit('progress', {
      id: task.id,
      loaded,
      total: safeTotal,
      percent,
    });
  }

  #handleSettled(
    task: InternalTask<TResult, TOptions>,
    payload: TResult | unknown,
    isFailure = false,
  ): void {
    this.#active.delete(task);

    // 取消优先：无论适配器最终 resolve 还是 reject，只要内部信号已 abort，
    // 统一以 canceled + AbortError 终态结束（防御不合作的适配器）。
    if (task.controller.signal.aborted) {
      this.#finishCanceled(task);
      this.#pump();
      return;
    }

    if (!isFailure) {
      this.#finishCompleted(task, payload as TResult);
      this.#pump();
      return;
    }

    const error = normalizeError(payload);
    if (isAbortError(error)) {
      this.#finishCanceled(task);
      this.#pump();
      return;
    }

    const maxRetries = task.options.maxRetries ?? this.#maxRetries;
    if (task.attempts <= maxRetries) {
      this.#scheduleRetry(task, error);
      this.#pump();
      return;
    }

    this.#finishFailed(task, error);
    this.#pump();
  }

  #scheduleRetry(
    task: InternalTask<TResult, TOptions>,
    error: DownloadError,
  ): void {
    const attempt = task.attempts;
    const retryDelay = task.options.retryDelay ?? this.#retryDelay;
    const maxRetries = task.options.maxRetries ?? this.#maxRetries;
    const delay = retryDelay * Math.pow(2, attempt - 1);

    // 让出并发槽、回到 queued 语义（等待期间不可被调度）。
    task.state = 'queued';
    task.error = error;
    this.#retrying.add(task);
    this.#emitQueueUpdate(task);
    safeCall(task.options.onRetry, {
      attempt,
      maxRetries,
      delay,
      error,
    });

    task.retryTimer = setTimeout(() => {
      task.retryTimer = null;
      this.#retrying.delete(task);
      if (isTerminalState(task.state)) {
        // 等待期间被取消的极端竞态保护。
        return;
      }
      task.error = null;
      this.#waiting.push(task);
      this.#pump();
    }, delay);
  }

  #finishCompleted(
    task: InternalTask<TResult, TOptions>,
    result: TResult,
  ): void {
    task.state = 'completed';
    task.result = result;
    task.error = null;
    this.#detachExternalSignal(task);
    this.#emitQueueUpdate(task);
    task.resolve(result);
  }

  #finishFailed(
    task: InternalTask<TResult, TOptions>,
    error: DownloadError,
  ): void {
    task.state = 'failed';
    task.error = error;
    this.#detachExternalSignal(task);
    this.#emitQueueUpdate(task);
    task.reject(error);
  }

  #finishCanceled(task: InternalTask<TResult, TOptions>): void {
    if (isTerminalState(task.state)) {
      return;
    }
    if (task.retryTimer !== null) {
      clearTimeout(task.retryTimer);
      task.retryTimer = null;
    }
    this.#retrying.delete(task);
    removeFromArray(this.#waiting, task);

    task.state = 'canceled';
    const error = createAbortError(task.error ?? undefined);
    task.error = error;
    this.#detachExternalSignal(task);
    this.#emitQueueUpdate(task);
    task.reject(error);
  }

  /**
   * 取消入口（外部 signal 与 clear() 共用）：
   * - 活动任务：abort 内部信号，终态由适配器 settle 路径收口；
   * - 排队/重试等待任务：abort 后立即终态化（没有适配器会响应）。
   */
  #cancelTask(task: InternalTask<TResult, TOptions>): void {
    if (isTerminalState(task.state)) {
      return;
    }
    task.controller.abort();
    if (!this.#active.has(task)) {
      this.#finishCanceled(task);
      this.#pump();
    }
  }

  #detachExternalSignal(task: InternalTask<TResult, TOptions>): void {
    const externalSignal = task.options.signal;
    if (externalSignal) {
      externalSignal.removeEventListener('abort', task.onExternalAbort);
    }
  }

  #snapshot(task: InternalTask<TResult, TOptions>): TaskSnapshot<TResult> {
    const errorView: DownloadErrorView | null = task.error
      ? {
          name: task.error.name,
          message: task.error.message,
          ...(task.error.status !== undefined
            ? { status: task.error.status }
            : {}),
        }
      : null;
    return {
      id: task.id,
      url: task.url,
      state: task.state,
      priority: task.options.priority ?? 0,
      progress: { ...task.progress },
      result: task.result,
      error: errorView,
    };
  }

  #computeStats(): QueueStats {
    const stats: MutableQueueStats = {
      queued: this.#waiting.length + this.#retrying.size,
      active: this.#active.size,
      completed: 0,
      failed: 0,
      canceled: 0,
      total: this.#registry.size,
    };
    for (const task of this.#registry.values()) {
      if (task.state === 'completed') {
        stats.completed += 1;
      } else if (task.state === 'failed') {
        stats.failed += 1;
      } else if (task.state === 'canceled') {
        stats.canceled += 1;
      }
    }
    return stats;
  }

  #emitQueueUpdate(task: InternalTask<TResult, TOptions>): void {
    this.emit('queueUpdate', {
      stats: this.#computeStats(),
      task: this.#snapshot(task),
    });
  }
}

/**
 * 校验并发上限：必须是 ≥1 的整数。
 *
 * @param value - 待校验值。
 * @returns 校验通过的整数。
 */
function validateConcurrency(value: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1
  ) {
    throw new DownloadError(
      'concurrency must be a positive integer (>= 1)',
    );
  }
  return value;
}

/**
 * 合并任务选项与管理器默认值。
 */
function resolveOptions<TOptions extends DownloadOptions>(
  options: TOptions | undefined,
  defaultMaxRetries: number,
  defaultRetryDelay: number,
): ResolvedOptions<TOptions> {
  return {
    ...(options ?? ({} as TOptions)),
    priority: (options?.priority ?? 0) as Priority,
    maxRetries: options?.maxRetries ?? defaultMaxRetries,
    retryDelay: options?.retryDelay ?? defaultRetryDelay,
  };
}

/**
 * 将适配器拒绝的任意值归一化为 DownloadError。
 */
function normalizeError(error: unknown): DownloadError {
  if (error instanceof DownloadError) {
    return error;
  }
  if (isAbortError(error)) {
    return createAbortError(error);
  }
  if (error instanceof Error) {
    return new DownloadError(error.message, { cause: error });
  }
  return new DownloadError('Download failed', { cause: error });
}

function isTerminalState(state: TaskState): boolean {
  return (
    state === 'completed' || state === 'failed' || state === 'canceled'
  );
}

function removeFromArray<T>(array: Array<T>, item: T): void {
  const index = array.indexOf(item);
  if (index !== -1) {
    array.splice(index, 1);
  }
}
