/**
 * Seats: one player's place in one room on this browser. A seat holds the participant's signing
 * identity and the session journal (moves, ops, ...) so a reload, a crash or a closed tab resumes
 * the same match as the same player.
 *
 * Safety rules (from the locator's duel journal):
 * - a seat is exclusive to one tab (Web Lock); a second tab gets `null` and must not play;
 * - when the browser offers no lock, nothing is persisted (a persistent key shared by two tabs could
 *   sign two different moves for one turn): the seat is volatile and lives as long as the page;
 * - `commit()` is a write-ahead rule: once the identity is on disk, a journal entry that cannot be
 *   stored durably must not be acted upon (a reload would let the player choose again).
 */
import { Identity } from '../identity.js';
import { isRecord } from '../util/stable-json.js';
import { defaultStorage, SafeStore, type StorageLike } from './kv.js';
import { defaultLocks, tryLock, type LockManagerLike } from './locks.js';

export interface SeatOptions {
  app: string;
  room: string;
  role?: string;
  /** default localStorage; null: volatile only */
  storage?: StorageLike | null;
  /** default navigator.locks; null: no locking available */
  locks?: LockManagerLike | null;
  now?: () => number;
}

export interface SeatRecord<J = unknown> {
  v: 1;
  app: string;
  room: string;
  role: string;
  secret: string;
  journal: J | null;
  /** the session reached its end and its result was taken into account */
  settled: boolean;
  /** free-form app data (e.g. a display name, the room's meta) */
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface SeatSummary {
  room: string;
  role: string;
  peerId: string;
  settled: boolean;
  hasJournal: boolean;
  createdAt: number;
  updatedAt: number;
  data: Record<string, unknown>;
  persistent: boolean;
}

export type SaveResult = 'durable' | 'memory';

const VERSION = 1;
const prefixOf = (app: string) => `hostless:${app}:seat:`;
const keyOf = (app: string, room: string, role: string) => `${prefixOf(app)}${room}:${role}`;

/**
 * This page's seats that live in memory only, and the seats open here (a seat is never opened twice
 * by one page). Scoped per storage object, so tests can run several "browsers" in one process.
 */
interface Scope {
  volatile: Map<string, SeatRecord>;
  open: Set<string>;
}
const NO_STORAGE = {};
const scopes = new WeakMap<object, Scope>();
function scopeOf(storage: StorageLike | null): Scope {
  const k = storage ?? NO_STORAGE;
  let s = scopes.get(k);
  if (!s) scopes.set(k, (s = { volatile: new Map(), open: new Set() }));
  return s;
}

function validRecord(x: unknown, app: string, room: string, role: string): x is SeatRecord {
  return (
    isRecord(x) &&
    x.v === VERSION &&
    x.app === app &&
    x.room === room &&
    x.role === role &&
    Identity.isSecret(x.secret) &&
    typeof x.settled === 'boolean' &&
    isRecord(x.data) &&
    Number.isSafeInteger(x.createdAt) &&
    Number.isSafeInteger(x.updatedAt)
  );
}

export class Seat<J = unknown> {
  readonly identity: Identity;
  private rec: SeatRecord<J>;
  private durableIdentity: boolean;
  private released = false;
  private failing = false;

  /** use `openSeat()` */
  constructor(
    readonly key: string,
    rec: SeatRecord<J>,
    private store: SafeStore,
    private persist: boolean,
    durable: boolean,
    private unlock: () => Promise<void>,
    private now: () => number,
    private scope: Scope,
  ) {
    this.rec = rec;
    this.identity = Identity.fromSecret(rec.secret);
    this.durableIdentity = durable;
  }

  get peerId(): string {
    return this.identity.peerId;
  }

  /** the seat survives a reload */
  get persistent(): boolean {
    return this.persist && this.durableIdentity && !this.failing;
  }

  get journal(): J | null {
    return this.rec.journal;
  }

  get settled(): boolean {
    return this.rec.settled;
  }

  get data(): Record<string, unknown> {
    return this.rec.data;
  }

  get record(): Readonly<SeatRecord<J>> {
    return this.rec;
  }

  private write(next: SeatRecord<J>): SaveResult {
    this.rec = next;
    if (!this.persist) {
      this.scope.volatile.set(this.key, next as SeatRecord);
      return 'memory';
    }
    if (this.store.setJson(this.key, next)) {
      this.failing = false;
      return 'durable';
    }
    // storage refused this write (quota, revoked permission): keep it in memory, refuse commits
    // while the identity is on disk, and try the disk again on the next write
    this.failing = true;
    this.scope.volatile.set(this.key, next as SeatRecord);
    return 'memory';
  }

  /** Store the journal (best effort). */
  save(journal: J | null, extra: { settled?: boolean; data?: Record<string, unknown> } = {}): SaveResult {
    if (this.released) return 'memory';
    return this.write({
      ...this.rec,
      journal,
      settled: extra.settled ?? this.rec.settled,
      data: extra.data ?? this.rec.data,
      updatedAt: this.now(),
    });
  }

  /**
   * Store the journal before acting on it. false: it could not be stored where the identity is
   * stored, so the caller must NOT send the move/op it describes.
   */
  commit(journal: J | null, extra: { settled?: boolean; data?: Record<string, unknown> } = {}): boolean {
    if (this.released) return false;
    const result = this.save(journal, extra);
    return result === 'durable' || !this.durableIdentity;
  }

  setData(data: Record<string, unknown>): SaveResult {
    return this.save(this.rec.journal, { data: { ...this.rec.data, ...data } });
  }

  /** Delete the seat (its identity and journal) for good. */
  remove(): Promise<void> {
    if (this.released) return Promise.resolve();
    this.store.remove(this.key);
    this.scope.volatile.delete(this.key);
    return this.release();
  }

  /** Let another tab (or a later page) open this seat; resolves once the lock is free. */
  release(): Promise<void> {
    if (this.released) return Promise.resolve();
    this.released = true;
    this.scope.open.delete(this.key);
    return this.unlock();
  }
}

/**
 * Open (or create) the seat for `role` in `room`. Resolves to null when another tab holds it.
 */
export async function openSeat<J = unknown>(opts: SeatOptions): Promise<Seat<J> | null> {
  const role = opts.role ?? 'player';
  const key = keyOf(opts.app, opts.room, role);
  const now = opts.now ?? Date.now;
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const scope = scopeOf(storage);
  if (scope.open.has(key)) return null;
  const store = new SafeStore(storage);
  const lock = await tryLock(opts.locks === undefined ? defaultLocks() : opts.locks, key);
  if (lock.status === 'busy') return null;
  if (scope.open.has(key)) {
    if (lock.status === 'held') lock.release();
    return null;
  }
  const persist = lock.status === 'held' && store.available;
  let rec: SeatRecord<J> | null = null;
  let durable = false;
  if (persist) {
    const disk = store.getJson(key);
    if (validRecord(disk, opts.app, opts.room, role)) {
      rec = disk as SeatRecord<J>;
      durable = true;
    }
  }
  if (!rec) {
    const mem = scope.volatile.get(key);
    if (mem && validRecord(mem, opts.app, opts.room, role)) rec = mem as SeatRecord<J>;
  }
  if (!rec) {
    const t = now();
    rec = { v: VERSION, app: opts.app, room: opts.room, role, secret: Identity.generate().exportSecret(), journal: null, settled: false, data: {}, createdAt: t, updatedAt: t };
  }
  if (persist && !durable) durable = store.setJson(key, rec);
  if (!persist || !durable) scope.volatile.set(key, rec as SeatRecord);
  scope.open.add(key);
  return new Seat<J>(key, rec, store, persist && durable, durable, lock.status === 'held' ? lock.release : () => Promise.resolve(), now, scope);
}

/** Every seat of `app` on this browser, newest first. */
export function listSeats(app: string, storage: StorageLike | null | undefined = undefined): SeatSummary[] {
  const resolved = storage === undefined ? defaultStorage() : storage;
  const store = new SafeStore(resolved);
  const volatile = scopeOf(resolved).volatile;
  const out = new Map<string, SeatSummary>();
  const add = (k: string, x: unknown, persistent: boolean) => {
    if (!isRecord(x) || typeof x.room !== 'string' || typeof x.role !== 'string') return;
    if (!validRecord(x, app, x.room, x.role)) return;
    out.set(k, {
      room: x.room,
      role: x.role,
      peerId: Identity.fromSecret(x.secret).peerId,
      settled: x.settled,
      hasJournal: x.journal !== null,
      createdAt: x.createdAt,
      updatedAt: x.updatedAt,
      data: x.data,
      persistent,
    });
  };
  for (const [k, rec] of volatile) if (k.startsWith(prefixOf(app))) add(k, rec, false);
  for (const k of store.keys(prefixOf(app))) add(k, store.getJson(k), true);
  return [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface PrunePolicy {
  /** settled seats are kept this long after their last change (default 1 day) */
  settledMs?: number;
  /** any seat untouched this long goes (default 7 days) */
  idleMs?: number;
  /** a seat that never got a journal goes after this long (default 1 hour) */
  emptyMs?: number;
}

/**
 * Remove old seats. Seats open in another tab are skipped (their lock is held).
 * Returns the removed rooms.
 */
export async function pruneSeats(
  app: string,
  { settledMs = 24 * 3600_000, idleMs = 7 * 24 * 3600_000, emptyMs = 3600_000 }: PrunePolicy = {},
  { storage, locks, now = Date.now }: { storage?: StorageLike | null; locks?: LockManagerLike | null; now?: () => number } = {},
): Promise<string[]> {
  const removed: string[] = [];
  const t = now();
  for (const s of listSeats(app, storage)) {
    const age = t - s.updatedAt;
    const stale = (s.settled && age > settledMs) || age > idleMs || (!s.hasJournal && t - s.createdAt > emptyMs);
    if (!stale) continue;
    const seat = await openSeat({ app, room: s.room, role: s.role, storage, locks, now });
    if (!seat) continue;
    await seat.remove();
    removed.push(s.room);
  }
  return removed;
}

/** test helper: forget this page's volatile and open seats for a storage */
export function resetSeats(storage: StorageLike | null = null): void {
  scopes.delete(storage ?? NO_STORAGE);
}
