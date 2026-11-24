/**
 * State-based CRDT building blocks for DeviceSync documents. Every merger is a join: commutative,
 * associative and idempotent, so devices converge whatever the order, repetition or staleness of
 * syncs (property-tested in tests/unit/crdt.test.ts).
 *
 * The ledger is the locator's progress counter: per device, what that device added to each counter.
 * Only a device grows its own entry; merging takes the per-device maximum; the visible value is the
 * sum over devices. Progress made offline on two devices adds up, and a stale copy never counts twice.
 */
import { stableJson, isRecord } from '../util/stable-json.js';

/**
 * A join of two values. Either side may be `undefined` (the key is missing on that side); a merger
 * must then still normalise the other side, so the result never depends on which keys overlap.
 */
export type Merger<T> = (a: T, b: T) => T;

/** Deterministic tie-break: the larger stable JSON wins. A join over a total order. */
export function pickMax<T>(a: T, b: T): T {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const x = stableJson(a);
  const y = stableJson(b);
  return x >= y ? a : b;
}

export const max: Merger<number> = (a, b) => Math.max(a ?? -Infinity, b ?? -Infinity);
export const min: Merger<number> = (a, b) => Math.min(a ?? Infinity, b ?? Infinity);
export const or: Merger<boolean> = (a, b) => !!a || !!b;

/** Grow-only set as a sorted array of unique JSON values. */
export function union<T>(a: T[] = [], b: T[] = []): T[] {
  const seen = new Map<string, T>();
  for (const x of [...a, ...b]) seen.set(stableJson(x), x);
  return [...seen.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([, v]) => v);
}

/** Last-writer-wins register: the later `at` wins; equal times fall back to `pickMax`. */
export interface Lww<T> {
  at: number;
  value: T;
}

export function lww<T>(a: Lww<T> | undefined, b: Lww<T> | undefined): Lww<T> {
  if (!a) return b as Lww<T>;
  if (!b) return a;
  if (a.at !== b.at) return a.at > b.at ? a : b;
  return pickMax(a, b);
}

export const setLww = <T>(value: T, at: number = Date.now()): Lww<T> => ({ at, value });

/** Merge two records key by key with `inner` (called with `undefined` for a missing side). */
export function mapOf<T>(inner: Merger<T>): Merger<Record<string, T>> {
  return (a = {}, b = {}) => {
    const out: Record<string, T> = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)]).values()) out[k] = inner(a[k], b[k]);
    return sortKeys(out);
  };
}

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

/**
 * Merge objects field by field with a schema; fields outside the schema use `pickMax` (so a field
 * added by a newer version survives a merge by an older one).
 */
export function object<T extends Record<string, unknown>>(schema: { [K in keyof T]?: Merger<T[K]> }): Merger<T> {
  return (a, b) => {
    const out: Record<string, unknown> = {};
    const aa = (a ?? {}) as Record<string, unknown>;
    const bb = (b ?? {}) as Record<string, unknown>;
    for (const k of new Set([...Object.keys(aa), ...Object.keys(bb)])) {
      const m = (schema as Record<string, Merger<unknown> | undefined>)[k];
      out[k] = m ? m(aa[k], bb[k]) : pickMax(aa[k], bb[k]);
    }
    return sortKeys(out) as T;
  };
}

// ---------------------------------------------------------------- counters ledger

/** Nested numeric counters, e.g. { xp: 120, wins: 3, cards: { fries: [2, 40] } } (numbers or objects of numbers). */
export type Counters = { [key: string]: number | Counters };
/** device id → what that device added */
export type Ledger = Record<string, Counters>;

const isCounters = (x: unknown): x is Counters => isRecord(x);

/**
 * Combine two counter trees. Inputs are normalised first (zeros and empty objects removed), so an
 * empty object never meets a number; a non-empty object beats a number at the same key.
 */
function deep(a: Counters, b: Counters, op: (x: number, y: number) => number): Counters {
  return combine(compact(a), compact(b), op);
}

function combine(a: Counters, b: Counters, op: (x: number, y: number) => number): Counters {
  const out: Counters = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k];
    const y = b[k];
    if (isCounters(x) || isCounters(y)) out[k] = combine(isCounters(x) ? x : {}, isCounters(y) ? y : {}, op);
    else out[k] = op(typeof x === 'number' ? x : 0, typeof y === 'number' ? y : 0);
  }
  return compact(out);
}

/** drop zeros and empty objects: every device then holds a byte-identical ledger */
function compact(c: Counters): Counters {
  const out: Counters = {};
  for (const k of Object.keys(c).sort()) {
    const v = c[k];
    if (isCounters(v)) {
      const inner = compact(v);
      if (Object.keys(inner).length) out[k] = inner;
    } else if (typeof v === 'number' && Number.isFinite(v) && v !== 0) out[k] = v;
  }
  return out;
}

export const ledger = {
  /** per device, per counter maximum */
  merge(a: Ledger = {}, b: Ledger = {}): Ledger {
    const out = mapOf<Counters>((x, y) => deep(isCounters(x) ? x : {}, isCounters(y) ? y : {}, Math.max))(a, b);
    for (const k of Object.keys(out)) if (!Object.keys(out[k]).length) delete out[k];
    return out;
  },
  /** the sum over devices: the value to show */
  total(l: Ledger = {}): Counters {
    let sum: Counters = {};
    for (const entry of Object.values(l)) sum = deep(sum, entry, (x, y) => x + y);
    return sum;
  },
  /**
   * Record that this device's totals are now `totals`: its own entry becomes whatever the totals
   * hold beyond the other devices' entries (never shrinking, never negative).
   */
  record(l: Ledger = {}, device: string, totals: Counters): Ledger {
    let others: Counters = {};
    for (const [d, entry] of Object.entries(l)) if (d !== device) others = deep(others, entry, (x, y) => x + y);
    const beyond = deep(totals, others, (x, y) => Math.max(0, x - y));
    const own = deep(l[device] ?? {}, beyond, Math.max);
    const out = { ...l };
    if (Object.keys(own).length) out[device] = own;
    else delete out[device];
    return sortKeys(out);
  },
  /** what `devices` contributed (e.g. this browser's share for public statistics) */
  of(l: Ledger = {}, devices: string[]): Counters {
    let sum: Counters = {};
    for (const d of new Set(devices)) if (l[d]) sum = deep(sum, l[d], (x, y) => x + y);
    return sum;
  },
  /** keep at most `limit` devices: the ones with the largest entries (same choice on every device) */
  trim(l: Ledger, limit = 256): Ledger {
    const ids = Object.keys(l);
    if (ids.length <= limit) return l;
    const weight = (c: Counters): number => Object.values(c).reduce<number>((s, v) => s + (isCounters(v) ? weight(v) : Math.abs(v)), 0);
    const kept = ids.sort((x, y) => weight(l[y]) - weight(l[x]) || (x < y ? -1 : 1)).slice(0, limit);
    return sortKeys(Object.fromEntries(kept.map((k) => [k, l[k]])));
  },
};

/** A stable random id for this browser and app (persisted when storage works). */
export function deviceId(app: string, storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null): string {
  const key = `hostless:${app}:device`;
  let store = storage;
  if (store === undefined) {
    try {
      store = (globalThis as { localStorage?: typeof storage }).localStorage ?? null;
    } catch {
      store = null;
    }
  }
  try {
    const saved = store?.getItem(key);
    if (saved && /^[a-z0-9]{12,32}$/.test(saved)) return saved;
  } catch {
    /* ignore */
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const id = [...bytes].map((b) => (b % 36).toString(36)).join('');
  try {
    store?.setItem(key, id);
  } catch {
    /* volatile */
  }
  return id;
}
