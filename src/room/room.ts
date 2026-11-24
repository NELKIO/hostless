/**
 * A Room: everyone who opened the same room code of the same app.
 *
 * Peers announce themselves with signed HELLO frames on every path. A verified hello creates a
 * Link (link.ts) to that peer session; DATA frames between two peers are encrypted with their
 * pairwise key, so a frame that opens is authenticated. The room tracks which paths reach which
 * peer, feeds that to the links, detects silence (away / gone), restarts (a newer hello with a new
 * session id) and incompatible protocol versions, and multiplexes named channels over the links.
 */
import { Emitter } from '../util/emitter.js';
import { randomBytes, randomHex, type RandomBytes } from '../util/bytes.js';
import { realClock, type Clock } from '../util/timers.js';
import { netlog } from '../util/log.js';
import { isRecord } from '../util/stable-json.js';
import { Identity, type PeerId } from '../identity.js';
import { roomSecrets, DEFAULT_KDF_ITERATIONS, type RoomSecrets } from './secrets.js';
import { dataHeader, DATA_OVERHEAD, decodeHello, encodeData, encodeHello, frameKind, openData, PairKeys, type AppInfo, type Hello } from './frames.js';
import { Link, type LinkOptions } from './link.js';
import { DATA_SEG_HEADER } from './segments.js';
import type { Path, PathContext, PathFactory } from '../paths/types.js';

export type PeerState = 'connected' | 'away';
export type Route = 'direct' | 'relay' | null;

export interface PeerInfo {
  id: PeerId;
  meta: Record<string, unknown>;
  app: AppInfo;
  state: PeerState;
  route: Route;
  rtt: number | null;
  /** names of the paths that reach the peer now */
  paths: string[];
  joinedAt: number;
}

export interface RoomMessage<T = unknown> {
  peer: PeerId;
  channel: string;
  data: T;
  reliable: boolean;
}

export type RoomStatus = 'connecting' | 'online' | 'offline' | 'closed';
export type LeaveReason = 'bye' | 'timeout' | 'closed';

export interface RoomEvents {
  [event: string]: unknown[];
  'peer-join': [peer: PeerInfo];
  'peer-leave': [peer: PeerInfo, reason: LeaveReason];
  'peer-away': [peer: PeerInfo];
  'peer-back': [peer: PeerInfo];
  /** the peer reloaded its page: links restarted, sessions should resync */
  'peer-restart': [peer: PeerInfo];
  'peer-update': [peer: PeerInfo];
  /** the peer's traffic moved between the direct path and relays */
  route: [peer: PeerInfo];
  message: [message: RoomMessage];
  /** a peer runs a different protocol version of the app */
  incompatible: [info: { peer: PeerId; theirs: AppInfo; ours: AppInfo }];
  /** the room refused us: it already has `maxPeers` */
  full: [info: { peer: PeerId }];
  status: [status: RoomStatus];
  /** a path changed (up/down/error) */
  path: [info: { name: string; up: boolean; error?: string }];
}

export interface JoinOptions {
  app: AppInfo;
  code: string;
  /** a persistent identity (seat); default: a new ephemeral one */
  identity?: Identity;
  /** path factories or ready paths */
  paths: Array<PathFactory | Path>;
  meta?: Record<string, unknown>;
  /** including ourselves */
  maxPeers?: number;
  clock?: Clock;
  random?: RandomBytes;
  kdfIterations?: number;
  /** silence before a peer is "away" */
  awayMs?: number;
  /** silence before a peer is gone */
  leaveMs?: number;
  /** hello interval while some peer has not answered yet */
  handshakeMs?: number;
  /** hello interval while alone in the room */
  aloneMs?: number;
  /** presence refresh while everyone is linked */
  presenceMs?: number;
  tickMs?: number;
  link?: LinkOptions;
  /** send a goodbye on `pagehide` (default true when a window exists) */
  leaveOnPageHide?: boolean;
  /** precomputed secrets (tests) */
  secrets?: RoomSecrets;
}

interface Peer {
  id: PeerId;
  sid: string;
  /** `at` of the hello that introduced the current sid */
  sidAt: number;
  lastHelloAt: number;
  meta: Record<string, unknown>;
  app: AppInfo;
  link: Link;
  state: PeerState;
  route: Route;
  joinedAt: number;
  /** the peer has shown it knows our current session */
  confirmed: boolean;
  lastReplyAt: number;
  reachable: Set<string>;
}

export class Room {
  readonly events = new Emitter<RoomEvents>();
  readonly identity: Identity;
  readonly sid: string;
  readonly code: string;
  readonly app: AppInfo;
  readonly secrets: RoomSecrets;
  private paths: Path[] = [];
  private peers = new Map<PeerId, Peer>();
  private keys: PairKeys;
  private meta: Record<string, unknown>;
  private clock: Clock;
  private random: RandomBytes;
  private o: Required<Pick<JoinOptions, 'maxPeers' | 'awayMs' | 'leaveMs' | 'handshakeMs' | 'aloneMs' | 'presenceMs' | 'tickMs'>>;
  private linkOpts: LinkOptions;
  private helloSentAt = new Map<string, number>();
  private refused = new Map<PeerId, number>();
  private incompatibleSeen = new Map<PeerId, number>();
  private unknownNoticeAt = new Map<PeerId, number>();
  /** sessions that said goodbye or timed out: their late (or replayed) hellos must not revive them */
  private departed = new Map<PeerId, { sid: string; at: number; bye: boolean; until: number }>();
  private timer: unknown;
  private offs: Array<() => void> = [];
  private everUp = false;
  private _status: RoomStatus = 'connecting';
  private closed = false;

  /** use `joinRoom()` */
  constructor(opts: JoinOptions & { secrets: RoomSecrets }, paths: Path[]) {
    this.identity = opts.identity ?? Identity.generate(opts.random);
    this.clock = opts.clock ?? realClock;
    this.random = opts.random ?? randomBytes;
    this.sid = randomHex(8, this.random);
    this.code = opts.code;
    this.app = opts.app;
    this.secrets = opts.secrets;
    this.meta = opts.meta ?? {};
    this.keys = new PairKeys(this.identity, this.secrets);
    this.o = {
      maxPeers: opts.maxPeers ?? 8,
      awayMs: opts.awayMs ?? 12_000,
      leaveMs: opts.leaveMs ?? 60_000,
      handshakeMs: opts.handshakeMs ?? 1000,
      aloneMs: opts.aloneMs ?? 3000,
      presenceMs: opts.presenceMs ?? 20_000,
      tickMs: opts.tickMs ?? 100,
    };
    const minFrame = Math.min(...paths.map((p) => p.maxFrame), 16_384);
    this.linkOpts = { segmentBytes: Math.max(64, minFrame - DATA_OVERHEAD - DATA_SEG_HEADER), ...opts.link };
    for (const path of paths) this.addPath(path);
    this.timer = this.clock.setInterval(() => this.tick(), this.o.tickMs);
    if (opts.leaveOnPageHide ?? typeof globalThis.addEventListener === 'function') {
      const onHide = (event: Event) => {
        // a page kept in the back/forward cache may come back: only say bye when it is discarded
        if (!(event as PageTransitionEvent).persisted) void this.leave();
      };
      globalThis.addEventListener?.('pagehide', onHide);
      this.offs.push(() => globalThis.removeEventListener?.('pagehide', onHide));
    }
    queueMicrotask(() => {
      this.updateStatus();
      this.announce(false);
    });
  }

  get peerId(): PeerId {
    return this.identity.peerId;
  }

  get status(): RoomStatus {
    return this._status;
  }

  // ---------------------------------------------------------------- public API

  /** Peers linked right now (not including ourselves). */
  getPeers(): PeerInfo[] {
    return [...this.peers.values()].map((p) => this.info(p));
  }

  getPeer(id: PeerId): PeerInfo | null {
    const p = this.peers.get(id);
    return p ? this.info(p) : null;
  }

  on<K extends keyof RoomEvents>(event: K, listener: (...args: RoomEvents[K]) => void) {
    return this.events.on(event, listener);
  }

  /** Send to one peer. false when the peer is unknown or its queue is full. */
  send(peer: PeerId, data: unknown, { channel = 'app', reliable = true }: { channel?: string; reliable?: boolean } = {}): boolean {
    const p = this.peers.get(peer);
    if (!p || this.closed) return false;
    return p.link.send([channel, data], reliable);
  }

  /** Send to every linked peer; returns how many accepted it. */
  broadcast(data: unknown, opts: { channel?: string; reliable?: boolean } = {}): number {
    let n = 0;
    for (const id of this.peers.keys()) if (this.send(id, data, opts)) n++;
    return n;
  }

  /** A named sub-channel, so several sessions can share one room. */
  channel<T = unknown>(name: string) {
    return {
      send: (peer: PeerId, data: T, opts: { reliable?: boolean } = {}) => this.send(peer, data, { ...opts, channel: name }),
      broadcast: (data: T, opts: { reliable?: boolean } = {}) => this.broadcast(data, { ...opts, channel: name }),
      on: (handler: (message: RoomMessage<T>) => void) =>
        this.events.on('message', (m) => {
          if (m.channel === name) handler(m as RoomMessage<T>);
        }),
    };
  }

  setMeta(meta: Record<string, unknown>): void {
    this.meta = meta;
    this.announce(true);
  }

  /** All messages to `peer` have been acknowledged. */
  delivered(peer: PeerId): boolean {
    return this.peers.get(peer)?.link.idle ?? false;
  }

  pathInfo(): Array<{ name: string; kind: string; direct: boolean; up: boolean; status?: Record<string, unknown> }> {
    return this.paths.map((p) => ({ name: p.name, kind: p.kind, direct: p.direct, up: p.up, status: p.status?.() }));
  }

  /** Resolves with the next peer that joins (or the first one already linked). */
  waitForPeer(timeoutMs?: number): Promise<PeerInfo> {
    const first = this.getPeers()[0];
    if (first) return Promise.resolve(first);
    return new Promise((resolve, reject) => {
      const off = this.events.once('peer-join', (p) => {
        if (timer) this.clock.clearTimeout(timer);
        resolve(p);
      });
      const timer = timeoutMs ? this.clock.setTimeout(() => (off(), reject(new Error('hostless: no peer joined'))), timeoutMs) : null;
    });
  }

  /** Say goodbye and close every path. */
  async leave(): Promise<void> {
    if (this.closed) return;
    for (const p of this.peers.values()) p.link.bye();
    this.announce(true, true);
    this.closed = true;
    this.clock.clearInterval(this.timer);
    for (const off of this.offs) off();
    for (const p of this.peers.values()) {
      p.link.stop();
      this.events.emit('peer-leave', this.info(p), 'closed');
    }
    this.peers.clear();
    // let the goodbye frames leave the sockets before closing them
    await new Promise<void>((resolve) => this.clock.setTimeout(resolve, 150));
    for (const path of this.paths) {
      try {
        path.close();
      } catch {
        /* ignore */
      }
    }
    this._status = 'closed';
    this.events.emit('status', 'closed');
  }

  // ---------------------------------------------------------------- paths

  private addPath(path: Path): void {
    this.paths.push(path);
    const ev = path.events;
    this.offs.push(
      ev.on('frame', (frame, via) => this.onFrame(path, frame, via)),
      ev.on('up', () => {
        this.updateStatus();
        this.events.emit('path', { name: path.name, up: true });
        this.helloOn(path, null);
        this.refreshReach();
      }),
      ev.on('down', () => {
        this.updateStatus();
        this.events.emit('path', { name: path.name, up: false });
        this.refreshReach();
      }),
      ev.on('via-gone', () => this.refreshReach()),
      ev.on('via-join', () => this.helloOn(path, null)),
      ev.on('error', (code, detail) => this.events.emit('path', { name: path.name, up: path.up, error: `${code}: ${detail}` })),
    );
  }

  private updateStatus(): void {
    if (this.closed) return;
    const up = this.paths.some((p) => p.up);
    if (up) this.everUp = true;
    const next: RoomStatus = up ? 'online' : this.everUp ? 'offline' : 'connecting';
    if (next !== this._status) {
      this._status = next;
      this.events.emit('status', next);
    }
  }

  private refreshReach(): void {
    for (const p of this.peers.values()) this.refreshPeerReach(p);
  }

  private refreshPeerReach(p: Peer): void {
    const now = new Set(this.paths.filter((path) => path.reachable(p.id)).map((path) => path.name));
    for (const name of now) if (!p.reachable.has(name)) p.link.pathUp(name);
    for (const name of p.reachable) if (!now.has(name)) p.link.pathDown(name);
    p.reachable = now;
  }

  // ---------------------------------------------------------------- hello

  private hints(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const p of this.paths) {
      const h = p.hint?.();
      if (h !== undefined) out[p.name] = h;
    }
    return out;
  }

  private helloFrame(to: PeerId | null, extra: { reject?: 'full' | 'protocol'; bye?: boolean } = {}): Uint8Array {
    return encodeHello(
      this.identity,
      this.secrets,
      { sid: this.sid, at: this.clock.now(), to, app: this.app, meta: this.meta, hints: this.hints(), ...extra },
      this.random,
    );
  }

  private helloOn(path: Path, to: PeerId | null, extra: { reject?: 'full' | 'protocol'; bye?: boolean } = {}): void {
    if (!path.up || this.closed) return;
    try {
      path.send(to, this.helloFrame(to, extra));
      if (to === null) this.helloSentAt.set(path.name, this.clock.now());
    } catch (error) {
      netlog('hello-failed', { path: path.name, error: String(error) });
    }
  }

  /** Broadcast our hello on every path (now if `force`, else when its interval is due). */
  private announce(force: boolean, bye = false): void {
    if (this.closed) return;
    const now = this.clock.now();
    const anyUnconfirmed = [...this.peers.values()].some((p) => !p.confirmed);
    const every = !this.peers.size ? this.o.aloneMs : anyUnconfirmed ? this.o.handshakeMs : this.o.presenceMs;
    for (const path of this.paths) {
      if (!path.up) continue;
      if (!force && now - (this.helloSentAt.get(path.name) ?? 0) < every) continue;
      this.helloOn(path, null, bye ? { bye: true } : {});
    }
  }

  private replyTo(p: Peer | null, id: PeerId, path: Path): void {
    const now = this.clock.now();
    const last = p ? p.lastReplyAt : (this.unknownNoticeAt.get(id) ?? 0);
    if (now - last < 500) return;
    if (p) p.lastReplyAt = now;
    else {
      this.unknownNoticeAt.set(id, now);
      capMap(this.unknownNoticeAt, 256);
    }
    this.helloOn(path, id);
  }

  private onFrame(path: Path, frame: Uint8Array, via: unknown): void {
    if (this.closed) return;
    const kind = frameKind(frame);
    if (kind === 'hello') this.onHello(path, frame, via);
    else if (kind === 'data') this.onData(path, frame, via);
  }

  private onHello(path: Path, frame: Uint8Array, via: unknown): void {
    const now = this.clock.now();
    const res = decodeHello(this.secrets, frame, now);
    if (!res.ok) {
      if (res.reason !== 'key') netlog('hello-rejected', { path: path.name, reason: res.reason });
      return;
    }
    const h = res.hello;
    if (h.from === this.peerId) return;
    if (h.to !== null && h.to !== this.peerId) return;
    path.bind(h.from, via);

    if (h.to === this.peerId && h.reject === 'full') {
      this.events.emit('full', { peer: h.from });
      return;
    }
    if (h.app.id !== this.app.id || h.app.protocol !== this.app.protocol || h.reject === 'protocol') {
      if (now - (this.incompatibleSeen.get(h.from) ?? 0) > 10_000) {
        this.incompatibleSeen.set(h.from, now);
        capMap(this.incompatibleSeen, 256);
        this.events.emit('incompatible', { peer: h.from, theirs: h.app, ours: this.app });
        if (!h.reject) this.helloOn(path, h.from, { reject: 'protocol' });
      }
      return;
    }
    let p = this.peers.get(h.from) ?? null;
    if (h.bye) {
      if (p && h.sid === p.sid) this.drop(p, 'bye');
      return;
    }
    if (!p) {
      const gone = this.departed.get(h.from);
      // after a goodbye that session is over; after a timeout only a genuinely newer hello revives it
      if (gone && gone.sid === h.sid && now < gone.until && (gone.bye || h.at <= gone.at)) return;
      if (this.peers.size + 1 >= this.o.maxPeers) {
        if (now - (this.refused.get(h.from) ?? 0) > 2000) {
          this.refused.set(h.from, now);
          capMap(this.refused, 256);
          this.helloOn(path, h.from, { reject: 'full' });
        }
        return;
      }
      p = this.addPeer(h, now);
      this.applyHints(p, h);
      this.refreshPeerReach(p);
      this.events.emit('peer-join', this.info(p));
      this.replyTo(p, p.id, path);
      // tell everyone at once that the room changed (handshake cadence)
      this.announce(true);
      return;
    }
    if (h.sid !== p.sid) {
      if (h.at <= p.sidAt) return; // an old hello replayed: never resets a live link
      netlog('peer-restart', { peer: h.from });
      p.sid = h.sid;
      p.sidAt = h.at;
      p.confirmed = false;
      p.link.reset(h.sid);
      p.reachable = new Set();
      this.applyHints(p, h);
      p.lastHelloAt = h.at;
      p.meta = h.meta;
      this.refreshPeerReach(p);
      this.markHeard(p);
      this.events.emit('peer-restart', this.info(p));
      this.replyTo(p, p.id, path);
      return;
    }
    // an exact replay of the last hello is no sign of life
    if (h.at <= p.lastHelloAt) return;
    p.lastHelloAt = h.at;
    this.applyHints(p, h);
    this.markHeard(p);
    if (JSON.stringify(h.meta) !== JSON.stringify(p.meta)) {
      p.meta = h.meta;
      this.events.emit('peer-update', this.info(p));
    }
    this.refreshPeerReach(p);
    // until the peer shows it knows our session, answer its hellos (rate-limited)
    if (!p.confirmed) this.replyTo(p, p.id, path);
  }

  private applyHints(p: Peer, h: Hello): void {
    if (!isRecord(h.hints)) return;
    for (const path of this.paths) if (path.name in h.hints) path.setPeerHint?.(p.id, h.hints[path.name]);
  }

  private addPeer(h: Hello, now: number): Peer {
    const id = h.from;
    const p: Peer = {
      id,
      sid: h.sid,
      sidAt: h.at,
      lastHelloAt: h.at,
      meta: h.meta,
      app: h.app,
      state: 'connected',
      route: null,
      joinedAt: now,
      confirmed: false,
      lastReplyAt: 0,
      reachable: new Set(),
      link: null as unknown as Link,
    };
    p.link = new Link(
      this.sid,
      h.sid,
      {
        paths: () => this.paths.filter((path) => p.reachable.has(path.name)).map((path) => ({ name: path.name, direct: path.direct })),
        send: (name, segment) => {
          const path = this.paths.find((x) => x.name === name);
          if (!path || !path.up) return false;
          return path.send(id, encodeData(this.keys, this.peerId, id, segment, this.random));
        },
        deliver: (value, reliable) => this.deliver(p, value, reliable),
        staleTarget: (name) => {
          const path = this.paths.find((x) => x.name === name);
          if (path) this.helloOn(path, id);
        },
        bye: () => this.drop(p, 'bye'),
        overflow: () => netlog('overflow', { peer: id }),
      },
      this.clock,
      { ...this.linkOpts, label: id.slice(0, 8) },
    );
    this.peers.set(id, p);
    return p;
  }

  private onData(path: Path, frame: Uint8Array, via: unknown): void {
    const head = dataHeader(frame);
    if (!head || head.to !== this.peerId) return;
    // only linked peers: an unknown sender costs no key agreement (it gets our periodic hello
    // like everyone, and its own hello introduces it)
    const p = this.peers.get(head.from);
    if (!p) return;
    const segment = openData(this.keys, head.from, frame);
    if (!segment) return;
    path.bind(head.from, via);
    if (!p.reachable.has(path.name)) this.refreshPeerReach(p);
    // segment layout: type(1) | fromSid(8) | toSid(8)
    const fs = segmentSid(segment, 1);
    const ts = segmentSid(segment, 9);
    if (fs !== p.sid) return;
    if (ts === this.sid) p.confirmed = true;
    const before = p.link.lastHeard;
    p.link.receive(path.name, segment);
    if (p.link.lastHeard !== before) this.markHeard(p);
  }

  private markHeard(p: Peer): void {
    p.link.lastHeard = this.clock.now();
    if (p.state === 'away') {
      p.state = 'connected';
      this.events.emit('peer-back', this.info(p));
    }
  }

  private deliver(p: Peer, value: unknown, reliable: boolean): void {
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string') return;
    this.events.emit('message', { peer: p.id, channel: value[0], data: value[1], reliable });
  }

  private drop(p: Peer, reason: LeaveReason): void {
    if (this.peers.get(p.id) !== p) return;
    this.peers.delete(p.id);
    this.departed.set(p.id, { sid: p.sid, at: p.lastHelloAt, bye: reason === 'bye', until: this.clock.now() + 2 * 120_000 });
    capMap(this.departed, 256);
    p.link.stop();
    this.events.emit('peer-leave', this.info(p), reason);
  }

  // ---------------------------------------------------------------- timer

  private tick(): void {
    if (this.closed) return;
    const now = this.clock.now();
    this.announce(false);
    for (const p of [...this.peers.values()]) {
      this.refreshPeerReach(p);
      p.link.tick(now);
      const silent = now - p.link.lastHeard;
      if (silent >= this.o.leaveMs) {
        this.drop(p, 'timeout');
        continue;
      }
      if (p.state === 'connected' && silent >= this.o.awayMs) {
        p.state = 'away';
        this.events.emit('peer-away', this.info(p));
      }
      const route = p.link.route();
      if (route !== p.route) {
        p.route = route;
        this.events.emit('route', this.info(p));
      }
    }
  }

  private info(p: Peer): PeerInfo {
    return {
      id: p.id,
      meta: p.meta,
      app: p.app,
      state: p.state,
      route: p.link.stopped ? p.route : p.link.route(),
      rtt: p.link.rtt(),
      paths: [...p.reachable],
      joinedAt: p.joinedAt,
    };
  }
}

function capMap<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) map.delete(map.keys().next().value as K);
}

function segmentSid(segment: Uint8Array, at: number): string {
  let out = '';
  for (let i = at; i < at + 8 && i < segment.length; i++) out += segment[i].toString(16).padStart(2, '0');
  return out;
}

/** Join a room: derive its secrets, open every path, start announcing. */
export async function joinRoom(opts: JoinOptions): Promise<Room> {
  const secrets = opts.secrets ?? (await roomSecrets(opts.app.id, opts.code, opts.kdfIterations ?? DEFAULT_KDF_ITERATIONS));
  const identity = opts.identity ?? Identity.generate(opts.random);
  const ctx: PathContext = {
    appId: opts.app.id,
    secrets,
    self: identity.peerId,
    clock: opts.clock ?? realClock,
    random: opts.random ?? randomBytes,
    maxPeers: opts.maxPeers ?? 8,
  };
  const made = await Promise.allSettled(opts.paths.map((p) => (typeof p === 'function' ? p(ctx) : p)));
  const paths: Path[] = [];
  for (const r of made) {
    if (r.status === 'fulfilled') paths.push(r.value);
    else netlog('path-failed', { error: String(r.reason) });
  }
  if (!paths.length) throw new Error('hostless: no path could be opened');
  const names = new Set<string>();
  for (const p of paths) {
    if (names.has(p.name)) throw new Error(`hostless: two paths named "${p.name}"`);
    names.add(p.name);
  }
  return new Room({ ...opts, identity, secrets }, paths);
}
