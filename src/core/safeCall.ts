/**
 * 隔离调用用户回调：回调抛出的任何错误都被吞掉，
 * 保证业务侧回调缺陷不会影响下载队列主流程。
 *
 * @param fn - 可选回调。
 * @param args - 回调参数。
 */
export function safeCall<A extends readonly unknown[]>(
  fn: ((...args: A) => void) | undefined,
  ...args: A
): void {
  if (typeof fn !== 'function') {
    return;
  }
  try {
    fn(...args);
  } catch {
    // 刻意忽略：用户侧回调错误不得冒泡到调度器。
  }
}
