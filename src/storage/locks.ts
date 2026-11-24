/**
 * Exclusive, tab-wide locks: the Web Locks API (`navigator.locks`) with `ifAvailable`, held until
 * released. A lock is what makes it safe to persist a signing key: two tabs that held the same key
 * could sign two different moves for the same turn.
 */
export interface LockManagerLike {
  request(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<void> | void): Promise<unknown>;
}

export function defaultLocks(): LockManagerLike | null {
  try {
    return ((globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks as LockManagerLike) ?? null;
  } catch {
    return null;
  }
}

/** `release()` resolves once the lock manager really let the lock go (it does so asynchronously). */
export type LockResult = { status: 'held'; release: () => Promise<void> } | { status: 'busy' } | { status: 'unsupported' };

const DENIED = ['SecurityError', 'NotAllowedError', 'NotSupportedError', 'InvalidStateError'];

export async function tryLock(locks: LockManagerLike | null, name: string): Promise<LockResult> {
  if (!locks) return { status: 'unsupported' };
  try {
    return await new Promise<LockResult>((resolve, reject) => {
      let settled: Promise<void> = Promise.resolve();
      const held = locks.request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve({ status: 'busy' });
          return;
        }
        let unlock!: () => void;
        const wait = new Promise<void>((done) => (unlock = done));
        resolve({
          status: 'held',
          release: () => {
            unlock();
            return settled;
          },
        });
        return wait;
      });
      settled = held.then(
        () => {},
        () => {},
      );
      held.catch(reject);
    });
  } catch (error) {
    if (DENIED.includes((error as { name?: string })?.name ?? '')) return { status: 'unsupported' };
    throw error;
  }
}

/** An in-process lock manager with Web Locks semantics (tests; or a stand-in that only guards this page). */
export class MemoryLocks implements LockManagerLike {
  private held = new Set<string>();
  async request(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<void> | void): Promise<unknown> {
    if (this.held.has(name)) {
      if (options.ifAvailable) return callback(null);
      throw new Error('MemoryLocks supports only ifAvailable');
    }
    this.held.add(name);
    try {
      return await callback({ name });
    } finally {
      this.held.delete(name);
    }
  }
  isHeld(name: string): boolean {
    return this.held.has(name);
  }
}
