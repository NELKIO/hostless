/** Exponential backoff with ±15% jitter: base·2^n capped at `cap`. */
export function backoff(attempt: number, base = 2000, cap = 60_000, random: () => number = Math.random): number {
  const raw = Math.min(cap, base * 2 ** Math.max(0, Math.min(attempt, 30)));
  return Math.round(raw * (0.85 + random() * 0.3));
}

/** A bounded set that forgets its oldest members (insertion order). */
export class BoundedSet<T> {
  private items = new Set<T>();
  constructor(private readonly limit: number) {}
  has(value: T): boolean {
    return this.items.has(value);
  }
  /** false when already present */
  add(value: T): boolean {
    if (this.items.has(value)) return false;
    this.items.add(value);
    if (this.items.size > this.limit) this.items.delete(this.items.values().next().value as T);
    return true;
  }
  get size(): number {
    return this.items.size;
  }
  clear(): void {
    this.items.clear();
  }
}
