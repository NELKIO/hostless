/**
 * Key-value storage that never throws: localStorage when it works, nothing otherwise. Private
 * windows, disabled site data, quota errors and sandboxed iframes all just make writes return false.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export function defaultStorage(): StorageLike | null {
  try {
    const s = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (!s) return null;
    const probe = '__hostless_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export class SafeStore {
  constructor(readonly storage: StorageLike | null) {}

  get available(): boolean {
    return this.storage !== null;
  }

  get(key: string): string | null {
    try {
      return this.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  getJson<T = unknown>(key: string): T | null {
    const text = this.get(key);
    if (text === null) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  set(key: string, value: string): boolean {
    if (!this.storage) return false;
    try {
      this.storage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  setJson(key: string, value: unknown): boolean {
    let text: string;
    try {
      text = JSON.stringify(value);
    } catch {
      return false;
    }
    return this.set(key, text);
  }

  remove(key: string): boolean {
    if (!this.storage) return false;
    try {
      this.storage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }

  keys(prefix = ''): string[] {
    const out: string[] = [];
    if (!this.storage) return out;
    try {
      for (let i = 0; i < this.storage.length; i++) {
        const k = this.storage.key(i);
        if (k !== null && k.startsWith(prefix)) out.push(k);
      }
    } catch {
      /* ignore */
    }
    return out;
  }
}

/** A Map-backed StorageLike (tests, or volatile mode). Can be told to start failing. */
export class MemoryStorage implements StorageLike {
  private map = new Map<string, string>();
  failWrites = false;
  failReads = false;
  quota = Infinity;

  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    if (this.failReads) throw new Error('SecurityError');
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError');
    let size = value.length;
    for (const [k, v] of this.map) if (k !== key) size += v.length;
    if (size > this.quota) throw new Error('QuotaExceededError');
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    if (this.failWrites) throw new Error('SecurityError');
    this.map.delete(key);
  }
}
