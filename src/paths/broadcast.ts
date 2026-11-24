/**
 * Tabs of the same browser (same origin) talk through a BroadcastChannel: instant local multiplayer
 * for development ("open the game in two tabs") and a fast path for tests. It counts as a direct path.
 */
import { Emitter } from '../util/emitter.js';
import { asBytes } from '../util/bytes.js';
import type { PeerId } from '../identity.js';
import type { Path, PathContext, PathEvents, PathFactory } from './types.js';

interface Envelope {
  hl: 1;
  from: PeerId;
  to: PeerId | null;
  frame: Uint8Array;
}

export class BroadcastPath implements Path {
  readonly kind = 'broadcast' as const;
  readonly direct = true;
  readonly name: string;
  readonly maxFrame = 64_000;
  readonly events = new Emitter<PathEvents>();
  private channel: BroadcastChannel | null = null;
  private seen = new Set<PeerId>();
  private closed = false;

  constructor(
    private ctx: PathContext,
    name = 'broadcast',
  ) {
    this.name = name;
    const Ctor = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
    if (!Ctor) return;
    this.channel = new Ctor(`hostless/${ctx.secrets.topic}`);
    this.channel.onmessage = (ev: MessageEvent) => {
      const m = ev.data as Partial<Envelope>;
      if (!m || m.hl !== 1 || typeof m.from !== 'string' || m.from === ctx.self) return;
      if (m.to !== null && m.to !== ctx.self) return;
      const frame = asBytes(m.frame);
      if (!frame) return;
      if (!this.seen.has(m.from)) {
        this.seen.add(m.from);
        this.events.emit('via-join', m.from);
      }
      this.events.emit('frame', frame, m.from);
    };
    queueMicrotask(() => this.events.emit('up'));
  }

  get up(): boolean {
    return !this.closed && this.channel !== null;
  }

  reachable(peer: PeerId): boolean {
    return this.up && this.seen.has(peer);
  }

  bind(peer: PeerId, via: unknown): void {
    if (via === peer) this.seen.add(peer);
  }

  send(to: PeerId | null, frame: Uint8Array): boolean {
    if (!this.up) return false;
    try {
      this.channel!.postMessage({ hl: 1, from: this.ctx.self, to, frame } satisfies Envelope);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel?.close();
    this.events.emit('down');
  }
}

export function broadcastPath(name?: string): PathFactory {
  return (ctx) => new BroadcastPath(ctx, name);
}
