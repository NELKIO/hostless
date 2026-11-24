/**
 * Time is injected everywhere, so every layer can run on a manual clock in tests.
 */
export type TimerId = unknown;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerId;
  clearTimeout(id: TimerId): void;
  setInterval(fn: () => void, ms: number): TimerId;
  clearInterval(id: TimerId): void;
}

/** Node keeps the process alive for pending timers; library timers must not. */
function unref<T>(id: T): T {
  (id as { unref?: () => void } | null)?.unref?.();
  return id;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => unref(globalThis.setTimeout(fn, ms)),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => unref(globalThis.setInterval(fn, ms)),
  clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
};

interface ManualTimer {
  id: number;
  at: number;
  every: number | null;
  fn: () => void;
}

/**
 * A deterministic clock: timers fire only from `advance()` / `run()`, in time order (ties in
 * creation order). `advanceAsync` also lets promise callbacks run between timers.
 */
export class ManualClock implements Clock {
  private t: number;
  private seq = 0;
  private timers = new Map<number, ManualTimer>();

  constructor(start = 1_700_000_000_000) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): TimerId {
    const id = ++this.seq;
    this.timers.set(id, { id, at: this.t + Math.max(0, ms), every: null, fn });
    return id;
  }

  clearTimeout(id: TimerId): void {
    this.timers.delete(id as number);
  }

  setInterval(fn: () => void, ms: number): TimerId {
    const id = ++this.seq;
    const every = Math.max(1, ms);
    this.timers.set(id, { id, at: this.t + every, every, fn });
    return id;
  }

  clearInterval(id: TimerId): void {
    this.timers.delete(id as number);
  }

  get pending(): number {
    return this.timers.size;
  }

  private nextDue(limit: number): ManualTimer | null {
    let best: ManualTimer | null = null;
    for (const timer of this.timers.values()) {
      if (timer.at > limit) continue;
      if (!best || timer.at < best.at || (timer.at === best.at && timer.id < best.id)) best = timer;
    }
    return best;
  }

  private fire(timer: ManualTimer): void {
    this.t = Math.max(this.t, timer.at);
    if (timer.every === null) this.timers.delete(timer.id);
    else timer.at += timer.every;
    timer.fn();
  }

  /** Move time forward by `ms`, firing every timer that falls due on the way. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (let guard = 0; guard < 1_000_000; guard++) {
      const timer = this.nextDue(end);
      if (!timer) break;
      this.fire(timer);
    }
    this.t = end;
  }

  /** Like `advance`, but yields to pending promise callbacks after every fired timer. */
  async advanceAsync(ms: number, step = 0): Promise<void> {
    const end = this.t + ms;
    await flushMicrotasks();
    for (let guard = 0; guard < 1_000_000; guard++) {
      const limit = step > 0 ? Math.min(end, this.t + step) : end;
      const timer = this.nextDue(limit);
      if (!timer) {
        if (limit >= end) break;
        this.t = limit;
        await flushMicrotasks();
        continue;
      }
      this.fire(timer);
      await flushMicrotasks();
    }
    this.t = end;
    await flushMicrotasks();
  }
}

/** Let every queued promise callback (and the ones they queue) run. */
export async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
