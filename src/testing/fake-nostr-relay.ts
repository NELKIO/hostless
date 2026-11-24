/**
 * In-memory Nostr relays (NIP-01, NIP-40) for tests, reachable through an injected WebSocket
 * factory. Each relay can misbehave like real ones seen in the field: refuse events, rate-limit,
 * close subscriptions, be down, or freeze a connection silently after N bytes (the DPI behaviour the
 * Nostr path's connection hopping works around).
 */
import { realClock, type Clock } from '../util/timers.js';
import { verifyEvent, isExpired, tagValue, type NostrEvent } from '../nostr/event.js';
import { WS_OPEN, type WsFactory, type WsLike } from '../nostr/socket.js';

export interface RelayBehaviour {
  /** OK false with this reason for every EVENT */
  refuse?: string | null;
  /** answer every n-th EVENT with OK false "rate-limited" */
  rateLimitEvery?: number;
  /** freeze each connection after it carried this many bytes (both directions) */
  freezeAfterBytes?: number | null;
  /** new connections fail */
  down?: boolean;
  /** never send OK */
  silent?: boolean;
  /** CLOSED every subscription right away */
  closeSubscriptions?: string | null;
  /** largest accepted event (JSON chars) */
  maxEventChars?: number;
  latency?: number;
  /** verify signatures (real relays do) */
  verify?: boolean;
}

type Filter = Record<string, unknown>;

interface Sub {
  id: string;
  filters: Filter[];
}

export function matches(filter: Filter, e: NostrEvent): boolean {
  if (Array.isArray(filter.ids) && !filter.ids.includes(e.id)) return false;
  if (Array.isArray(filter.authors) && !filter.authors.includes(e.pubkey)) return false;
  if (Array.isArray(filter.kinds) && !filter.kinds.includes(e.kind)) return false;
  if (typeof filter.since === 'number' && e.created_at < filter.since) return false;
  if (typeof filter.until === 'number' && e.created_at > filter.until) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (key[0] !== '#' || !Array.isArray(values)) continue;
    const name = key.slice(1);
    if (!e.tags.some((t) => t[0] === name && values.includes(t[1]))) return false;
  }
  return true;
}

const isEphemeral = (k: number) => k >= 20000 && k < 30000;
const isReplaceable = (k: number) => k === 0 || k === 3 || (k >= 10000 && k < 20000);
const isParameterized = (k: number) => k >= 30000 && k < 40000;

class Connection {
  bytes = 0;
  frozen = false;
  closed = false;
  subs = new Map<string, Sub>();
  constructor(
    readonly relay: FakeNostrRelay,
    readonly socket: FakeSocket,
  ) {}

  account(n: number): boolean {
    if (this.frozen) return false;
    this.bytes += n;
    const limit = this.relay.behaviour.freezeAfterBytes;
    if (limit && this.bytes > limit) {
      this.frozen = true;
      this.relay.stats.freezes++;
      return false;
    }
    return true;
  }

  push(message: unknown[]): void {
    if (this.closed) return;
    const text = JSON.stringify(message);
    if (!this.account(text.length)) return;
    this.socket.deliverFromServer(text, this.relay.behaviour.latency ?? 2);
  }
}

export class FakeNostrRelay {
  behaviour: RelayBehaviour;
  readonly stored: NostrEvent[] = [];
  readonly connections = new Set<Connection>();
  readonly stats = { events: 0, accepted: 0, refused: 0, freezes: 0, connections: 0 };

  constructor(
    readonly url: string,
    behaviour: RelayBehaviour = {},
    readonly clock: Clock = realClock,
  ) {
    this.behaviour = { verify: true, maxEventChars: 128_000, ...behaviour };
  }

  connect(socket: FakeSocket): Connection | null {
    if (this.behaviour.down) return null;
    const conn = new Connection(this, socket);
    this.connections.add(conn);
    this.stats.connections++;
    return conn;
  }

  receive(conn: Connection, text: string): void {
    if (!conn.account(text.length)) return;
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      conn.push(['NOTICE', 'invalid: not json']);
      return;
    }
    if (!Array.isArray(m)) return;
    if (m[0] === 'EVENT') this.onEvent(conn, m[1], text.length);
    else if (m[0] === 'REQ' && typeof m[1] === 'string') this.onReq(conn, m[1], m.slice(2) as Filter[]);
    else if (m[0] === 'CLOSE' && typeof m[1] === 'string') conn.subs.delete(m[1]);
  }

  private ok(conn: Connection, id: string, ok: boolean, message = ''): void {
    if (!ok) this.stats.refused++;
    if (this.behaviour.silent) return;
    conn.push(['OK', id, ok, message]);
  }

  private onEvent(conn: Connection, e: unknown, size: number): void {
    this.stats.events++;
    const id = typeof (e as { id?: unknown })?.id === 'string' ? (e as { id: string }).id : '';
    if (this.behaviour.refuse) return this.ok(conn, id, false, this.behaviour.refuse);
    if (this.behaviour.rateLimitEvery && this.stats.events % this.behaviour.rateLimitEvery === 0) return this.ok(conn, id, false, 'rate-limited: slow down');
    if (size > (this.behaviour.maxEventChars ?? Infinity)) return this.ok(conn, id, false, 'invalid: event too large');
    if (this.behaviour.verify ? !verifyEvent(e) : !e) return this.ok(conn, id, false, 'invalid: bad signature');
    const ev = e as NostrEvent;
    const now = Math.floor(this.clock.now() / 1000);
    if (isExpired(ev, now)) return this.ok(conn, id, false, 'invalid: event has expired');
    if (ev.created_at > now + 900) return this.ok(conn, id, false, 'invalid: created_at too far in the future');
    if (this.stored.some((x) => x.id === ev.id)) return this.ok(conn, id, true, 'duplicate: already have it');
    if (!isEphemeral(ev.kind)) {
      if (isReplaceable(ev.kind) || isParameterized(ev.kind)) {
        const d = isParameterized(ev.kind) ? (tagValue(ev, 'd') ?? '') : null;
        const same = (x: NostrEvent) => x.pubkey === ev.pubkey && x.kind === ev.kind && (d === null || (tagValue(x, 'd') ?? '') === d);
        const old = this.stored.find(same);
        if (old && (old.created_at > ev.created_at || (old.created_at === ev.created_at && old.id < ev.id))) {
          return this.ok(conn, id, true, 'duplicate: have a newer version');
        }
        if (old) this.stored.splice(this.stored.indexOf(old), 1);
      }
      this.stored.push(ev);
    }
    this.stats.accepted++;
    this.ok(conn, id, true);
    for (const other of this.connections) {
      for (const sub of other.subs.values()) {
        if (sub.filters.some((f) => matches(f, ev))) other.push(['EVENT', sub.id, ev]);
      }
    }
  }

  private onReq(conn: Connection, id: string, filters: Filter[]): void {
    if (this.behaviour.closeSubscriptions) {
      conn.push(['CLOSED', id, this.behaviour.closeSubscriptions]);
      return;
    }
    conn.subs.set(id, { id, filters });
    const now = Math.floor(this.clock.now() / 1000);
    for (const f of filters) {
      const limit = typeof f.limit === 'number' ? f.limit : 500;
      const found = this.stored
        .filter((e) => matches(f, e) && !isExpired(e, now))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, limit);
      for (const e of found) conn.push(['EVENT', id, e]);
    }
    conn.push(['EOSE', id]);
  }

  /** Kill every open connection (relay restart). */
  dropConnections(): void {
    for (const c of this.connections) c.socket.serverClose();
    this.connections.clear();
  }
}

export class FakeSocket implements WsLike {
  readyState = 0;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  private conn: Connection | null = null;

  constructor(
    readonly url: string,
    private relay: FakeNostrRelay | undefined,
    private clock: Clock,
  ) {
    const latency = relay?.behaviour.latency ?? 2;
    clock.setTimeout(() => {
      if (this.readyState === 3) return;
      this.conn = this.relay?.connect(this) ?? null;
      if (!this.conn) {
        this.readyState = 3;
        this.onerror?.({});
        this.onclose?.({ code: 1006 });
        return;
      }
      this.readyState = WS_OPEN;
      this.onopen?.({});
    }, latency);
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== WS_OPEN) throw new Error('socket not open');
    const conn = this.conn!;
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const latency = this.relay?.behaviour.latency ?? 2;
    this.clock.setTimeout(() => {
      if (!conn.closed) conn.relay.receive(conn, text);
    }, latency);
  }

  deliverFromServer(text: string, latency: number): void {
    this.clock.setTimeout(() => {
      if (this.readyState === WS_OPEN) this.onmessage?.({ data: text });
    }, latency);
  }

  serverClose(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.conn) this.conn.closed = true;
    this.onclose?.({ code: 1006 });
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.conn) {
      this.conn.closed = true;
      this.relay?.connections.delete(this.conn);
    }
    this.clock.setTimeout(() => this.onclose?.({ code: 1000 }), 0);
  }
}

/** A set of fake relays, reachable by URL through `ws`. */
export class FakeNostrNetwork {
  readonly relays = new Map<string, FakeNostrRelay>();
  constructor(readonly clock: Clock = realClock) {}

  add(url: string, behaviour: RelayBehaviour = {}): FakeNostrRelay {
    const relay = new FakeNostrRelay(url, behaviour, this.clock);
    this.relays.set(url, relay);
    return relay;
  }

  get(url: string): FakeNostrRelay {
    const r = this.relays.get(url);
    if (!r) throw new Error(`no fake relay ${url}`);
    return r;
  }

  get urls(): string[] {
    return [...this.relays.keys()];
  }

  /** A WebSocket factory that reaches these relays (unknown URLs fail like an unreachable host). */
  readonly ws: WsFactory = (url) => new FakeSocket(url, this.relays.get(url), this.clock);
}
