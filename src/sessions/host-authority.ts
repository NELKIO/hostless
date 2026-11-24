/**
 * HostAuthority: the host's page owns the state; everyone else sends requests and follows. For
 * games with hidden information, many players (2-16), or rules too expensive to run everywhere.
 *
 *   guest → host   join, req{id, action}
 *   host → all     act{seq, seat, kind, action, hash}   (kind: 'join' | 'leave' | 'act')
 *   host → guest   welcome{seat, seq, state}, ok{id, seq}, rej{id, reason}, snap{seq, state}
 *   host → all     host{seq, hash} heartbeat
 *
 * Guests apply every act to a shadow copy and compare its hash with the host's. A mismatch or a gap
 * asks for a snapshot. Seats are bound to identities, so a guest that reloads with the same seat
 * identity gets its seat back. The host persists the state after every act and resumes it.
 * Ported in spirit from influence-web `battleRoom.ts`.
 */
import { Emitter } from '../util/emitter.js';
import { realClock, type Clock } from '../util/timers.js';
import { randomHex } from '../util/bytes.js';
import { sha256Hex } from '../crypto/hash.js';
import { cloneJson, isRecord, stableJson } from '../util/stable-json.js';
import type { PeerId } from '../identity.js';
import type { Room, RoomMessage } from '../room/room.js';
import type { Seat } from '../storage/seats.js';

export const AUTHORITY_PROTOCOL = 1;

export interface AuthorityEngine<S, A = unknown> {
  /** the initial state (host only) */
  init(): S;
  /** a player takes `seat` (also replayed by guests) */
  join?(state: S, seat: number, meta: Record<string, unknown>): S;
  leave?(state: S, seat: number): S;
  /** next state, or null to reject; a string rejects with that reason */
  apply(state: S, seat: number, action: A): S | null | string;
  validateAction?(action: unknown): boolean;
  hash?(state: S): string;
}

export interface HostJournal<S = unknown> {
  v: 1;
  code: string;
  role: 'host' | 'guest';
  seq: number;
  state: S | null;
  seats: Record<PeerId, number>;
}

export interface AuthorityEvents<S, A> {
  [event: string]: unknown[];
  /** the state changed (host and guests) */
  state: [state: S, info: { seq: number; seat: number; kind: 'join' | 'leave' | 'act' | 'snapshot'; action?: A }];
  /** guest: our seat */
  seat: [seat: number];
  /** guest: a request of ours was refused */
  rejected: [info: { id: string; reason: string }];
  accepted: [info: { id: string; seq: number }];
  /** guest: the shadow state diverged and was replaced by a snapshot */
  desync: [info: { seq: number }];
  /** guest: the room is full */
  full: [];
  /** guest: the host appeared / went quiet */
  host: [info: { peer: PeerId | null; online: boolean }];
}

export interface HostAuthorityOptions<S, A> {
  room: Room;
  engine: AuthorityEngine<S, A>;
  role: 'host' | 'guest';
  /** guests: pin the host peer id (default: the first peer that announces itself as host) */
  host?: PeerId;
  maxSeats?: number;
  seat?: Seat<HostJournal<S>> | null;
  /** guest meta sent with join */
  meta?: Record<string, unknown>;
  channel?: string;
  clock?: Clock;
  heartbeatMs?: number;
}

type Msg<S, A> =
  | { v: number; t: 'host'; seq: number; hash: string }
  | { v: number; t: 'join'; meta: Record<string, unknown> }
  | { v: number; t: 'welcome'; seat: number; seq: number; state: S }
  | { v: number; t: 'full' }
  | { v: number; t: 'req'; id: string; action: A }
  | { v: number; t: 'ok'; id: string; seq: number }
  | { v: number; t: 'rej'; id: string; reason: string }
  | { v: number; t: 'act'; seq: number; seat: number; kind: 'join' | 'leave' | 'act'; action: unknown; meta?: Record<string, unknown>; hash: string }
  | { v: number; t: 'want'; seq: number }
  | { v: number; t: 'snap'; seq: number; state: S };

export class HostAuthority<S, A = unknown> {
  readonly events = new Emitter<AuthorityEvents<S, A>>();
  readonly room: Room;
  readonly isHost: boolean;
  private engine: AuthorityEngine<S, A>;
  private seatStore: Seat<HostJournal<S>> | null;
  private channelName: string;
  private clock: Clock;
  private maxSeats: number;
  private heartbeatMs: number;
  private meta: Record<string, unknown>;
  private _state: S | null = null;
  private seq = 0;
  /** host: seat of every peer that ever joined (stable across reloads) */
  private seatOf = new Map<PeerId, number>();
  /** host: recent request ids per peer (duplicates are answered, not re-applied) */
  private answered = new Map<PeerId, Map<string, Msg<S, A>>>();
  private hostPeer: PeerId | null;
  private hostSeen = 0;
  private hostOnline = false;
  private mySeat: number | null = null;
  private buffered = new Map<number, Extract<Msg<S, A>, { t: 'act' }>>();
  private gapSince = 0;
  private wantAt = 0;
  private joinAt = 0;
  private fullAt = 0;
  private outstanding = new Map<string, { action: A; at: number }>();
  private offs: Array<() => void> = [];
  private timer: unknown;

  constructor(opts: HostAuthorityOptions<S, A>) {
    this.room = opts.room;
    this.engine = opts.engine;
    this.isHost = opts.role === 'host';
    this.seatStore = opts.seat ?? null;
    this.channelName = opts.channel ?? 'ha';
    this.clock = opts.clock ?? realClock;
    this.maxSeats = opts.maxSeats ?? 16;
    this.heartbeatMs = opts.heartbeatMs ?? 3000;
    this.meta = opts.meta ?? {};
    this.hostPeer = opts.host ?? null;
    if (this.seatStore && this.seatStore.peerId !== this.room.peerId) throw new Error('hostless: the seat identity must be the room identity');
    const j = this.seatStore?.journal;
    if (j && j.v === 1 && j.code === this.room.code && j.role === opts.role) {
      this.seq = j.seq;
      this._state = j.state;
      for (const [p, s] of Object.entries(j.seats ?? {})) this.seatOf.set(p, s);
    }
    if (this.isHost) {
      if (this._state === null) {
        this._state = this.engine.init();
        this.seatOf.set(this.room.peerId, 0);
        if (this.engine.join) this._state = this.engine.join(this._state, 0, this.meta);
        this.persist();
      }
      this.mySeat = 0;
    } else if (j?.role === 'guest') {
      this.mySeat = j.seats?.[this.room.peerId] ?? null;
    }
    const ch = this.room.channel<Msg<S, A>>(this.channelName);
    this.offs.push(
      ch.on((m: RoomMessage<Msg<S, A>>) => this.receive(m.peer, m.data)),
      this.room.on('peer-join', (p) => this.onPeer(p.id)),
      this.room.on('peer-restart', (p) => this.onPeer(p.id)),
    );
    this.timer = this.clock.setInterval(() => this.tick(), 500);
    queueMicrotask(() => {
      if (this.isHost) this.heartbeat();
      else for (const p of this.room.getPeers()) this.onPeer(p.id);
    });
  }

  // ---------------------------------------------------------------- queries

  get state(): S | null {
    return this._state;
  }

  get seatNumber(): number | null {
    return this.mySeat;
  }

  get version(): number {
    return this.seq;
  }

  get host(): PeerId | null {
    return this.isHost ? this.room.peerId : this.hostPeer;
  }

  /** host: peer id → seat */
  get seats(): Record<PeerId, number> {
    return Object.fromEntries(this.seatOf);
  }

  private hashOf(state: S): string {
    return this.engine.hash ? this.engine.hash(state) : sha256Hex(stableJson(state)).slice(0, 24);
  }

  // ---------------------------------------------------------------- actions

  /**
   * Act. The host applies at once; a guest sends a request and the state changes when the host's
   * act comes back. Returns the request id (guest) or the new seq (host), or null if refused locally.
   */
  act(action: A): string | number | null {
    if (this.isHost) {
      const r = this.applyHost(this.room.peerId, 0, 'act', action);
      return typeof r === 'number' ? r : null;
    }
    if (this.mySeat === null || !this.hostPeer) return null;
    const id = randomHex(8);
    this.outstanding.set(id, { action, at: this.clock.now() });
    this.send(this.hostPeer, { v: AUTHORITY_PROTOCOL, t: 'req', id, action });
    return id;
  }

  /** host: free a seat (kick / player gone for good) */
  release(peer: PeerId): boolean {
    if (!this.isHost) return false;
    const seat = this.seatOf.get(peer);
    if (seat === undefined || seat === 0) return false;
    this.seatOf.delete(peer);
    if (this.engine.leave) this.commitAct(seat, 'leave', null, this.engine.leave(this._state as S, seat));
    else this.persist();
    return true;
  }

  // ---------------------------------------------------------------- host side

  private send(peer: PeerId, msg: Msg<S, A>): void {
    this.room.send(peer, msg, { channel: this.channelName });
  }

  private broadcast(msg: Msg<S, A>): void {
    this.room.broadcast(msg, { channel: this.channelName });
  }

  private persist(): void {
    this.seatStore?.save({ v: 1, code: this.room.code, role: this.isHost ? 'host' : 'guest', seq: this.seq, state: this._state, seats: this.isHost ? this.seats : this.mySeat === null ? {} : { [this.room.peerId]: this.mySeat } });
  }

  private heartbeat(peer?: PeerId): void {
    if (!this.isHost || this._state === null) return;
    const msg: Msg<S, A> = { v: AUTHORITY_PROTOCOL, t: 'host', seq: this.seq, hash: this.hashOf(this._state) };
    if (peer) this.send(peer, msg);
    else this.broadcast(msg);
  }

  private commitAct(seat: number, kind: 'join' | 'leave' | 'act', action: unknown, next: S, meta?: Record<string, unknown>): number {
    this._state = next;
    this.seq++;
    this.persist();
    this.broadcast({ v: AUTHORITY_PROTOCOL, t: 'act', seq: this.seq, seat, kind, action, ...(meta ? { meta } : {}), hash: this.hashOf(next) });
    this.events.emit('state', next, { seq: this.seq, seat, kind, action: action as A });
    return this.seq;
  }

  private applyHost(peer: PeerId, seat: number, kind: 'act', action: A): number | string {
    if (this.engine.validateAction && !this.engine.validateAction(action)) return 'invalid';
    let next: S | null | string;
    try {
      next = this.engine.apply(this._state as S, seat, action);
    } catch (error) {
      next = `error: ${String(error)}`;
    }
    if (next === null) return 'rejected';
    if (typeof next === 'string') return next;
    void peer;
    return this.commitAct(seat, kind, action, next);
  }

  private onJoin(peer: PeerId, meta: Record<string, unknown>): void {
    let seat = this.seatOf.get(peer);
    if (seat === undefined) {
      const taken = new Set(this.seatOf.values());
      if (taken.size >= this.maxSeats) {
        this.send(peer, { v: AUTHORITY_PROTOCOL, t: 'full' });
        return;
      }
      seat = 0;
      while (taken.has(seat)) seat++;
      this.seatOf.set(peer, seat);
      const next = this.engine.join ? this.engine.join(this._state as S, seat, meta) : (this._state as S);
      this.commitAct(seat, 'join', null, next, meta);
    }
    this.send(peer, { v: AUTHORITY_PROTOCOL, t: 'welcome', seat, seq: this.seq, state: this._state as S });
  }

  private onRequest(peer: PeerId, id: string, action: A): void {
    const seat = this.seatOf.get(peer);
    if (seat === undefined) return this.send(peer, { v: AUTHORITY_PROTOCOL, t: 'rej', id, reason: 'no seat' });
    let memo = this.answered.get(peer);
    if (!memo) this.answered.set(peer, (memo = new Map()));
    const prev = memo.get(id);
    if (prev) return this.send(peer, prev);
    const r = this.applyHost(peer, seat, 'act', action);
    const answer: Msg<S, A> = typeof r === 'number' ? { v: AUTHORITY_PROTOCOL, t: 'ok', id, seq: r } : { v: AUTHORITY_PROTOCOL, t: 'rej', id, reason: r };
    memo.set(id, answer);
    if (memo.size > 200) memo.delete(memo.keys().next().value as string);
    this.send(peer, answer);
  }

  // ---------------------------------------------------------------- guest side

  private onPeer(peer: PeerId): void {
    if (this.isHost) {
      this.heartbeat(peer);
      return;
    }
    if (peer === this.hostPeer) this.requestJoin(true);
  }

  private requestJoin(force = false): void {
    if (!this.hostPeer) return;
    const now = this.clock.now();
    if (!force && now - this.joinAt < (now - this.fullAt < 30_000 ? 10_000 : 2000)) return;
    this.joinAt = now;
    this.send(this.hostPeer, { v: AUTHORITY_PROTOCOL, t: 'join', meta: this.meta });
  }

  private setState(state: S, seq: number, info: { seat: number; kind: 'join' | 'leave' | 'act' | 'snapshot'; action?: A }): void {
    this._state = state;
    this.seq = seq;
    this.persist();
    this.events.emit('state', state, { seq, ...info });
  }

  private applyGuest(m: Extract<Msg<S, A>, { t: 'act' }>): boolean {
    const base = cloneJson(this._state) as S;
    let next: S | null | string;
    try {
      if (m.kind === 'join') next = this.engine.join ? this.engine.join(base, m.seat, m.meta ?? {}) : base;
      else if (m.kind === 'leave') next = this.engine.leave ? this.engine.leave(base, m.seat) : base;
      else next = this.engine.apply(base, m.seat, m.action as A);
    } catch {
      next = null;
    }
    if (next === null || typeof next === 'string' || this.hashOf(next) !== m.hash) {
      this.events.emit('desync', { seq: m.seq });
      this.want(true);
      return false;
    }
    this.setState(next, m.seq, { seat: m.seat, kind: m.kind, action: m.action as A });
    return true;
  }

  private want(force = false): void {
    if (!this.hostPeer) return;
    const now = this.clock.now();
    if (!force && now - this.wantAt < 1000) return;
    this.wantAt = now;
    this.send(this.hostPeer, { v: AUTHORITY_PROTOCOL, t: 'want', seq: this.seq });
  }

  private drainBuffer(): void {
    for (;;) {
      const next = this.buffered.get(this.seq + 1);
      if (!next) break;
      this.buffered.delete(next.seq);
      if (!this.applyGuest(next)) {
        this.buffered.clear();
        break;
      }
    }
    for (const k of this.buffered.keys()) if (k <= this.seq) this.buffered.delete(k);
    this.gapSince = this.buffered.size ? this.gapSince || this.clock.now() : 0;
  }

  // ---------------------------------------------------------------- receive

  private receive(peer: PeerId, raw: unknown): void {
    if (!isRecord(raw) || raw.v !== AUTHORITY_PROTOCOL || typeof raw.t !== 'string') return;
    const m = raw as unknown as Msg<S, A>;
    if (this.isHost) {
      switch (m.t) {
        case 'join':
          return this.onJoin(peer, isRecord(m.meta) ? m.meta : {});
        case 'req':
          if (typeof m.id === 'string' && m.id.length <= 32) this.onRequest(peer, m.id, m.action);
          return;
        case 'want':
          if (this.seatOf.has(peer)) this.send(peer, { v: AUTHORITY_PROTOCOL, t: 'snap', seq: this.seq, state: this._state as S });
          return;
        default:
          return;
      }
    }
    // guest
    if (m.t === 'host') {
      if (this.hostPeer === null) this.hostPeer = peer;
      if (peer !== this.hostPeer) return;
      this.hostSeen = this.clock.now();
      if (!this.hostOnline) {
        this.hostOnline = true;
        this.events.emit('host', { peer, online: true });
      }
      if (this.mySeat === null) this.requestJoin();
      else if (m.seq > this.seq || (m.seq === this.seq && this._state !== null && this.hashOf(this._state) !== m.hash)) this.want();
      else if (m.seq < this.seq) this.want(); // the host restarted from an older save
      return;
    }
    if (peer !== this.hostPeer) return;
    this.hostSeen = this.clock.now();
    switch (m.t) {
      case 'welcome':
        if (!Number.isSafeInteger(m.seat) || !Number.isSafeInteger(m.seq)) return;
        this.mySeat = m.seat;
        this.buffered.clear();
        this.setState(m.state, m.seq, { seat: m.seat, kind: 'snapshot' });
        this.events.emit('seat', m.seat);
        this.drainBuffer();
        return;
      case 'full':
        if (!this.fullAt) this.events.emit('full');
        this.fullAt = this.clock.now();
        return;
      case 'snap':
        if (!Number.isSafeInteger(m.seq)) return;
        this.buffered.clear();
        this.setState(m.state, m.seq, { seat: -1, kind: 'snapshot' });
        return;
      case 'act':
        if (!Number.isSafeInteger(m.seq) || this._state === null) return;
        if (m.seq <= this.seq) return;
        this.buffered.set(m.seq, m);
        if (this.buffered.size > 500) {
          this.buffered.clear();
          this.want(true);
          return;
        }
        this.drainBuffer();
        return;
      case 'ok':
        if (this.outstanding.delete(m.id)) this.events.emit('accepted', { id: m.id, seq: m.seq });
        return;
      case 'rej':
        if (this.outstanding.delete(m.id)) this.events.emit('rejected', { id: m.id, reason: String(m.reason) });
        return;
      default:
        return;
    }
  }

  // ---------------------------------------------------------------- timer

  private lastBeat = 0;

  private tick(): void {
    const now = this.clock.now();
    if (this.isHost) {
      if (now - this.lastBeat >= this.heartbeatMs) {
        this.lastBeat = now;
        this.heartbeat();
      }
      return;
    }
    if (this.hostOnline && now - this.hostSeen > this.heartbeatMs * 4) {
      this.hostOnline = false;
      this.events.emit('host', { peer: this.hostPeer, online: false });
    }
    if (this.hostPeer && this.mySeat === null) this.requestJoin();
    if (this.buffered.size && now - this.gapSince > 800) this.want();
    // requests the host never answered (e.g. it restarted): send them again; ids make it idempotent
    for (const [id, o] of this.outstanding) {
      if (now - o.at < 5000 || !this.hostPeer) continue;
      o.at = now;
      this.send(this.hostPeer, { v: AUTHORITY_PROTOCOL, t: 'req', id, action: o.action });
    }
  }

  on<K extends keyof AuthorityEvents<S, A>>(event: K, listener: (...args: AuthorityEvents<S, A>[K]) => void) {
    return this.events.on(event, listener);
  }

  destroy(): void {
    this.clock.clearInterval(this.timer);
    for (const off of this.offs) off();
    this.offs = [];
  }
}
