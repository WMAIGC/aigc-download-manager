/**
 * 下载过程中产生的错误。
 *
 * - 普通失败：{@link DownloadError.name} 为 `'DownloadError'`，HTTP 失败时携带 {@link DownloadError.status}。
 * - 取消：使用 {@link createAbortError} 创建，{@link DownloadError.name} 固定为 `'AbortError'`，
 *   与 `fetch` 因 AbortSignal 中止时的行为保持一致。
 */
export class DownloadError extends Error {
  /** HTTP 状态码；非 HTTP 错误（如网络错误）时为 `undefined`。 */
  readonly status?: number;

  /**
   * @param message - 错误描述。
   * @param options - 可选错误元数据。
   * @param options.name - 错误名（默认 `'DownloadError'`，取消场景传 `'AbortError'`）。
   * @param options.status - HTTP 状态码。
   * @param options.cause - 原始错误。
   */
  constructor(
    message: string,
    options?: {
      name?: string;
      status?: number;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = options?.name ?? 'DownloadError';
    if (options?.status !== undefined) {
      this.status = options.status;
    }
    if (options?.cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        value: options.cause,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
  }
}

/**
 * 判断错误是否为取消导致的 AbortError（兼容原生 DOMException 与本库创建的错误）。
 *
 * @param error - 任意捕获到的值。
 * @returns 当且仅当错误对象（或其 cause 链上）`name === 'AbortError'` 时返回 true。
 */
export function isAbortError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (
    current !== null &&
    typeof current === 'object' &&
    !seen.has(current)
  ) {
    const named = current as { name?: unknown; cause?: unknown };
    if (named.name === 'AbortError') {
      return true;
    }
    seen.add(current);
    current = named.cause;
  }
  return false;
}

/**
 * 创建取消错误（`name === 'AbortError'`）。
 *
 * @param cause - 可选的底层中止原因。
 * @returns 与原生 abort 语义一致的错误实例。
 */
export function createAbortError(cause?: unknown): DownloadError {
  return new DownloadError('The operation was aborted', {
    name: 'AbortError',
    cause,
  });
}
