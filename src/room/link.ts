/**
 * Reliability towards one remote peer session, over every path that can reach it.
 *
 * Every path is used at once, in the way that works best right now:
 *   - the direct path alone while it is healthy (traffic within `directStaleMs`, not suspected);
 *   - otherwise every reachable relay at once (the receiver keeps the first copy).
 *
 * Messages are JSON values, deflated above `compressAbove` bytes, cut into segments that fit the
 * smallest frame of any path, and numbered. The receiver delivers strictly in order without
 * duplicates and acknowledges cumulatively (delayed, so acks batch), reporting holes that lasted a
 * while (SACK). Anything unacknowledged after one RTO is sent again on ALL reachable paths, so a
 * direct channel that dies silently costs one timeout, not a reconnect. A path that becomes reachable
 * immediately carries everything still unacknowledged. A send window keeps bursts off the relays.
 *
 * Ported from influence-web `multipath.ts` (MpPeer), generalised to named paths, fragmentation,
 * compression and flow control.
 */
import { deflate, inflate } from '../crypto/compress.js';
import { fromUtf8, utf8 } from '../util/bytes.js';
import { netlog } from '../util/log.js';
import type { Clock } from '../util/timers.js';
import {
  ANY_SID,
  DATA_SEG_HEADER,
  decodeSegment,
  encodeSegment,
  FLAG_DEFLATED,
  FLAG_FIRST,
  FLAG_LAST,
  MAX_MISSING,
  pathCode,
  SEG_HEADER,
  SegType,
  type Segment,
} from './segments.js';

export interface LinkPath {
  name: string;
  direct: boolean;
}

export interface LinkIO {
  /** paths that can reach the peer right now */
  paths(): LinkPath[];
  /** send one encoded segment on a path */
  send(path: string, segment: Uint8Array): boolean;
  deliver(value: unknown, reliable: boolean): void;
  /** the peer still addresses an older session of ours (it needs our new hello) */
  staleTarget(path: string): void;
  /** the peer said goodbye */
  bye(): void;
  /** the send queue is full: the message was refused */
  overflow?(): void;
}

export interface LinkOptions {
  directPingMs?: number;
  /** ping interval on relays while they carry the traffic */
  relayPingMs?: number;
  /** ping interval on relays while the direct path is healthy */
  idlePingMs?: number;
  directStaleMs?: number;
  ackDelayMs?: number;
  relayAckDelayMs?: number;
  minRtoMs?: number;
  minRelayRtoMs?: number;
  maxRtoMs?: number;
  holeMs?: number;
  /** payload bytes per data segment (the room derives it from the smallest path frame) */
  segmentBytes?: number;
  maxMessageBytes?: number;
  /** segments queued or in flight before `send` refuses */
  maxQueued?: number;
  /** segments in flight while the direct path carries the traffic */
  windowDirect?: number;
  /** segments in flight while relays carry it */
  windowRelay?: number;
  compressAbove?: number;
  label?: string;
}

const DEFAULTS: Required<Omit<LinkOptions, 'label'>> = {
  directPingMs: 2000,
  relayPingMs: 4000,
  idlePingMs: 30_000,
  directStaleMs: 5000,
  ackDelayMs: 20,
  relayAckDelayMs: 200,
  minRtoMs: 250,
  minRelayRtoMs: 700,
  maxRtoMs: 4000,
  holeMs: 150,
  segmentBytes: 1200,
  maxMessageBytes: 1 << 20,
  maxQueued: 4000,
  windowDirect: 256,
  windowRelay: 24,
  compressAbove: 1024,
};

interface Pending {
  flags: number;
  payload: Uint8Array;
  /** first transmission time, 0: not sent yet (outside the window) */
  first: number;
  last: number;
  tries: number;
  paths: string[];
}

export interface LinkStats {
  sentMessages: number;
  sentSegments: number;
  retransmits: number;
  receivedMessages: number;
  duplicates: number;
}

export class Link {
  private o: Required<Omit<LinkOptions, 'label'>>;
  private label: string;
  private txSeq = 0;
  private unacked = new Map<number, Pending>();
  private rxNext = 1;
  private rxBuf = new Map<number, { flags: number; payload: Uint8Array }>();
  private rxParts: Uint8Array[] = [];
  private rxPartBytes = 0;
  private rxDeflated = false;
  private rxDropping = false;
  private holeSince = 0;
  private ackDue = new Set<string>();
  private ackTimer: unknown = null;
  private rtts = new Map<string, number>();
  private lastRx = new Map<string, number>();
  private openedAt = new Map<string, number>();
  private lastPing = new Map<string, number>();
  private srtt: number | null = null;
  private rttvar = 0;
  private directSuspectAt = 0;
  private staleNoticeAt = 0;
  /** congestion window (segments in flight), AIMD: halved... down to 2 on a timeout, grows with acks */
  private cwnd: number;
  private ssthresh: number;
  private lastCut = 0;
  stopped = false;
  /** last time anything authenticated arrived from the peer */
  lastHeard: number;
  readonly stats: LinkStats = { sentMessages: 0, sentSegments: 0, retransmits: 0, receivedMessages: 0, duplicates: 0 };

  constructor(
    readonly mySid: string,
    public peerSid: string,
    private io: LinkIO,
    private clock: Clock,
    opts: LinkOptions = {},
  ) {
    this.o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) } as typeof this.o;
    this.label = opts.label ?? peerSid;
    this.lastHeard = clock.now();
    this.cwnd = Math.min(8, this.o.windowRelay);
    this.ssthresh = this.o.windowDirect;
  }

  // ---------------------------------------------------------------- path choice

  private directHealthy(now: number, open: LinkPath[]): LinkPath | null {
    for (const p of open) {
      if (!p.direct) continue;
      const rx = this.lastRx.get(p.name) ?? 0;
      if (this.directSuspectAt && rx <= this.directSuspectAt) continue;
      const since = Math.max(rx, this.openedAt.get(p.name) ?? 0);
      if (now - since < this.o.directStaleMs) return p;
    }
    return null;
  }

  /** where new traffic goes now */
  best(now = this.clock.now()): string[] {
    const open = this.io.paths();
    const direct = this.directHealthy(now, open);
    if (direct) return [direct.name];
    const relays = open.filter((p) => !p.direct).map((p) => p.name);
    return relays.length ? relays : open.map((p) => p.name);
  }

  /** 'direct' | 'relay' | null (nothing reaches the peer) */
  route(): 'direct' | 'relay' | null {
    const now = this.clock.now();
    const open = this.io.paths();
    if (!open.length) return null;
    return this.directHealthy(now, open) ? 'direct' : open.some((p) => !p.direct) ? 'relay' : 'direct';
  }

  rttOf(path: string): number | null {
    return this.rtts.get(path) ?? null;
  }

  /** round trip on the path(s) in use */
  rtt(): number | null {
    let best: number | null = null;
    for (const name of this.best()) {
      const v = this.rtts.get(name);
      if (v !== undefined && (best === null || v < best)) best = v;
    }
    return best ?? (this.srtt === null ? null : Math.round(this.srtt));
  }

  get queued(): number {
    return this.unacked.size;
  }

  /** every queued message has been acknowledged */
  get idle(): boolean {
    return this.unacked.size === 0;
  }

  // ---------------------------------------------------------------- path events

  pathUp(path: string): void {
    if (this.stopped) return;
    this.openedAt.set(path, this.clock.now());
    this.lastPing.delete(path);
    // ping at once: measures the path and proves it to the peer
    this.ping(path);
    // the new path carries what is still unacknowledged right away (seamless switch)
    const now = this.clock.now();
    for (const [seq, p] of this.unacked) {
      if (!p.first) continue;
      this.transmit(path, seq, p);
      p.last = now;
    }
  }

  pathDown(path: string): void {
    this.openedAt.delete(path);
    this.lastRx.delete(path);
    this.rtts.delete(path);
    this.lastPing.delete(path);
    this.ackDue.delete(path);
  }

  // ---------------------------------------------------------------- sending

  /** Queue a message. false: refused (stopped, too large, or the queue is full). */
  send(value: unknown, reliable = true): boolean {
    if (this.stopped) return false;
    let bytes: Uint8Array;
    try {
      bytes = utf8(JSON.stringify(value) ?? 'null');
    } catch {
      return false;
    }
    if (bytes.length > this.o.maxMessageBytes) return false;
    if (!reliable && bytes.length <= this.o.segmentBytes + DATA_SEG_HEADER - SEG_HEADER) {
      const seg = encodeSegment({ t: SegType.Unreliable, fs: this.mySid, ts: this.peerSid, payload: bytes });
      let ok = false;
      for (const path of this.best()) ok = this.io.send(path, seg) || ok;
      return ok;
    }
    let flags = 0;
    if (bytes.length > this.o.compressAbove) {
      const packed = deflate(bytes);
      if (packed.length < bytes.length * 0.9) {
        bytes = packed;
        flags = FLAG_DEFLATED;
      }
    }
    const size = this.o.segmentBytes;
    const count = Math.max(1, Math.ceil(bytes.length / size));
    if (this.unacked.size + count > this.o.maxQueued) {
      netlog('link-overflow', { peer: this.label, queued: this.unacked.size, count });
      this.io.overflow?.();
      return false;
    }
    for (let i = 0; i < count; i++) {
      const part = bytes.subarray(i * size, Math.min(bytes.length, (i + 1) * size));
      const f = (i === 0 ? FLAG_FIRST | flags : 0) | (i === count - 1 ? FLAG_LAST : 0);
      this.unacked.set(++this.txSeq, { flags: f, payload: part, first: 0, last: 0, tries: 0, paths: [] });
    }
    this.stats.sentMessages++;
    this.pump();
    return true;
  }

  /** segments allowed in flight now: the congestion window, capped by the route's maximum */
  private window(): number {
    const cap = this.directHealthy(this.clock.now(), this.io.paths()) ? this.o.windowDirect : this.o.windowRelay;
    return Math.max(1, Math.min(cap, Math.floor(this.cwnd)));
  }

  /** a retransmission timeout: the path(s) are congested or lossy, send less */
  private congestion(now: number): void {
    // one cut per round trip at most
    if (now - this.lastCut < this.rto()) return;
    this.lastCut = now;
    const inFlight = this.inFlight();
    this.ssthresh = Math.max(2, Math.floor(Math.max(inFlight, this.cwnd) / 2));
    this.cwnd = 2;
    netlog('link-congestion', { peer: this.label, ssthresh: this.ssthresh });
  }

  private grow(acked: number): void {
    const cap = Math.max(this.o.windowDirect, this.o.windowRelay);
    if (this.cwnd < this.ssthresh) this.cwnd = Math.min(cap, this.cwnd + acked);
    else this.cwnd = Math.min(cap, this.cwnd + acked / this.cwnd);
  }

  private inFlight(): number {
    let n = 0;
    for (const p of this.unacked.values()) {
      if (!p.first) break;
      n++;
    }
    return n;
  }

  /** send not-yet-sent segments that fit in the window */
  private pump(): void {
    if (!this.unacked.size) return;
    const now = this.clock.now();
    const lowest = this.unacked.keys().next().value as number;
    const limit = lowest + this.window();
    const paths = this.best(now);
    if (!paths.length) return;
    for (const [seq, p] of this.unacked) {
      if (seq >= limit) break;
      if (p.first) continue;
      p.first = p.last = now;
      p.paths = paths;
      for (const path of paths) this.transmit(path, seq, p);
      for (const path of paths) this.ackDue.delete(path);
    }
  }

  private transmit(path: string, seq: number, p: Pending): void {
    const seg = encodeSegment({ t: SegType.Data, fs: this.mySid, ts: this.peerSid, seq, ack: this.rxNext - 1, flags: p.flags, payload: p.payload });
    this.stats.sentSegments++;
    this.io.send(path, seg);
  }

  private ctl(path: string, seg: Segment): void {
    this.io.send(path, encodeSegment(seg));
  }

  private ping(path: string): void {
    const now = this.clock.now();
    this.lastPing.set(path, now);
    this.ctl(path, { t: SegType.Ping, fs: this.mySid, ts: this.peerSid, t0: now, path: pathCode(path) });
  }

  private sendAck(): void {
    const missing: number[] = [];
    if (this.rxBuf.size && this.holeSince && this.clock.now() - this.holeSince >= this.o.holeMs) {
      const top = Math.max(...this.rxBuf.keys());
      for (let s = this.rxNext; s < top && missing.length < MAX_MISSING; s++) if (!this.rxBuf.has(s)) missing.push(s);
    }
    const seg: Segment = { t: SegType.Ack, fs: this.mySid, ts: this.peerSid, ack: this.rxNext - 1, missing };
    const open = new Set(this.io.paths().map((p) => p.name));
    let sent = false;
    for (const path of this.ackDue) {
      if (!open.has(path)) continue;
      this.ctl(path, seg);
      sent = true;
    }
    if (!sent) for (const path of this.best()) this.ctl(path, seg);
    this.ackDue.clear();
  }

  bye(): void {
    for (const p of this.io.paths()) this.ctl(p.name, { t: SegType.Bye, fs: this.mySid, ts: this.peerSid });
  }

  // ---------------------------------------------------------------- receiving

  /** A decrypted segment from the peer arrived on `path`. */
  receive(path: string, raw: Uint8Array | Segment): void {
    if (this.stopped) return;
    const seg = raw instanceof Uint8Array ? decodeSegment(raw) : raw;
    if (!seg || seg.fs !== this.peerSid) return;
    const now = this.clock.now();
    if (seg.ts !== this.mySid && seg.ts !== ANY_SID) {
      // addressed to an earlier page of ours
      if (now - this.staleNoticeAt > 1000) {
        this.staleNoticeAt = now;
        this.io.staleTarget(path);
      }
      return;
    }
    const quietFor = now - (this.lastRx.get(path) ?? now);
    this.lastRx.set(path, now);
    this.lastHeard = now;
    if (quietFor > 1000 && this.unacked.size) this.kick(path, now);
    switch (seg.t) {
      case SegType.Data:
        this.onAck(seg.ack, now);
        this.onData(path, seg.seq, seg.flags, seg.payload, now);
        break;
      case SegType.Ack:
        this.onAck(seg.ack, now);
        if (seg.missing.length) this.fastRetransmit(seg.missing, now);
        break;
      case SegType.Ping:
        this.ctl(path, { t: SegType.Pong, fs: this.mySid, ts: this.peerSid, t0: seg.t0, path: seg.path });
        break;
      case SegType.Pong: {
        const r = Math.max(0, now - seg.t0);
        const old = this.rtts.get(path);
        this.rtts.set(path, old === undefined ? r : Math.round(old * 0.6 + r * 0.4));
        break;
      }
      case SegType.Unreliable:
        this.deliverBytes(seg.payload, false);
        break;
      case SegType.Bye:
        this.io.bye();
        break;
    }
    this.pump();
  }

  private onData(path: string, seq: number, flags: number, payload: Uint8Array, now: number): void {
    this.ackDue.add(path);
    if (!this.ackTimer) {
      const direct = this.io.paths().find((p) => p.name === path)?.direct ?? false;
      this.ackTimer = this.clock.setTimeout(
        () => {
          this.ackTimer = null;
          if (!this.stopped && this.ackDue.size) this.sendAck();
        },
        direct ? this.o.ackDelayMs : this.o.relayAckDelayMs,
      );
    }
    if (seq < this.rxNext || this.rxBuf.has(seq)) {
      this.stats.duplicates++;
      return;
    }
    if (seq > this.rxNext + this.o.maxQueued) return; // far outside any window: corrupt or hostile
    this.rxBuf.set(seq, { flags, payload: payload.slice() });
    if (seq !== this.rxNext && !this.holeSince) this.holeSince = now;
    while (this.rxBuf.has(this.rxNext) && !this.stopped) {
      const part = this.rxBuf.get(this.rxNext)!;
      this.rxBuf.delete(this.rxNext);
      this.rxNext++;
      this.assemble(part.flags, part.payload);
    }
    if (!this.rxBuf.size) this.holeSince = 0;
    else if (seq === this.rxNext - 1 || !this.holeSince) this.holeSince = now;
  }

  private assemble(flags: number, payload: Uint8Array): void {
    if (flags & FLAG_FIRST) {
      this.rxParts = [];
      this.rxPartBytes = 0;
      this.rxDeflated = (flags & FLAG_DEFLATED) !== 0;
      this.rxDropping = false;
    }
    if (this.rxDropping) {
      if (flags & FLAG_LAST) this.rxDropping = false;
      return;
    }
    this.rxParts.push(payload);
    this.rxPartBytes += payload.length;
    if (this.rxPartBytes > this.o.maxMessageBytes) {
      netlog('link-oversize', { peer: this.label, bytes: this.rxPartBytes });
      this.rxParts = [];
      this.rxDropping = !(flags & FLAG_LAST);
      return;
    }
    if (!(flags & FLAG_LAST)) return;
    const whole = new Uint8Array(this.rxPartBytes);
    let at = 0;
    for (const part of this.rxParts) {
      whole.set(part, at);
      at += part.length;
    }
    this.rxParts = [];
    this.rxPartBytes = 0;
    const plain = this.rxDeflated ? inflate(whole, this.o.maxMessageBytes) : whole;
    if (plain) this.deliverBytes(plain, true);
  }

  private deliverBytes(bytes: Uint8Array, reliable: boolean): void {
    let value: unknown;
    try {
      value = JSON.parse(fromUtf8(bytes));
    } catch {
      return;
    }
    this.stats.receivedMessages++;
    this.io.deliver(value, reliable);
  }

  /** re-send on `path`, now, what waits longer than one RTO */
  private kick(path: string, now: number): void {
    const rto = this.rto();
    let budget = this.window();
    for (const [seq, p] of this.unacked) {
      if (!p.first || budget-- <= 0) break;
      if (now - p.last < rto) continue;
      p.tries++;
      p.last = now;
      this.stats.retransmits++;
      this.transmit(path, seq, p);
    }
  }

  private fastRetransmit(missing: number[], now: number): void {
    const gap = Math.max(40, (this.srtt ?? 200) * 0.5);
    const open = this.io.paths().map((p) => p.name);
    let budget = this.window();
    for (const seq of missing) {
      if (budget-- <= 0) break;
      const p = this.unacked.get(seq);
      if (!p || !p.first || now - p.last < gap) continue;
      p.tries++;
      p.last = now;
      p.paths = open;
      this.stats.retransmits++;
      for (const path of open) this.transmit(path, seq, p);
    }
  }

  private onAck(ack: number, now: number): void {
    let acked = 0;
    for (const [seq, p] of this.unacked) {
      if (seq > ack) break;
      if (!p.first) break; // never sent: an ack beyond what we sent is bogus
      if (p.tries === 0) {
        const ms = now - p.first;
        if (this.srtt === null) {
          this.srtt = ms;
          this.rttvar = ms / 2;
        } else {
          this.rttvar = this.rttvar * 0.75 + Math.abs(this.srtt - ms) * 0.25;
          this.srtt = this.srtt * 0.875 + ms * 0.125;
        }
      }
      this.unacked.delete(seq);
      acked++;
    }
    if (acked) this.grow(acked);
  }

  private rto(): number {
    const viaDirect = this.directHealthy(this.clock.now(), this.io.paths()) !== null;
    const floor = viaDirect ? this.o.minRtoMs : this.o.minRelayRtoMs;
    if (this.srtt === null) return Math.max(floor, Math.min(this.o.maxRtoMs, (this.rtt() ?? 600) * 1.5 + 200));
    return Math.max(floor, Math.min(this.o.maxRtoMs, this.srtt + Math.max(this.srtt * 0.5, 4 * this.rttvar)));
  }

  // ---------------------------------------------------------------- timer

  tick(now = this.clock.now()): void {
    if (this.stopped) return;
    const open = this.io.paths();
    if (!open.length) return;
    const names = open.map((p) => p.name);
    if (this.unacked.size) {
      const rto = this.rto();
      const due: Array<[number, Pending]> = [];
      for (const [seq, p] of this.unacked) {
        if (!p.first) break;
        if (now - p.last >= rto * 2 ** Math.min(p.tries, 3)) due.push([seq, p]);
      }
      if (due.length) {
        // a timeout: shrink the window, and re-send only the oldest segments that fit in it. A burst
        // of everything unacknowledged would itself overload a relay socket that carries a few KB.
        this.congestion(now);
        for (const [seq, p] of due.slice(0, this.window())) {
          if (p.tries === 0 && p.paths.length === 1 && open.find((o) => o.name === p.paths[0])?.direct && open.length > 1) {
            // sent on the direct path alone and not acknowledged: avoid it until it speaks again
            this.directSuspectAt = now;
            netlog('direct-suspect', { peer: this.label, seq });
          }
          p.tries++;
          p.last = now;
          p.paths = names;
          this.stats.retransmits++;
          for (const path of names) this.transmit(path, seq, p);
        }
      }
    }
    this.pump();
    const healthy = this.directHealthy(now, open) !== null;
    for (const p of open) {
      const every = p.direct ? this.o.directPingMs : healthy ? this.o.idlePingMs : this.o.relayPingMs;
      if (now - (this.lastPing.get(p.name) ?? 0) >= every) this.ping(p.name);
    }
  }

  /** The peer page restarted (new session): forget every sequence state. */
  reset(peerSid: string): void {
    this.peerSid = peerSid;
    this.txSeq = 0;
    this.unacked.clear();
    this.rxNext = 1;
    this.rxBuf.clear();
    this.rxParts = [];
    this.rxPartBytes = 0;
    this.holeSince = 0;
    this.ackDue.clear();
    this.srtt = null;
    this.rttvar = 0;
    this.directSuspectAt = 0;
    this.cwnd = Math.min(8, this.o.windowRelay);
    this.ssthresh = this.o.windowDirect;
    this.lastHeard = this.clock.now();
  }

  stop(): void {
    this.stopped = true;
    if (this.ackTimer) this.clock.clearTimeout(this.ackTimer);
    this.ackTimer = null;
    this.unacked.clear();
    this.rxBuf.clear();
  }
}
