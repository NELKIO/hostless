/**
 * Replica: a shared document built from an op log, for co-op and shared-state games (everyone acts
 * at once, no turns). Every op is stamped {author, seq, lamport} and SIGNED by its author, so ops can
 * be relayed by anyone and nobody can forge another player's ops.
 *
 * Delivery is causal per author (a gap is buffered until the missing ops arrive); duplicates are
 * dropped. Two views:
 *   - `op` events in delivery order, for apps whose ops commute (counters, sets, "reveal cell 12");
 *   - `ordered()` / `fold()`: a total order by (lamport, author, seq), identical on every device, for
 *     apps whose ops do not commute; `fold` recomputes from the first out-of-order insertion only.
 * Anti-entropy: each replica sends its version vector every `syncMs`; a peer answers with the ops the
 * vector lacks.
 *
 * Own ops are committed to the seat journal (with the identity that signs them) before they are sent:
 * losing the journal also loses that identity, so a sequence number can never be reused. That is the
 * fix for the hexceed co-op bug where a reloaded tab re-issued seq N for a different op and the two
 * boards diverged forever.
 */
import { Emitter } from '../util/emitter.js';
import { realClock, type Clock } from '../util/timers.js';
import { isRecord } from '../util/stable-json.js';
import { verifyValue, isPeerId, type PeerId } from '../identity.js';
import type { Room, RoomMessage } from '../room/room.js';
import type { Seat } from '../storage/seats.js';

export const REPLICA_PROTOCOL = 1;

export interface Op<T = unknown> {
  /** author */
  a: PeerId;
  /** author sequence, from 1 */
  n: number;
  /** lamport clock */
  l: number;
  /** author wall clock (informational) */
  at: number;
  op: T;
  sig: string;
}

export type VersionVector = Record<PeerId, number>;

export interface ReplicaJournal<T = unknown> {
  v: 1;
  code: string;
  doc: string;
  ops: Op<T>[];
}

export interface ReplicaEvents<T> {
  [event: string]: unknown[];
  op: [op: Op<T>, info: { mine: boolean }];
  change: [];
  /** an authentic op failed validation: that author's later ops are ignored from now on */
  invalid: [info: { author: PeerId; n: number }];
  'storage-error': [];
}

export interface ReplicaOptions<T> {
  room: Room;
  /** several documents can share one room */
  doc?: string;
  channel?: string;
  seat?: Seat<ReplicaJournal<T>> | null;
  /** shape/permission check for ops from the network */
  validate?: (op: unknown, author: PeerId) => boolean;
  clock?: Clock;
  syncMs?: number;
  /** delay before own ops are flushed (batching) */
  batchMs?: number;
  maxOps?: number;
}

type Msg<T> = { v: number; t: 'ops'; doc: string; ops: Op<T>[] } | { v: number; t: 'vec'; doc: string; vec: VersionVector; reply?: boolean };

const MAX_BATCH = 150;

export class Replica<T = unknown> {
  readonly events = new Emitter<ReplicaEvents<T>>();
  readonly room: Room;
  readonly doc: string;
  private channelName: string;
  private journalSeat: Seat<ReplicaJournal<T>> | null;
  private validate: (op: unknown, author: PeerId) => boolean;
  private clock: Clock;
  private o: { syncMs: number; batchMs: number; maxOps: number };
  private byAuthor = new Map<PeerId, Op<T>[]>();
  private pending = new Map<PeerId, Map<number, Op<T>>>();
  /** authors whose log contains an authentic but invalid op (a cheater or an incompatible build) */
  private blocked = new Set<PeerId>();
  private log: Op<T>[] = [];
  private sorted: Op<T>[] = [];
  private lamport = 0;
  private outbox: Op<T>[] = [];
  private flushTimer: unknown = null;
  private saveTimer: unknown = null;
  private foldCache: { reducer: unknown; init: unknown; count: number; state: unknown } | null = null;
  private offs: Array<() => void> = [];
  private timer: unknown;

  constructor(opts: ReplicaOptions<T>) {
    this.room = opts.room;
    this.doc = opts.doc ?? 'main';
    this.channelName = opts.channel ?? 'rp';
    this.journalSeat = opts.seat ?? null;
    this.validate = opts.validate ?? (() => true);
    this.clock = opts.clock ?? realClock;
    this.o = { syncMs: opts.syncMs ?? 4000, batchMs: opts.batchMs ?? 30, maxOps: opts.maxOps ?? 100_000 };
    if (this.journalSeat && this.journalSeat.peerId !== this.room.peerId) throw new Error('hostless: the seat identity must be the room identity');
    const j = this.journalSeat?.journal;
    if (j && j.v === 1 && j.code === this.room.code && j.doc === this.doc && Array.isArray(j.ops)) this.ingest(j.ops, false);
    const ch = this.room.channel<Msg<T>>(this.channelName);
    this.offs.push(
      ch.on((m: RoomMessage<Msg<T>>) => this.receive(m.peer, m.data)),
      this.room.on('peer-join', (p) => this.sendVec(p.id)),
      this.room.on('peer-restart', (p) => this.sendVec(p.id)),
      this.room.on('peer-back', (p) => this.sendVec(p.id)),
    );
    this.timer = this.clock.setInterval(() => this.sendVec(), this.o.syncMs);
  }

  // ---------------------------------------------------------------- queries

  /** ops in the order this replica applied them */
  ops(): Op<T>[] {
    return this.log.slice();
  }

  /** ops in the total order shared by every replica */
  ordered(): Op<T>[] {
    return this.sorted.slice();
  }

  get size(): number {
    return this.log.length;
  }

  vector(): VersionVector {
    const v: VersionVector = {};
    for (const [a, list] of this.byAuthor) v[a] = list.length;
    return v;
  }

  /** does `vec` hold every op this replica holds? */
  covers(vec: VersionVector): boolean {
    for (const [a, list] of this.byAuthor) if ((vec[a] ?? 0) < list.length) return false;
    return true;
  }

  /**
   * Reduce the ops in total order. Cached: a new op appended at the end costs one reducer call; an op
   * that lands earlier in the order recomputes from scratch.
   */
  fold<S>(reducer: (state: S, op: Op<T>) => S, init: S): S {
    const c = this.foldCache;
    if (c && c.reducer === reducer && c.init === init && c.count <= this.sorted.length) {
      let state = c.state as S;
      for (let i = c.count; i < this.sorted.length; i++) state = reducer(state, this.sorted[i]);
      this.foldCache = { reducer, init, count: this.sorted.length, state };
      return state;
    }
    let state = init;
    for (const op of this.sorted) state = reducer(state, op);
    this.foldCache = { reducer, init, count: this.sorted.length, state };
    return state;
  }

  // ---------------------------------------------------------------- local ops

  /** Add an op of ours. null: it could not be stored safely, so it was not applied or sent. */
  push(op: T): Op<T> | null {
    const me = this.room.peerId;
    const n = (this.byAuthor.get(me)?.length ?? 0) + 1;
    const l = this.lamport + 1;
    const at = this.clock.now();
    const stamped: Op<T> = { a: me, n, l, at, op, sig: this.room.identity.signValue({ doc: this.doc, a: me, n, l, at, op }) };
    if (this.journalSeat && !this.journalSeat.commit(this.journal([...this.log, stamped]))) {
      this.events.emit('storage-error');
      return null;
    }
    this.accept(stamped);
    this.events.emit('op', stamped, { mine: true });
    this.events.emit('change');
    this.outbox.push(stamped);
    if (!this.flushTimer) this.flushTimer = this.clock.setTimeout(() => this.flush(), this.o.batchMs);
    return stamped;
  }

  private flush(): void {
    this.flushTimer = null;
    while (this.outbox.length) {
      const batch = this.outbox.splice(0, MAX_BATCH);
      this.room.broadcast({ v: REPLICA_PROTOCOL, t: 'ops', doc: this.doc, ops: batch } satisfies Msg<T>, { channel: this.channelName });
    }
  }

  // ---------------------------------------------------------------- state

  private journal(ops: Op<T>[] = this.log): ReplicaJournal<T> {
    return { v: 1, code: this.room.code, doc: this.doc, ops };
  }

  private scheduleSave(): void {
    if (!this.journalSeat || this.saveTimer) return;
    this.saveTimer = this.clock.setTimeout(() => {
      this.saveTimer = null;
      this.journalSeat?.save(this.journal());
    }, 300);
  }

  private accept(op: Op<T>): void {
    let list = this.byAuthor.get(op.a);
    if (!list) this.byAuthor.set(op.a, (list = []));
    list.push(op);
    this.log.push(op);
    this.lamport = Math.max(this.lamport, op.l);
    // insert into the total order
    const key = (x: Op<T>) => [x.l, x.a, x.n] as const;
    const k = key(op);
    let lo = 0;
    let hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const m = key(this.sorted[mid]);
      const less = m[0] < k[0] || (m[0] === k[0] && (m[1] < k[1] || (m[1] === k[1] && m[2] < k[2])));
      if (less) lo = mid + 1;
      else hi = mid;
    }
    this.sorted.splice(lo, 0, op);
    if (this.foldCache && lo < this.foldCache.count) this.foldCache = null;
  }

  private wellFormed(x: unknown): x is Op<T> {
    return (
      isRecord(x) &&
      isPeerId(x.a) &&
      Number.isSafeInteger(x.n) &&
      (x.n as number) >= 1 &&
      Number.isSafeInteger(x.l) &&
      (x.l as number) >= 1 &&
      Number.isSafeInteger(x.at) &&
      typeof x.sig === 'string' &&
      'op' in x
    );
  }

  /** Take ops from anywhere (network, journal); returns how many became applicable. */
  private ingest(list: unknown[], emit: boolean): number {
    const touched = new Set<PeerId>();
    for (const x of list) {
      if (!this.wellFormed(x) || this.blocked.has(x.a)) continue;
      const have = this.byAuthor.get(x.a)?.length ?? 0;
      if (x.n <= have) continue;
      let buf = this.pending.get(x.a);
      if (buf?.has(x.n)) continue;
      if (this.log.length + (buf?.size ?? 0) >= this.o.maxOps) break;
      // signature first: a forged op must never get a genuine author blocked
      if (!verifyValue(x.a, { doc: this.doc, a: x.a, n: x.n, l: x.l, at: x.at, op: x.op }, x.sig)) continue;
      if (!this.validate(x.op, x.a)) {
        this.blocked.add(x.a);
        this.pending.delete(x.a);
        touched.delete(x.a);
        if (emit) this.events.emit('invalid', { author: x.a, n: x.n });
        continue;
      }
      if (!buf) this.pending.set(x.a, (buf = new Map()));
      buf.set(x.n, { a: x.a, n: x.n, l: x.l, at: x.at, op: x.op, sig: x.sig });
      touched.add(x.a);
    }
    let applied = 0;
    for (const a of touched) {
      const buf = this.pending.get(a)!;
      for (let next = (this.byAuthor.get(a)?.length ?? 0) + 1; buf.has(next); next++) {
        const op = buf.get(next)!;
        buf.delete(next);
        this.accept(op);
        applied++;
        if (emit) this.events.emit('op', op, { mine: op.a === this.room.peerId });
      }
      if (!buf.size) this.pending.delete(a);
    }
    return applied;
  }

  /** ops wait for a missing earlier op of their author */
  get hasGaps(): boolean {
    return this.pending.size > 0;
  }

  // ---------------------------------------------------------------- network

  private sendVec(peer?: PeerId, reply = false): void {
    const msg: Msg<T> = { v: REPLICA_PROTOCOL, t: 'vec', doc: this.doc, vec: this.vector(), ...(reply ? { reply } : {}) };
    if (peer) this.room.send(peer, msg, { channel: this.channelName });
    else this.room.broadcast(msg, { channel: this.channelName });
  }

  private receive(peer: PeerId, raw: unknown): void {
    if (!isRecord(raw) || raw.v !== REPLICA_PROTOCOL || raw.doc !== this.doc) return;
    if (raw.t === 'ops' && Array.isArray(raw.ops)) {
      const applied = this.ingest(raw.ops.slice(0, MAX_BATCH * 4), true);
      if (applied) {
        this.scheduleSave();
        this.events.emit('change');
      }
      if (this.hasGaps) this.sendVec(peer);
    } else if (raw.t === 'vec' && isRecord(raw.vec)) {
      const vec = raw.vec as VersionVector;
      const missing: Op<T>[] = [];
      for (const [a, list] of this.byAuthor) {
        const n = Number.isSafeInteger(vec[a]) ? Math.max(0, vec[a]) : 0;
        for (let k = n; k < list.length; k++) missing.push(list[k]);
      }
      for (let i = 0; i < missing.length; i += MAX_BATCH) {
        this.room.send(peer, { v: REPLICA_PROTOCOL, t: 'ops', doc: this.doc, ops: missing.slice(i, i + MAX_BATCH) } satisfies Msg<T>, { channel: this.channelName });
      }
      // they hold ops we lack: ask (once; a reply never asks back)
      if (!raw.reply) {
        const mine = this.vector();
        if (Object.entries(vec).some(([a, n]) => Number.isSafeInteger(n) && n > (mine[a] ?? 0))) this.sendVec(peer, true);
      }
    }
  }

  on<K extends keyof ReplicaEvents<T>>(event: K, listener: (...args: ReplicaEvents<T>[K]) => void) {
    return this.events.on(event, listener);
  }

  destroy(): void {
    if (this.flushTimer) {
      this.clock.clearTimeout(this.flushTimer);
      this.flush();
    }
    if (this.saveTimer) {
      this.clock.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.journalSeat?.save(this.journal());
    }
    this.clock.clearInterval(this.timer);
    for (const off of this.offs) off();
    this.offs = [];
  }
}
