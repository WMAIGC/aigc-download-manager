/**
 * 官方浏览器下载适配器：fetch + ReadableStream 聚合 Blob。
 *
 * 行为：
 * - 2xx 响应通过流式读取分块累计字节并上报进度，聚合为 Blob（type 取 content-type）；
 * - 环境不提供 ReadableStream（response.body 为空）时回退 response.arrayBuffer()；
 * - 非 2xx 以携带 status 的 {@link DownloadError} 拒绝；
 * - signal 中止时取消 reader，统一以 name='AbortError' 拒绝；
 * - options.autoSave=true 时成功后自动调用 {@link saveBlob}。
 */
import {
  createAbortError,
  DownloadError,
  isAbortError,
} from '../core/errors.js';
import type {
  AdapterContext,
  AdapterProgressCallback,
  DownloadAdapter,
  DownloadOptions,
} from '../core/types.js';
import { saveBlob } from './saveBlob.js';

/**
 * 浏览器适配器单例：直接传入管理器或作为默认适配器使用。
 */
export const browserAdapter: DownloadAdapter<Blob, DownloadOptions> = {
  async execute(
    context: AdapterContext<DownloadOptions>,
    signal: AbortSignal,
    onProgress: AdapterProgressCallback,
  ): Promise<Blob> {
    const response = await sendRequest(context, signal);

    if (!response.ok) {
      throw new DownloadError(
        `HTTP ${response.status} ${response.statusText}`.trim(),
        { status: response.status },
      );
    }

    const mimeType = response.headers.get('content-type') ?? '';
    const total = parseTotal(response.headers.get('content-length'));
    const blob =
      response.body !== null
        ? await consumeStream(
            response.body,
            signal,
            onProgress,
            total,
            mimeType,
          )
        : await consumeAsArrayBuffer(response, onProgress, mimeType);

    if (context.options.autoSave === true) {
      saveBlob(blob, context.options.filename);
    }
    return blob;
  },
};

/**
 * 发起 fetch；网络层错误归一化（取消统一 AbortError，其余交由核心包装）。
 */
async function sendRequest(
  context: AdapterContext<DownloadOptions>,
  signal: AbortSignal,
): Promise<Response> {
  const init: RequestInit = { method: 'GET', signal };
  if (context.options.headers !== undefined) {
    init.headers = context.options.headers;
  }
  try {
    return await fetch(context.url, init);
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      throw createAbortError(error);
    }
    throw error;
  }
}

/**
 * 流式消费响应体：分块累计字节、上报进度，聚合为 Blob。
 */
async function consumeStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onProgress: AdapterProgressCallback,
  total: number | null,
  mimeType: string,
): Promise<Blob> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  // 主动响应外部中止：部分实现下 reader.read() 不会自行 reject，
  // 需显式 cancel 才能终止挂起的读取。
  const cancelOnAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancelOnAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
        loaded += value.byteLength;
        onProgress(loaded, total);
      }
      if (signal.aborted) {
        throw createAbortError();
      }
    }
    if (signal.aborted) {
      throw createAbortError();
    }
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      throw createAbortError(error);
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', cancelOnAbort);
    // 成功读完时 reader 已关闭；取消场景下确保流被释放。
    try {
      await reader.cancel();
    } catch {
      // reader 已关闭/已取消，忽略。
    }
  }

  // 合并为单一 ArrayBuffer 支撑的 Uint8Array：
  // 规避 TS lib 中 Uint8Array<ArrayBufferLike> 与 BlobPart 的不兼容，
  // 同时得到确定的连续缓冲。
  const merged: Uint8Array<ArrayBuffer> = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Blob([merged], { type: mimeType });
}

/**
 * 无流式响应体时的 arrayBuffer 兜底路径。
 */
async function consumeAsArrayBuffer(
  response: Response,
  onProgress: AdapterProgressCallback,
  mimeType: string,
): Promise<Blob> {
  const buffer = await response.arrayBuffer();
  onProgress(buffer.byteLength, buffer.byteLength);
  return new Blob([buffer], { type: mimeType });
}

/**
 * 解析 content-length：仅接受有限正整数，否则视为未知总量。
 */
function parseTotal(header: string | null): number | null {
  if (header === null) {
    return null;
  }
  const value = Number(header);
  return Number.isFinite(value) && value > 0 ? value : null;
}
