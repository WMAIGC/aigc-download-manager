/**
 * 极简类型安全事件发射器。
 *
 * 仅提供 `on` / `off` 两个订阅方法（含一次性订阅 `once`），
 * 不引入任何运行时第三方依赖。事件名与载荷类型由泛型映射约束。
 *
 * @typeParam TEvents - 事件名到载荷类型的映射。
 */
export class TypedEmitter<TEvents extends object> {
  readonly #listeners = new Map<
    keyof TEvents,
    Set<(payload: TEvents[keyof TEvents]) => void>
  >();

  /**
   * 订阅事件。
   *
   * @param event - 事件名。
   * @param listener - 载荷回调。
   * @returns 当前发射器实例，便于链式订阅。
   */
  on<K extends keyof TEvents>(
    event: K,
    listener: (payload: TEvents[K]) => void,
  ): this {
    const set =
      this.#listeners.get(event) ??
      new Set<(payload: TEvents[keyof TEvents]) => void>();
    set.add(listener as (payload: TEvents[keyof TEvents]) => void);
    this.#listeners.set(event, set);
    return this;
  }

  /**
   * 订阅事件，触发一次后自动移除。
   *
   * @param event - 事件名。
   * @param listener - 载荷回调。
   * @returns 当前发射器实例。
   */
  once<K extends keyof TEvents>(
    event: K,
    listener: (payload: TEvents[K]) => void,
  ): this {
    const wrapper = (payload: TEvents[K]): void => {
      this.off(event, wrapper);
      listener(payload);
    };
    return this.on(event, wrapper);
  }

  /**
   * 移除订阅。
   *
   * @param event - 事件名。
   * @param listener - 与 {@link TypedEmitter.on} 相同的函数引用。
   * @returns 当前发射器实例。
   */
  off<K extends keyof TEvents>(
    event: K,
    listener: (payload: TEvents[K]) => void,
  ): this {
    this.#listeners
      .get(event)
      ?.delete(listener as (payload: TEvents[keyof TEvents]) => void);
    return this;
  }

  /**
   * 派发事件（同步调用全部监听器；单个监听器抛错不影响其余监听器）。
   *
   * @param event - 事件名。
   * @param payload - 事件载荷。
   */
  protected emit<K extends keyof TEvents>(
    event: K,
    payload: TEvents[K],
  ): void {
    const set = this.#listeners.get(event);
    if (!set) {
      return;
    }
    for (const listener of [...set]) {
      try {
        listener(payload);
      } catch {
        // 监听器异常隔离：事件订阅方的错误不得影响队列主流程。
      }
    }
  }
}
