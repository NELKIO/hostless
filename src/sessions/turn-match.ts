/**
 * TurnMatch: a turn-based match between 2..N seats, deterministic, verified by every device.
 *
 * Lobby: each player sends its lineup (team, deck, options...; opaque to the library) with a revision
 * number; the latest revision wins. When every seat is ready, the host (seat 0) starts: it picks a
 * match id, binds seats to peer ids, computes the initial state with the game's `setup` and signs the
 * match header. Every other seat recomputes the initial state itself and accepts the match only if
 * its own lineup is unchanged and the state signature matches (different rules = different builds:
 * the match stops with reason 'version').
 *
 * Moves are signed by their author, so any seat may relay the history. Every received move is
 * checked: it must be the author's turn, its signature must verify, and the game's `apply` must accept
 * it. Own moves are committed to the seat journal BEFORE they are sent (write-ahead): after a reload
 * the same seat continues from the same history and can never choose a turn twice.
 *
 * Silence: a seat whose page is gone is 'away' after `silentMs` and 'waiting' after `reconnectMs`;
 * the match waits for it (it may come back hours later from its saved seat). A finished match's
 * history is also left in the Nostr mailbox, so a player who returns after everyone left still gets
 * the verified result. Generalised from the locator's DuelRoom (protocol v5).
 */
import { Emitter } from '../util/emitter.js';
import { realClock, type Clock } from '../util/timers.js';
import { randomHex } from '../util/bytes.js';
import { sha256Hex } from '../crypto/hash.js';
import { isRecord, stableJson } from '../util/stable-json.js';
import { netlog } from '../util/log.js';
import { verifyValue, type PeerId } from '../identity.js';
import type { Room, RoomMessage } from '../room/room.js';
import type { Seat } from '../storage/seats.js';
import type { Mailbox } from '../mailbox.js';

export const TURN_PROTOCOL = 1;

export interface SetupContext {
  matchId: string;
  seats: PeerId[];
  /** 64 hex chars derived from the match id: deterministic randomness for the setup */
  seed: string;
}

export interface MatchResult {
  /** winning seat, null on a draw or no winner */
  winner: number | null;
  draw?: boolean;
  [extra: string]: unknown;
}

export interface TurnEngine<S, M = unknown, L = unknown> {
  /** is this a lineup the game accepts? (default: any JSON) */
  validateLineup?(lineup: unknown): boolean;
  /** shape check for a move from the network, before `apply` (default: any JSON) */
  validateMove?(move: unknown): boolean;
  /** the initial state; must be deterministic (use ctx.seed for randomness) */
  setup(lineups: L[], ctx: SetupContext): S;
  /** seat to move, or null when the game is over */
  turn(state: S): number | null;
  /** next state, or null when the move is illegal; must not mutate `state` */
  apply(state: S, seat: number, move: M): S | null;
  /** final result, or null while the game goes on */
  result(state: S): MatchResult | null;
  /** fingerprint of a state (default sha256 of its stable JSON) */
  signature?(state: S): string;
}

export interface Entry {
  /** seat */
  s: number;
  /** move */
  m: unknown;
  /** author signature over {id, i, s, m} */
  sig: string;
}

interface Header {
  id: string;
  seats: PeerId[];
  lineups: unknown[];
  sig: string;
  /** host signature over {id, seats, lineups, sig} */
  hs: string;
}

export interface TurnJournal {
  v: 1;
  code: string;
  role: 'host' | 'guest';
  rev: number;
  lineup: unknown;
  match: (Header & { history: Entry[] }) | null;
  stopped: StopReason | null;
  settled: boolean;
}

export type MatchPhase = 'lobby' | 'playing' | 'finished' | 'stopped';
export type StopReason = 'left' | 'quit' | 'timeout' | 'version';
export type SeatStatus = 'online' | 'away' | 'waiting';

export interface TurnMatchEvents {
  [event: string]: unknown[];
  /** anything visible changed */
  change: [];
  lobby: [lineups: Array<{ peer: PeerId; lineup: unknown; rev: number }>];
  start: [info: { matchId: string; seats: PeerId[]; mySeat: number }];
  move: [info: { index: number; seat: number; move: unknown; mine: boolean }];
  /** once per match (also after a reload, until `settle()` is called) */
  result: [result: MatchResult & { matchId: string; mySeat: number; settled: boolean }];
  stop: [info: { reason: StopReason; by: PeerId | null }];
  'seat-status': [info: { seat: number; peer: PeerId; status: SeatStatus }];
  /** a peer runs different game rules or protocol */
  incompatible: [info: { peer: PeerId; reason: string }];
  /** the history could not be stored durably: the move was not sent */
  'storage-error': [];
}

export interface TurnMatchOptions<S, M, L> {
  room: Room;
  engine: TurnEngine<S, M, L>;
  /** the room creator is the host (seat 0) */
  role: 'host' | 'guest';
  /** number of seats (default 2) */
  seats?: number;
  /** persistence; its identity must be the room's identity */
  seat?: Seat<TurnJournal> | null;
  mailbox?: Mailbox | null;
  channel?: string;
  clock?: Clock;
  silentMs?: number;
  reconnectMs?: number;
  headMs?: number;
}

interface Live<S> extends Header {
  history: Entry[];
  state: S;
  /** state after each prefix length, for cheap re-checks: [0] = initial */
  mySeat: number;
}

interface StateMsg extends Header {
  v: number;
  t: 'state';
  base: number;
  moves: Entry[];
  len: number;
}

type Msg =
  | { v: number; t: 'ready'; rev: number; lineup: unknown }
  | StateMsg
  | { v: number; t: 'head'; id: string | null; len: number; last: string }
  | { v: number; t: 'want'; id: string; from: number }
  | { v: number; t: 'stop'; id: string | null; reason: StopReason };

const MAX_HISTORY = 100_000;
const validMatchId = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{16,64}$/.test(x);

export class TurnMatch<S, M = unknown, L = unknown> {
  readonly events = new Emitter<TurnMatchEvents>();
  readonly room: Room;
  readonly isHost: boolean;
  readonly seatCount: number;
  private engine: TurnEngine<S, M, L>;
  private journalSeat: Seat<TurnJournal> | null;
  private mailbox: Mailbox | null;
  private channelName: string;
  private clock: Clock;
  private o: { silentMs: number; reconnectMs: number; headMs: number };
  private rev = 0;
  private lineup: L | null = null;
  private lobbyOf = new Map<PeerId, { rev: number; lineup: unknown }>();
  private match: Live<S> | null = null;
  private stopped: StopReason | null = null;
  private settledFlag = false;
  private resultSent = false;
  /** history length each seat is known to hold; -1: it does not have the match header yet */
  private known = new Map<PeerId, number>();
  private lastSeen = new Map<PeerId, number>();
  private status = new Map<PeerId, SeatStatus>();
  private lastHead = 0;
  private stored = false;
  private storeAttempts = 0;
  private nextStoreAt = 0;
  private lookupAt = new Map<PeerId, { next: number; delay: number }>();
  private offs: Array<() => void> = [];
  private timer: unknown;

  constructor(opts: TurnMatchOptions<S, M, L>) {
    this.room = opts.room;
    this.engine = opts.engine;
    this.isHost = opts.role === 'host';
    this.seatCount = Math.max(2, opts.seats ?? 2);
    this.journalSeat = opts.seat ?? null;
    this.mailbox = opts.mailbox ?? null;
    this.channelName = opts.channel ?? 'tm';
    this.clock = opts.clock ?? realClock;
    this.o = { silentMs: opts.silentMs ?? 12_000, reconnectMs: opts.reconnectMs ?? 25_000, headMs: opts.headMs ?? 4000 };
    if (this.journalSeat && this.journalSeat.peerId !== this.room.peerId) throw new Error('hostless: the seat identity must be the room identity');
    if (this.journalSeat?.journal) this.restore(this.journalSeat.journal);
    const ch = this.room.channel<Msg>(this.channelName);
    this.offs.push(
      ch.on((m: RoomMessage<Msg>) => this.receive(m.peer, m.data)),
      this.room.on('peer-join', (p) => this.greet(p.id, true)),
      this.room.on('peer-restart', (p) => this.greet(p.id, true)),
      this.room.on('peer-back', (p) => this.greet(p.id, false)),
      this.room.on('peer-leave', (p) => this.onLeave(p.id)),
    );
    this.timer = this.clock.setInterval(() => this.tick(), 1000);
    for (const p of this.room.getPeers()) this.greet(p.id, true);
    // a restored finished match reports its result again (until the app settles it)
    if (this.match) queueMicrotask(() => this.afterProgress());
  }

  // ---------------------------------------------------------------- queries

  get phase(): MatchPhase {
    if (this.match && this.engine.result(this.match.state)) return 'finished';
    if (this.stopped) return 'stopped';
    return this.match ? 'playing' : 'lobby';
  }

  get matchId(): string | null {
    return this.match?.id ?? null;
  }

  get state(): S | null {
    return this.match?.state ?? null;
  }

  get mySeat(): number | null {
    return this.match ? this.match.mySeat : null;
  }

  get seats(): PeerId[] {
    return this.match ? [...this.match.seats] : [];
  }

  get history(): Entry[] {
    return this.match ? [...this.match.history] : [];
  }

  get turn(): number | null {
    return this.match ? this.engine.turn(this.match.state) : null;
  }

  get myTurn(): boolean {
    return this.phase === 'playing' && this.turn === this.match!.mySeat;
  }

  get result(): MatchResult | null {
    return this.match ? this.engine.result(this.match.state) : null;
  }

  get stopReason(): StopReason | null {
    return this.stopped;
  }

  get settled(): boolean {
    return this.settledFlag;
  }

  get myLineup(): L | null {
    return this.lineup;
  }

  /** lineups announced by the other players in the lobby */
  get lobby(): Array<{ peer: PeerId; lineup: unknown; rev: number }> {
    return [...this.lobbyOf].map(([peer, v]) => ({ peer, ...v }));
  }

  seatStatus(seat: number): SeatStatus | null {
    const peer = this.match?.seats[seat];
    if (!peer) return null;
    if (peer === this.room.peerId) return 'online';
    return this.status.get(peer) ?? 'waiting';
  }

  /** every seat has confirmed it holds the whole history */
  get everyoneHasIt(): boolean {
    if (!this.match) return false;
    return this.match.seats.every((p) => p === this.room.peerId || (this.known.get(p) ?? -1) >= this.match!.history.length);
  }

  // ---------------------------------------------------------------- actions

  /** Announce (or withdraw with null) this player's lineup. Only in the lobby. */
  ready(lineup: L | null): boolean {
    if (this.match || this.stopped) return false;
    if (lineup !== null && this.engine.validateLineup && !this.engine.validateLineup(lineup)) return false;
    this.lineup = lineup;
    this.rev++;
    this.persist();
    this.sendAll({ v: TURN_PROTOCOL, t: 'ready', rev: this.rev, lineup });
    this.emit();
    this.tryStart();
    return true;
  }

  /** Make a move. false: not our turn, illegal, or it could not be stored safely. */
  move(move: M): boolean {
    const m = this.match;
    if (!m || this.phase !== 'playing' || this.engine.turn(m.state) !== m.mySeat) return false;
    const next = this.engine.apply(m.state, m.mySeat, move);
    if (!next) return false;
    const index = m.history.length;
    const entry: Entry = { s: m.mySeat, m: move, sig: this.room.identity.signValue({ id: m.id, i: index, s: m.mySeat, m: move }) };
    if (this.journalSeat && !this.journalSeat.commit(this.journal({ ...m, history: [...m.history, entry] }))) {
      this.events.emit('storage-error');
      this.emit();
      return false;
    }
    m.history.push(entry);
    m.state = next;
    this.events.emit('move', { index, seat: m.mySeat, move, mine: true });
    this.broadcastState();
    this.afterProgress();
    return true;
  }

  /**
   * Leave. Before the match starts this closes the lobby for everyone ('left'); during a match it
   * only pauses it (the others wait; this seat can come back). `quit: true` ends the match for all.
   */
  leave({ quit = false }: { quit?: boolean } = {}): void {
    const p = this.phase;
    if (p === 'finished' || p === 'stopped') return this.destroy();
    if (!this.match || quit) {
      const reason: StopReason = this.match ? 'quit' : 'left';
      this.sendAll({ v: TURN_PROTOCOL, t: 'stop', id: this.match?.id ?? null, reason });
      this.stop(reason, null);
    }
    this.destroy();
  }

  /** The app took the result into account (awarded points...): it is not emitted again on reload. */
  settle(): void {
    this.settledFlag = true;
    this.persist({ settled: true });
  }

  destroy(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.clock.clearInterval(this.timer);
  }

  // ---------------------------------------------------------------- persistence

  private journal(match: (Header & { history: Entry[] }) | null = this.match): TurnJournal {
    return {
      v: 1,
      code: this.room.code,
      role: this.isHost ? 'host' : 'guest',
      rev: this.rev,
      lineup: this.lineup,
      match: match ? { id: match.id, seats: match.seats, lineups: match.lineups, sig: match.sig, hs: match.hs, history: match.history } : null,
      stopped: this.stopped,
      settled: this.settledFlag,
    };
  }

  private persist(extra: { settled?: boolean } = {}): void {
    this.journalSeat?.save(this.journal(), extra);
  }

  private restore(j: TurnJournal): void {
    if (!isRecord(j) || j.v !== 1 || j.code !== this.room.code || j.role !== (this.isHost ? 'host' : 'guest')) return;
    this.rev = Number.isSafeInteger(j.rev) ? j.rev : 0;
    this.lineup = (j.lineup ?? null) as L | null;
    this.settledFlag = j.settled === true;
    this.stopped = j.stopped ?? null;
    if (j.match) {
      const live = this.verifyHeader(j.match);
      if (!live) return;
      const applied = this.applyEntries(live, 0, j.match.history, false);
      if (applied !== j.match.history.length) {
        netlog('turn-restore-failed', { at: applied });
        return;
      }
      this.match = live;
    }
  }

  // ---------------------------------------------------------------- protocol

  private send(peer: PeerId, msg: Msg): void {
    this.room.send(peer, msg, { channel: this.channelName });
  }

  private sendAll(msg: Msg): void {
    for (const p of this.targets()) this.send(p, msg);
  }

  /** the peers this session talks to: the seats once the match exists, else everyone in the room */
  private targets(): PeerId[] {
    const inRoom = this.room.getPeers().map((p) => p.id);
    if (!this.match) return inRoom;
    return this.match.seats.filter((p) => p !== this.room.peerId && inRoom.includes(p));
  }

  private stateMsg(from: number): Msg {
    const m = this.match!;
    const base = Math.max(0, Math.min(from, m.history.length));
    return { v: TURN_PROTOCOL, t: 'state', id: m.id, seats: m.seats, lineups: m.lineups, sig: m.sig, hs: m.hs, base, moves: m.history.slice(base), len: m.history.length };
  }

  /** send every seat what it lacks (nothing to seats that hold everything) */
  private broadcastState(): void {
    if (!this.match) return;
    const len = this.match.history.length;
    for (const p of this.targets()) {
      const k = this.known.get(p) ?? -1;
      if (k < 0 || k < len) this.send(p, this.stateMsg(Math.max(0, k)));
    }
  }

  private head(peer?: PeerId): void {
    const m = this.match;
    const msg: Msg = { v: TURN_PROTOCOL, t: 'head', id: m?.id ?? null, len: m?.history.length ?? 0, last: m?.history.at(-1)?.sig ?? '' };
    if (peer) this.send(peer, msg);
    else this.sendAll(msg);
  }

  /** a peer appeared / restarted / came back */
  private greet(peer: PeerId, fresh: boolean): void {
    this.touch(peer);
    if (fresh) this.known.set(peer, -1);
    if (this.match) {
      if (this.match.seats.includes(peer)) this.send(peer, this.stateMsg(Math.max(0, this.known.get(peer) ?? -1)));
    } else if (!this.stopped) {
      this.send(peer, { v: TURN_PROTOCOL, t: 'ready', rev: this.rev, lineup: this.lineup });
    }
  }

  private onLeave(peer: PeerId): void {
    if (!this.match && this.lobbyOf.delete(peer)) {
      this.events.emit('lobby', this.lobby);
      this.emit();
    }
  }

  private touch(peer: PeerId): void {
    this.lastSeen.set(peer, this.clock.now());
    if (this.match?.seats.includes(peer) && this.status.get(peer) !== 'online') {
      this.status.set(peer, 'online');
      this.events.emit('seat-status', { seat: this.match.seats.indexOf(peer), peer, status: 'online' });
      this.emit();
    }
  }

  private receive(peer: PeerId, raw: unknown): void {
    if (!isRecord(raw) || typeof raw.t !== 'string') return;
    const msg = raw as unknown as Msg;
    if (msg.v !== TURN_PROTOCOL) {
      this.events.emit('incompatible', { peer, reason: `turn protocol ${String(msg.v)}` });
      this.send(peer, { v: TURN_PROTOCOL, t: 'stop', id: null, reason: 'version' });
      return;
    }
    this.touch(peer);
    switch (msg.t) {
      case 'ready':
        return this.onReady(peer, msg);
      case 'state':
        this.onState(peer, msg, false);
        return;
      case 'head':
        return this.onHead(peer, msg);
      case 'want':
        if (this.match && msg.id === this.match.id && Number.isSafeInteger(msg.from) && this.match.seats.includes(peer)) this.send(peer, this.stateMsg(msg.from));
        return;
      case 'stop':
        return this.onStop(peer, msg);
    }
  }

  private onReady(peer: PeerId, msg: Extract<Msg, { t: 'ready' }>): void {
    if (this.match) {
      // a seat that lost its journal comes back to the lobby: give it the match
      if (this.match.seats.includes(peer)) this.send(peer, this.stateMsg(0));
      return;
    }
    if (this.stopped || !Number.isSafeInteger(msg.rev)) return;
    const prev = this.lobbyOf.get(peer);
    if (prev && msg.rev <= prev.rev) return;
    if (msg.lineup !== null && this.engine.validateLineup && !this.engine.validateLineup(msg.lineup)) {
      this.events.emit('incompatible', { peer, reason: 'lineup rejected' });
      return;
    }
    this.lobbyOf.set(peer, { rev: msg.rev, lineup: msg.lineup });
    this.events.emit('lobby', this.lobby);
    this.emit();
    this.tryStart();
  }

  private onHead(peer: PeerId, msg: Extract<Msg, { t: 'head' }>): void {
    const m = this.match;
    if (!Number.isSafeInteger(msg.len) || msg.len < 0) return;
    if (!m) {
      // they play a match we do not know (we lost our journal, or it started while we were away)
      if (msg.id && validMatchId(msg.id) && !this.stopped) this.send(peer, { v: TURN_PROTOCOL, t: 'want', id: msg.id, from: 0 });
      return;
    }
    if (!m.seats.includes(peer)) return;
    if (msg.id === null) {
      this.send(peer, this.stateMsg(0));
      return;
    }
    if (msg.id !== m.id) return;
    const mine = m.history.length;
    if (msg.len <= mine && (msg.len === 0 || m.history[msg.len - 1]?.sig === msg.last)) this.known.set(peer, Math.max(this.known.get(peer) ?? -1, msg.len));
    if (msg.len < mine) this.send(peer, this.stateMsg(msg.len));
    else if (msg.len > mine) this.send(peer, { v: TURN_PROTOCOL, t: 'want', id: m.id, from: mine });
    this.afterProgress();
  }

  private onStop(peer: PeerId, msg: Extract<Msg, { t: 'stop' }>): void {
    if (this.phase === 'finished') return;
    const reason: StopReason = (['left', 'quit', 'timeout', 'version'] as const).includes(msg.reason) ? msg.reason : 'left';
    if (this.match) {
      if (msg.id !== this.match.id && msg.id !== null) return;
      if (!this.match.seats.includes(peer)) return;
      // during a match a peer that merely left pauses it; quit and version end it
      if (reason === 'left' || reason === 'timeout') return;
    }
    this.stop(reason, peer);
  }

  private stop(reason: StopReason, by: PeerId | null): void {
    if (this.stopped) return;
    this.stopped = reason;
    this.persist();
    this.events.emit('stop', { reason, by });
    this.emit();
  }

  // ---------------------------------------------------------------- match

  private tryStart(): void {
    if (!this.isHost || this.match || this.stopped || this.lineup === null) return;
    const ready = this.room
      .getPeers()
      .filter((p) => this.lobbyOf.get(p.id)?.lineup != null)
      .sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
    if (ready.length < this.seatCount - 1) return;
    const seats = [this.room.peerId, ...ready.slice(0, this.seatCount - 1).map((p) => p.id)];
    const lineups = [this.lineup, ...seats.slice(1).map((p) => this.lobbyOf.get(p)!.lineup)] as L[];
    const id = randomHex(16);
    let state: S;
    try {
      state = this.engine.setup(lineups, { matchId: id, seats, seed: sha256Hex(`hostless/seed/${id}`) });
    } catch (error) {
      netlog('turn-setup-failed', { error: String(error) });
      return;
    }
    const sig = this.signatureOf(state);
    const hs = this.room.identity.signValue({ id, seats, lineups, sig });
    this.match = { id, seats, lineups, sig, hs, history: [], state, mySeat: 0 };
    for (const p of seats.slice(1)) {
      this.known.set(p, -1);
      this.status.set(p, 'online');
    }
    this.persist();
    this.events.emit('start', { matchId: id, seats: [...seats], mySeat: 0 });
    this.broadcastState();
    this.emit();
  }

  private signatureOf(state: S): string {
    return this.engine.signature ? this.engine.signature(state) : sha256Hex(stableJson(state));
  }

  /** check a header (signature of the setup by the host) and build the initial state */
  private verifyHeader(h: Header): Live<S> | null {
    if (!validMatchId(h.id) || !Array.isArray(h.seats) || h.seats.length !== this.seatCount || !Array.isArray(h.lineups) || h.lineups.length !== this.seatCount) return null;
    if (new Set(h.seats).size !== h.seats.length) return null;
    const mySeat = h.seats.indexOf(this.room.peerId);
    if (mySeat < 0) return null;
    if (!verifyValue(h.seats[0], { id: h.id, seats: h.seats, lineups: h.lineups, sig: h.sig }, h.hs)) return null;
    if (this.engine.validateLineup && !h.lineups.every((l) => this.engine.validateLineup!(l))) return null;
    let state: S;
    try {
      state = this.engine.setup(h.lineups as L[], { matchId: h.id, seats: [...h.seats], seed: sha256Hex(`hostless/seed/${h.id}`) });
    } catch {
      return null;
    }
    if (this.signatureOf(state) !== h.sig) return null;
    return { id: h.id, seats: [...h.seats], lineups: h.lineups, sig: h.sig, hs: h.hs, history: [], state, mySeat };
  }

  /**
   * Append verified entries starting at `base`. Entries already known must be identical.
   * Returns the history length reached, or -1 on a conflict (a forked history).
   */
  private applyEntries(m: Live<S>, base: number, entries: Entry[], emit: boolean): number {
    for (let k = 0; k < entries.length; k++) {
      const i = base + k;
      const e = entries[k];
      if (!isRecord(e) || !Number.isSafeInteger(e.s) || typeof e.sig !== 'string') return i;
      if (i < m.history.length) {
        if (m.history[i].sig !== e.sig) return -1;
        continue;
      }
      if (i !== m.history.length || i >= MAX_HISTORY) return i;
      const seat = this.engine.turn(m.state);
      if (seat === null || e.s !== seat) return i;
      if (this.engine.validateMove && !this.engine.validateMove(e.m)) return i;
      if (!verifyValue(m.seats[seat], { id: m.id, i, s: seat, m: e.m }, e.sig)) return i;
      const next = this.engine.apply(m.state, seat, e.m as M);
      if (!next) return i;
      m.history.push({ s: e.s, m: e.m, sig: e.sig });
      m.state = next;
      if (emit) this.events.emit('move', { index: i, seat, move: e.m, mine: seat === m.mySeat });
    }
    return m.history.length;
  }

  private onState(peer: PeerId, msg: StateMsg, archived: boolean): boolean {
    if (!Number.isSafeInteger(msg.base) || msg.base < 0 || !Array.isArray(msg.moves) || !Number.isSafeInteger(msg.len)) return false;
    let m = this.match;
    let fresh = false;
    if (!m) {
      if (archived || this.stopped) return false;
      const live = this.verifyHeader(msg);
      if (!live) {
        // a header we cannot reproduce: different rules or a tampered setup
        if (Array.isArray(msg.seats) && msg.seats.includes(this.room.peerId)) {
          this.events.emit('incompatible', { peer, reason: 'setup mismatch' });
          this.send(peer, { v: TURN_PROTOCOL, t: 'stop', id: msg.id, reason: 'version' });
          this.stop('version', peer);
        }
        return false;
      }
      if (stableJson(live.lineups[live.mySeat]) !== stableJson(this.lineup)) {
        // the host started with an older lineup of ours: tell it the current one again
        this.send(peer, { v: TURN_PROTOCOL, t: 'ready', rev: this.rev, lineup: this.lineup });
        return false;
      }
      m = live;
      fresh = true;
    } else if (msg.id !== m.id || msg.sig !== m.sig || stableJson(msg.seats) !== stableJson(m.seats)) {
      return false;
    }
    if (!m.seats.includes(peer)) return false;
    if (msg.base > m.history.length) {
      if (!archived) this.send(peer, { v: TURN_PROTOCOL, t: 'want', id: m.id, from: m.history.length });
      if (!fresh) return false;
    }
    if (archived) {
      // an archive may only finish a match, never move it to a non-final position
      const probe: Live<S> = { ...m, history: [...m.history] };
      const reached = this.applyEntries(probe, msg.base, msg.moves, false);
      if (reached < 0 || !this.engine.result(probe.state)) return false;
    }
    const before = m.history.length;
    const reached = msg.base <= m.history.length ? this.applyEntries(m, msg.base, msg.moves, !fresh) : m.history.length;
    if (reached < 0) {
      netlog('turn-conflict', { peer, matchId: m.id });
      this.events.emit('incompatible', { peer, reason: 'conflicting history' });
      return false;
    }
    if (fresh) {
      this.match = m;
      this.lobbyOf.clear();
      for (const p of m.seats) if (p !== this.room.peerId) this.status.set(p, this.room.getPeer(p) ? 'online' : 'waiting');
      this.persist();
      this.events.emit('start', { matchId: m.id, seats: [...m.seats], mySeat: m.mySeat });
      m.history.forEach((e, i) => this.events.emit('move', { index: i, seat: e.s, move: e.m, mine: e.s === m!.mySeat }));
    }
    const sentLen = msg.base + msg.moves.length;
    if (!archived && reached >= sentLen) this.known.set(peer, Math.max(this.known.get(peer) ?? -1, sentLen));
    if (m.history.length !== before || fresh) {
      this.persist();
      // tell everyone what we hold now (acknowledgement + relay to seats that may lack it)
      this.broadcastState();
      this.afterProgress();
    } else if (!archived && m.history.length > sentLen) {
      this.send(peer, this.stateMsg(sentLen));
    }
    if (!archived) this.head(peer);
    this.emit();
    return true;
  }

  /** called after the history grew or acknowledgements arrived */
  private afterProgress(): void {
    const m = this.match;
    if (!m) return;
    const res = this.engine.result(m.state);
    if (res && !this.resultSent) {
      this.resultSent = true;
      this.persist();
      this.events.emit('result', { ...res, matchId: m.id, mySeat: m.mySeat, settled: this.settledFlag });
    }
    this.emit();
  }

  /** Take a final history that `peer` left in the mailbox. */
  receiveArchive(peer: PeerId, value: unknown): boolean {
    if (!this.match || !isRecord(value) || value.t !== 'state' || value.v !== TURN_PROTOCOL) return false;
    const ok = this.onState(peer, value as unknown as StateMsg, true);
    // whoever stored the final history holds all of it
    if (ok) this.known.set(peer, Math.max(this.known.get(peer) ?? -1, this.match.history.length));
    return ok;
  }

  // ---------------------------------------------------------------- timer

  private tick(): void {
    const now = this.clock.now();
    const m = this.match;
    if (m) {
      for (let seat = 0; seat < m.seats.length; seat++) {
        const peer = m.seats[seat];
        if (peer === this.room.peerId) continue;
        const inRoom = this.room.getPeer(peer);
        const silent = now - (this.lastSeen.get(peer) ?? 0);
        let next: SeatStatus = 'online';
        if (!inRoom || inRoom.state === 'away' || silent >= this.o.silentMs) next = silent >= this.o.reconnectMs || !inRoom ? 'waiting' : 'away';
        if (this.status.get(peer) !== next) {
          this.status.set(peer, next);
          this.events.emit('seat-status', { seat, peer, status: next });
          this.emit();
        }
      }
    }
    if (now - this.lastHead >= this.o.headMs) {
      this.lastHead = now;
      if (m) this.head();
      else if (!this.stopped) this.sendAll({ v: TURN_PROTOCOL, t: 'ready', rev: this.rev, lineup: this.lineup });
    }
    this.mailboxTick(now);
  }

  private mailboxTick(now: number): void {
    const m = this.match;
    if (!m || !this.mailbox) return;
    const finished = this.phase === 'finished';
    // a finished match whose history some seat has not confirmed: leave a copy on the relays
    if (finished && !this.stored && !this.everyoneHasIt && now >= this.nextStoreAt && this.storeAttempts < 5) {
      this.storeAttempts++;
      this.nextStoreAt = now + 15_000;
      const to = m.seats.filter((p) => p !== this.room.peerId);
      void this.mailbox
        .put(m.id, this.stateMsg(0), to)
        .then((accepted) => {
          if (accepted > 0) this.stored = true;
        })
        .catch(() => {});
    }
    // an unfinished match with a seat gone for long: maybe it finished the match and left a copy
    if (!finished && this.phase === 'playing') {
      for (const peer of m.seats) {
        if (peer === this.room.peerId || this.status.get(peer) !== 'waiting') continue;
        const slot = this.lookupAt.get(peer) ?? { next: now, delay: 10_000 };
        if (now < slot.next) continue;
        slot.next = now + slot.delay;
        slot.delay = Math.min(60_000, slot.delay * 2);
        this.lookupAt.set(peer, slot);
        void this.mailbox
          .get(peer, m.id)
          .then((value) => {
            if (value !== undefined) this.receiveArchive(peer, value);
          })
          .catch(() => {});
      }
    }
  }

  private emit(): void {
    this.events.emit('change');
  }

  on<K extends keyof TurnMatchEvents>(event: K, listener: (...args: TurnMatchEvents[K]) => void) {
    return this.events.on(event, listener);
  }
}
