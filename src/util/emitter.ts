/**
 * A small typed event emitter. A throwing listener never breaks the emitter or the other listeners:
 * the error is reported through `onListenerError` (console.error by default).
 */
export type Unsubscribe = () => void;

type Listener<A extends unknown[]> = (...args: A) => void;

export type EventMap = { [event: string]: unknown[] };

export let onListenerError: (error: unknown, event: string) => void = (error, event) => {
  // eslint-disable-next-line no-console
  console.error(`[hostless] listener for "${event}" threw`, error);
};

export function setListenerErrorHandler(handler: (error: unknown, event: string) => void): void {
  onListenerError = handler;
}

export class Emitter<E extends EventMap> {
  private listeners = new Map<keyof E, Set<Listener<any>>>();

  on<K extends keyof E>(event: K, listener: Listener<E[K]>): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => this.off(event, listener);
  }

  once<K extends keyof E>(event: K, listener: Listener<E[K]>): Unsubscribe {
    const off = this.on(event, ((...args: E[K]) => {
      off();
      listener(...args);
    }) as Listener<E[K]>);
    return off;
  }

  off<K extends keyof E>(event: K, listener: Listener<E[K]>): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(...args);
      } catch (error) {
        onListenerError(error, String(event));
      }
    }
  }

  /** Resolves with the arguments of the next `event`. */
  next<K extends keyof E>(event: K): Promise<E[K]> {
    return new Promise((resolve) => this.once(event, ((...args: E[K]) => resolve(args)) as Listener<E[K]>));
  }

  clear(): void {
    this.listeners.clear();
  }

  listenerCount(event: keyof E): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
