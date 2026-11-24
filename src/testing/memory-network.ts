/**
 * An in-process network for tests: any number of named media (think "the direct channel", "relay
 * A", "relay B"), each with its own latency, jitter, loss, duplication, partitions and freezes, all
 * driven by an injected clock. Paths created from a medium behave like real ones: a direct medium
 * only reaches a peer after an authenticated frame bound it; a relay medium reaches everyone.
 */
import { Emitter } from '../util/emitter.js';
import { realClock, type Clock } from '../util/timers.js';
import type { PeerId } from '../identity.js';
import type { Path, PathContext, PathEvents, PathFactory, PathKind } from '../paths/types.js';

export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededBytes(seed: number): (n: number) => Uint8Array {
  const rnd = seededRandom(seed);
  return (n) => Uint8Array.from({ length: n }, () => Math.floor(rnd() * 256));
}

export interface MediumOptions {
  direct?: boolean;
  kind?: PathKind;
  latency?: number;
  jitter?: number;
  /** probability a frame is lost */
  loss?: number;
  /** probability a frame is delivered twice */
  duplicate?: number;
  maxFrame?: number;
}

export interface MediumStats {
  sent: number;
  delivered: number;
  dropped: number;
  bytes: number;
}

class Medium {
  readonly members = new Map<PeerId, MemoryPath>();
  readonly blocked = new Set<string>();
  readonly frozen = new Set<PeerId>();
  up = true;
  stats: MediumStats = { sent: 0, delivered: 0, dropped: 0, bytes: 0 };
  constructor(
    readonly name: string,
    public opts: Required<MediumOptions>,
    private net: MemoryNetwork,
  ) {}

  canTalk(a: PeerId, b: PeerId): boolean {
    return this.up && !this.blocked.has(`${a}|${b}`) && !this.frozen.has(a) && !this.frozen.has(b);
  }

  transmit(from: MemoryPath, to: PeerId | null, frame: Uint8Array): void {
    const targets = to === null ? [...this.members.values()].filter((m) => m !== from) : [this.members.get(to)].filter(Boolean);
    for (const target of targets as MemoryPath[]) {
      this.stats.sent++;
      this.stats.bytes += frame.length;
      if (!this.canTalk(from.self, target.self) || this.net.random() < this.opts.loss) {
        this.stats.dropped++;
        continue;
      }
      const copies = this.net.random() < this.opts.duplicate ? 2 : 1;
      for (let i = 0; i < copies; i++) {
        const delay = this.opts.latency + this.net.random() * this.opts.jitter;
        const copy = frame.slice();
        this.net.clock.setTimeout(() => {
          // conditions may have changed while the frame was in flight
          if (!this.canTalk(from.self, target.self) || target.closed || !this.members.has(target.self)) {
            this.stats.dropped++;
            return;
          }
          this.stats.delivered++;
          target.deliver(copy, from.self);
        }, delay);
      }
    }
  }
}

export class MemoryPath implements Path {
  readonly events = new Emitter<PathEvents>();
  readonly kind: PathKind;
  readonly direct: boolean;
  readonly maxFrame: number;
  closed = false;
  private bound = new Set<PeerId>();
  sentFrames = 0;

  constructor(
    readonly name: string,
    readonly self: PeerId,
    private medium: Medium,
  ) {
    this.kind = medium.opts.kind;
    this.direct = medium.opts.direct;
    this.maxFrame = medium.opts.maxFrame;
  }

  get up(): boolean {
    return !this.closed && this.medium.up;
  }

  reachable(peer: PeerId): boolean {
    if (!this.up || !this.medium.members.has(peer)) return false;
    return this.direct ? this.bound.has(peer) : true;
  }

  send(to: PeerId | null, frame: Uint8Array): boolean {
    if (!this.up) return false;
    if (frame.length > this.maxFrame) throw new Error(`memory path ${this.name}: frame ${frame.length} > ${this.maxFrame}`);
    this.sentFrames++;
    this.medium.transmit(this, to, frame);
    return true;
  }

  bind(peer: PeerId, via: unknown): void {
    if (this.direct && via === peer && this.medium.members.has(peer)) this.bound.add(peer);
  }

  deliver(frame: Uint8Array, from: PeerId): void {
    if (!this.closed) this.events.emit('frame', frame, from);
  }

  peerLeft(peer: PeerId): void {
    if (this.bound.delete(peer)) this.events.emit('via-gone', peer);
  }

  status(): Record<string, unknown> {
    return { medium: this.medium.name, up: this.up, bound: [...this.bound] };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.medium.members.delete(this.self);
    for (const member of this.medium.members.values()) member.peerLeft(this.self);
    this.events.emit('down');
  }
}

export class MemoryNetwork {
  readonly random: () => number;
  private media = new Map<string, Medium>();

  constructor(
    readonly clock: Clock = realClock,
    seed = 1,
  ) {
    this.random = seededRandom(seed);
  }

  medium(name: string, opts: MediumOptions = {}): this {
    const full: Required<MediumOptions> = {
      direct: opts.direct ?? false,
      kind: opts.kind ?? 'memory',
      latency: opts.latency ?? 10,
      jitter: opts.jitter ?? 0,
      loss: opts.loss ?? 0,
      duplicate: opts.duplicate ?? 0,
      maxFrame: opts.maxFrame ?? 16_384,
    };
    const existing = this.media.get(name);
    if (existing) existing.opts = full;
    else this.media.set(name, new Medium(name, full, this));
    return this;
  }

  /** Change conditions of a medium on the fly. */
  set(name: string, opts: Partial<MediumOptions>): void {
    const m = this.get(name);
    m.opts = { ...m.opts, ...opts };
  }

  stats(name: string): MediumStats {
    return this.get(name).stats;
  }

  private get(name: string): Medium {
    const m = this.media.get(name);
    if (!m) throw new Error(`no medium ${name}`);
    return m;
  }

  /** A path factory for `joinRoom({ paths: [...] })`. */
  path(name: string): PathFactory {
    return (ctx: PathContext) => this.attach(name, ctx.self);
  }

  attach(name: string, self: PeerId): MemoryPath {
    const m = this.get(name);
    const path = new MemoryPath(name, self, m);
    m.members.set(self, path);
    return path;
  }

  /** Whole medium down / up (paths emit down/up). */
  setUp(name: string, up: boolean): void {
    const m = this.get(name);
    if (m.up === up) return;
    m.up = up;
    for (const member of m.members.values()) member.events.emit(up ? 'up' : 'down');
  }

  /** Silently drop frames between a and b (both directions), the paths still look healthy. */
  partition(name: string, a: PeerId, b: PeerId, blocked = true): void {
    const m = this.get(name);
    for (const key of [`${a}|${b}`, `${b}|${a}`]) blocked ? m.blocked.add(key) : m.blocked.delete(key);
  }

  /** Silently drop everything to and from a peer on a medium (a frozen socket / dead channel). */
  freeze(name: string, peer: PeerId, frozen = true): void {
    const m = this.get(name);
    frozen ? m.frozen.add(peer) : m.frozen.delete(peer);
  }

  /** Remove a peer from a direct medium as if its data channel closed. */
  disconnect(name: string, a: PeerId, b: PeerId): void {
    const m = this.get(name);
    m.members.get(a)?.peerLeft(b);
    m.members.get(b)?.peerLeft(a);
  }
}
