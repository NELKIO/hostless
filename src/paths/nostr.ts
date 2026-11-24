/**
 * A relay path over public Nostr relays: independent servers run by different people, often
 * reachable where MQTT brokers and WebRTC are not.
 *
 * Frames travel as EPHEMERAL events (kind 25050: relays forward them to live subscribers and do not
 * store them) tagged ['t', topic], where the topic is derived from the room's public topic and the
 * recipient (one topic per peer plus one for the room). Neither the room code nor any peer key
 * appears on a relay; the content is the already-encrypted frame in base64. Events are signed with a
 * throwaway key, as Nostr requires.
 *
 * The path keeps sockets to several relays, subscribes on all of them, publishes each frame on
 * `fanout` relays in rotation (preferring the ones the recipient listens on), drops relays that
 * refuse us, reconnects with backoff, and hops connections: some networks (seen in Russia in
 * 2025-2026) let a TLS connection to foreign hosting carry only ~10-16 KB and then freeze it
 * silently. Every EVENT is answered by an OK, so an overdue OK means a frozen socket: a fresh socket
 * replaces it and the unconfirmed events go out again. The bytes a socket carried before freezing are
 * remembered per relay and later sockets are replaced in advance at 70% of that.
 *
 * Ported from influence-web `nostrRelay.ts` (NostrBus).
 */
import { Emitter } from '../util/emitter.js';
import { backoff, BoundedSet } from '../util/backoff.js';
import { fromB64, toB64 } from '../util/bytes.js';
import { netlog } from '../util/log.js';
import type { Clock } from '../util/timers.js';
import { generateSecret } from '../crypto/schnorr.js';
import { signEvent, type NostrEvent } from '../nostr/event.js';
import { defaultWsFactory, WS_OPEN, type WsFactory, type WsLike } from '../nostr/socket.js';
import { subTopic } from '../room/secrets.js';
import type { PeerId } from '../identity.js';
import type { Path, PathContext, PathEvents, PathFactory } from './types.js';
import { DEFAULT_NOSTR_RELAYS } from './defaults.js';

export const EPHEMERAL_KIND = 25050;

export interface NostrPathOptions {
  relays?: readonly string[];
  name?: string;
  /** publish each frame on this many relays (taken in turn); subscriptions are on all */
  fanout?: number;
  /** raw frame bytes (content is base64 of it) */
  maxFrame?: number;
  /** an EVENT not confirmed (OK) within this long means the socket froze */
  okTimeoutMs?: number;
  /** no relay up this long after the start → error event */
  connectTimeoutMs?: number;
  ws?: WsFactory;
}

interface Conn {
  url: string;
  index: number;
  ws: WsLike | null;
  /** replacement socket being opened (connection hopping) */
  next: WsLike | null;
  up: boolean;
  dead: boolean;
  deadReason: string | null;
  fails: number;
  everUp: boolean;
  limited: number[];
  timer: unknown;
  tx: number;
  rx: number;
  txOk: number;
  lastRxAt: number;
  lastOkAt: number;
  silent: number;
  lastHop: number;
  hopFails: number;
  hopAfter: number;
  unconfirmed: Map<string, { at: number; text: string }>;
  budget: number | null;
  freezes: number;
  sent: number;
}

const REFUSED = /^(blocked|banned|restricted|pow|auth-required|invalid|error)/i;

export class NostrPath implements Path {
  readonly kind = 'nostr' as const;
  readonly direct = false;
  readonly name: string;
  readonly maxFrame: number;
  readonly events = new Emitter<PathEvents>();
  private conns: Conn[] = [];
  private secret = generateSecret();
  private roomTopic: string;
  private myTopic: string;
  private peerTopics = new Map<PeerId, string>();
  private peerMasks = new Map<PeerId, number>();
  private seen = new BoundedSet<string>(4096);
  private pending: Array<{ to: PeerId | null; frame: Uint8Array }> = [];
  private sub = `hl${Math.random().toString(36).slice(2, 10)}`;
  private closed = false;
  private wasUp = false;
  private turn = 0;
  private watch: unknown;
  private failTimer: unknown;
  private ws: WsFactory;
  private clock: Clock;
  private okTimeoutMs: number;
  private fanout: number;

  constructor(
    private ctx: PathContext,
    o: NostrPathOptions = {},
  ) {
    this.name = o.name ?? 'nostr';
    this.maxFrame = o.maxFrame ?? 2400;
    this.ws = o.ws ?? defaultWsFactory;
    this.clock = ctx.clock;
    this.okTimeoutMs = o.okTimeoutMs ?? 1500;
    this.fanout = Math.max(1, o.fanout ?? 2);
    this.roomTopic = subTopic(ctx.secrets.topic, 'nostr-room');
    this.myTopic = this.topicOf(ctx.self);
    const relays = [...new Set(o.relays ?? DEFAULT_NOSTR_RELAYS)];
    this.conns = relays.map((url, index) => ({
      url,
      index,
      ws: null,
      next: null,
      up: false,
      dead: false,
      deadReason: null,
      fails: 0,
      everUp: false,
      limited: [],
      timer: null,
      tx: 0,
      rx: 0,
      txOk: 0,
      lastRxAt: 0,
      lastOkAt: 0,
      silent: 0,
      lastHop: 0,
      hopFails: 0,
      hopAfter: 0,
      unconfirmed: new Map(),
      budget: null,
      freezes: 0,
      sent: 0,
    }));
    for (const conn of this.conns) this.connect(conn);
    this.failTimer = this.clock.setTimeout(() => {
      this.failTimer = null;
      if (!this.closed && !this.conns.some((c) => c.everUp)) this.events.emit('error', 'unreachable', 'no Nostr relay is reachable');
    }, o.connectTimeoutMs ?? 12_000);
    this.watch = this.clock.setInterval(() => this.watchdog(), Math.max(100, Math.min(500, this.okTimeoutMs / 4)));
  }

  private topicOf(peer: PeerId): string {
    let t = this.peerTopics.get(peer);
    if (!t) this.peerTopics.set(peer, (t = subTopic(this.ctx.secrets.topic, `nostr-peer:${peer}`)));
    return t;
  }

  get up(): boolean {
    return this.conns.some((c) => c.up && !c.dead);
  }

  reachable(_peer: PeerId): boolean {
    return this.up;
  }

  bind(): void {}

  /** bitmask of the relays (by list position) we can be reached on */
  hint(): number {
    let mask = 0;
    for (const c of this.conns) if (c.up && !c.dead && c.index < 31) mask |= 1 << c.index;
    return mask;
  }

  setPeerHint(peer: PeerId, hint: unknown): void {
    if (Number.isSafeInteger(hint) && (hint as number) >= 0) this.peerMasks.set(peer, hint as number);
  }

  status(): Record<string, unknown> {
    return {
      relays: this.conns.map((c) => ({ url: c.url, up: c.up, dead: c.deadReason, freezes: c.freezes, sent: c.sent })),
    };
  }

  // ---------------------------------------------------------------- sockets

  private connect(conn: Conn, hop = false): void {
    if (this.closed || conn.dead) return;
    if (hop && (conn.next || this.clock.now() < conn.hopAfter)) return;
    let ws: WsLike;
    try {
      ws = this.ws(conn.url);
    } catch {
      if (!hop) this.retry(conn);
      return;
    }
    if (hop) conn.next = ws;
    else conn.ws = ws;
    const current = () => conn.ws === ws || conn.next === ws;
    ws.onopen = () => {
      if (!current() || this.closed) return;
      // limit 0: only live events, never stored ones
      const req = JSON.stringify(['REQ', this.sub, { kinds: [EPHEMERAL_KIND], '#t': [this.roomTopic, this.myTopic], limit: 0 }]);
      try {
        ws.send(req);
      } catch {
        return;
      }
      const hopping = conn.next === ws;
      const old = hopping ? conn.ws : null;
      if (hopping) {
        conn.hopFails = 0;
        conn.next = null;
        conn.ws = ws;
        conn.lastHop = this.clock.now();
      }
      conn.tx = req.length;
      conn.rx = 0;
      conn.txOk = 0;
      conn.lastRxAt = conn.lastOkAt = this.clock.now();
      // events still unconfirmed on the previous socket go out again here (copies are dropped by id).
      // Only the newest ones that fit in half of the byte budget this relay allows a socket: carrying
      // more would freeze the fresh socket at once, and the link layer re-sends older data anyway.
      let carry = [...conn.unconfirmed];
      if (conn.budget !== null) {
        const allowance = conn.budget * 0.5 - req.length;
        let used = 0;
        let from = carry.length;
        while (from > 0 && used + carry[from - 1][1].text.length <= allowance) used += carry[--from][1].text.length;
        if (from > 0) netlog('nostr-carry-trimmed', { relay: conn.url, dropped: from });
        carry = carry.slice(from);
      }
      conn.unconfirmed.clear();
      const now = this.clock.now();
      for (const [id, u] of carry) {
        try {
          ws.send(u.text);
        } catch {
          break;
        }
        conn.tx += u.text.length;
        conn.unconfirmed.set(id, { at: now, text: u.text });
      }
      if (hopping) {
        netlog('nostr-hop', { relay: conn.url, carried: carry.length });
        try {
          old?.close();
        } catch {
          /* ignore */
        }
      }
      conn.up = true;
      conn.everUp = true;
      conn.fails = 0;
      this.changed();
    };
    ws.onmessage = (ev) => {
      if (conn.ws !== ws) return;
      const data = typeof ev.data === 'string' ? ev.data : '';
      conn.rx += data.length;
      conn.lastRxAt = this.clock.now();
      let m: unknown;
      try {
        m = JSON.parse(data);
      } catch {
        return;
      }
      if (!Array.isArray(m)) return;
      switch (m[0]) {
        case 'EVENT':
          if (m[1] === this.sub) this.onEvent(m[2]);
          break;
        case 'OK': {
          const u = conn.unconfirmed.get(String(m[1]));
          conn.lastOkAt = this.clock.now();
          if (u) {
            conn.txOk += u.text.length;
            conn.silent = 0;
            conn.unconfirmed.delete(String(m[1]));
          }
          if (m[2] === false) {
            const reason = String(m[3] ?? '');
            netlog('nostr-refused', { relay: conn.url, reason });
            if (REFUSED.test(reason)) this.drop(conn, reason);
            else if (/^rate-limited/i.test(reason)) {
              const now = this.clock.now();
              conn.limited = conn.limited.filter((t) => now - t < 30_000);
              conn.limited.push(now);
              if (conn.limited.length >= 3) this.drop(conn, reason);
            }
          }
          break;
        }
        case 'CLOSED':
          if (m[1] === this.sub) this.drop(conn, `subscription closed: ${String(m[2] ?? '')}`);
          break;
        default:
          break;
      }
      this.maybeHop(conn);
    };
    ws.onclose = () => {
      if (conn.next === ws) {
        // the replacement did not open: wait before the next try, stop using a frozen socket
        conn.next = null;
        conn.hopAfter = this.clock.now() + backoff(conn.hopFails++);
        if (conn.unconfirmed.size && conn.up) {
          conn.up = false;
          this.changed();
          if (conn.timer) this.clock.clearTimeout(conn.timer);
          conn.timer = this.clock.setTimeout(
            () => {
              conn.timer = null;
              const old = conn.ws;
              conn.ws = null;
              try {
                old?.close();
              } catch {
                /* ignore */
              }
              this.connect(conn);
            },
            Math.max(0, conn.hopAfter - this.clock.now()),
          );
        }
        return;
      }
      if (conn.ws !== ws) return;
      conn.ws = null;
      conn.up = false;
      this.changed();
      this.retry(conn);
    };
    ws.onerror = () => {
      /* close follows */
    };
  }

  private retry(conn: Conn): void {
    if (this.closed || conn.dead) return;
    if (conn.timer) this.clock.clearTimeout(conn.timer);
    conn.timer = this.clock.setTimeout(() => {
      conn.timer = null;
      this.connect(conn);
    }, backoff(conn.fails++));
  }

  private watchdog(): void {
    if (this.closed) return;
    const now = this.clock.now();
    for (const conn of this.conns) {
      if (!conn.up || !conn.ws || conn.next) continue;
      let oldest = Infinity;
      for (const u of conn.unconfirmed.values()) oldest = Math.min(oldest, u.at);
      if (now - oldest < this.okTimeoutMs) continue;
      // frozen: nothing came back since that event went out, or other things arrive but no OK at all
      const noRx = conn.lastRxAt <= oldest;
      const noOk = conn.lastOkAt <= oldest && now - oldest >= this.okTimeoutMs * 2 && conn.unconfirmed.size >= 2;
      if (!noRx && !noOk) {
        // a slow relay, or one that skipped an OK: forget events left unconfirmed for long
        for (const [id, u] of conn.unconfirmed) if (now - u.at > this.okTimeoutMs * 3) conn.unconfirmed.delete(id);
        continue;
      }
      conn.freezes++;
      netlog('nostr-frozen', { relay: conn.url, tx: conn.tx, rx: conn.rx, ok: conn.txOk, waiting: conn.unconfirmed.size });
      if (conn.txOk === 0) {
        if (++conn.silent >= 3) {
          this.drop(conn, 'no answers');
          continue;
        }
      } else {
        const carried = Math.max(5000, conn.txOk + conn.rx);
        conn.budget = conn.budget === null ? carried : Math.min(conn.budget, carried);
      }
      this.connect(conn, true);
    }
  }

  private maybeHop(conn: Conn, extra = 0): boolean {
    const b = conn.budget;
    if (b === null || conn.next || !conn.up) return !!conn.next;
    if (conn.tx + conn.rx < 600 || conn.tx + conn.rx + extra <= b * 0.7 || this.clock.now() - conn.lastHop < 1500) return false;
    netlog('nostr-hop-early', { relay: conn.url, tx: conn.tx, rx: conn.rx });
    this.connect(conn, true);
    return !!conn.next;
  }

  private drop(conn: Conn, reason: string): void {
    if (conn.dead) return;
    conn.dead = true;
    conn.deadReason = reason;
    conn.up = false;
    netlog('nostr-drop', { relay: conn.url, reason });
    for (const ws of [conn.ws, conn.next]) {
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    }
    conn.ws = conn.next = null;
    conn.unconfirmed.clear();
    this.events.emit('error', 'relay-dropped', `${conn.url}: ${reason}`);
    this.changed();
  }

  private changed(): void {
    const up = this.up;
    if (up === this.wasUp) return;
    this.wasUp = up;
    if (up) {
      for (const p of this.pending.splice(0)) this.send(p.to, p.frame);
      this.events.emit('up');
    } else this.events.emit('down');
  }

  private onEvent(raw: unknown): void {
    const e = raw as Partial<NostrEvent> | null;
    if (!e || typeof e.id !== 'string' || typeof e.content !== 'string' || e.kind !== EPHEMERAL_KIND || !Array.isArray(e.tags)) return;
    if (e.content.length > Math.ceil(this.maxFrame / 3) * 4 + 4) return;
    if (!e.tags.some((t) => Array.isArray(t) && t[0] === 't' && (t[1] === this.myTopic || t[1] === this.roomTopic))) return;
    if (!this.seen.add(e.id)) return;
    const frame = fromB64(e.content);
    if (frame) this.events.emit('frame', frame, null);
  }

  private write(conn: Conn, text: string, id: string): void {
    if (!conn.ws) return;
    const now = this.clock.now();
    conn.sent++;
    if (conn.next || this.maybeHop(conn, text.length)) {
      // a fresh socket is on its way: the event goes out on it
      conn.unconfirmed.set(id, { at: now + this.okTimeoutMs, text });
      return;
    }
    try {
      conn.ws.send(text);
    } catch {
      return;
    }
    conn.tx += text.length;
    conn.unconfirmed.set(id, { at: now, text });
    if (conn.unconfirmed.size > 200) conn.unconfirmed.delete(conn.unconfirmed.keys().next().value as string);
  }

  send(to: PeerId | null, frame: Uint8Array): boolean {
    if (this.closed) return false;
    if (frame.length > this.maxFrame) throw new Error(`nostr path: frame ${frame.length} > ${this.maxFrame}`);
    if (!this.up) {
      this.pending.push({ to, frame });
      if (this.pending.length > 32) this.pending.shift();
      return true;
    }
    const topic = to === null ? this.roomTopic : this.topicOf(to);
    const ev = signEvent(this.secret, { kind: EPHEMERAL_KIND, created_at: Math.floor(this.clock.now() / 1000), tags: [['t', topic]], content: toB64(frame) }, this.ctx.random);
    const text = JSON.stringify(['EVENT', ev]);
    let live = this.conns.filter((c) => c.up && !c.dead);
    // prefer the relays the recipient said it listens on
    const mask = to === null ? 0 : (this.peerMasks.get(to) ?? 0);
    if (mask) {
      const both = live.filter((c) => c.index < 31 && mask & (1 << c.index));
      if (both.length) live = both;
    }
    // relays whose sockets never froze first: no hops, no waiting for a fresh socket
    const smooth = live.filter((c) => c.freezes === 0);
    if (smooth.length >= this.fanout) live = smooth;
    // room-wide frames (hellos) take more relays in rotation: a newcomer may listen on any of them,
    // and hellos repeat, so every relay gets its share
    const n = Math.min(live.length, to === null ? this.fanout * 2 : this.fanout);
    for (let i = 0; i < n; i++) this.write(live[(this.turn + i) % live.length], text, ev.id);
    this.turn = (this.turn + n) % Math.max(1, live.length);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.failTimer) this.clock.clearTimeout(this.failTimer);
    this.clock.clearInterval(this.watch);
    for (const c of this.conns) {
      if (c.timer) this.clock.clearTimeout(c.timer);
      c.timer = null;
      const { ws, next } = c;
      c.ws = c.next = null;
      c.up = false;
      try {
        if (ws && ws.readyState === WS_OPEN) ws.send(JSON.stringify(['CLOSE', this.sub]));
        ws?.close();
        next?.close();
      } catch {
        /* ignore */
      }
    }
    this.pending = [];
    this.events.emit('down');
  }
}

export function nostrPath(options: NostrPathOptions = {}): PathFactory {
  return (ctx) => new NostrPath(ctx, options);
}
