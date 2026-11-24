/**
 * The direct path: WebRTC data channels opened by Trystero, with signaling over public Nostr relays
 * (no signaling server of our own). The signaling room is the room's public topic and the Trystero
 * password is derived from the room code, so offers/answers are encrypted for code holders only.
 *
 * Trystero peers are transport connections; the room learns which identity sits behind each one from
 * the first authenticated frame it sends (`bind`). A connection that closes unbinds its identity and
 * the link layer moves traffic to the relays at once.
 *
 * Trystero is loaded lazily, so pages that never use the direct path never download it.
 */
import { Emitter } from '../util/emitter.js';
import { asBytes } from '../util/bytes.js';
import { netlog } from '../util/log.js';
import type { PeerId } from '../identity.js';
import type { Path, PathContext, PathEvents, PathFactory } from './types.js';
import { DEFAULT_SIGNALING_RELAYS, DEFAULT_STUN } from './defaults.js';

/** The part of a Trystero room this path uses (injectable for tests). */
export interface TrysteroRoomLike {
  makeAction(namespace: string): {
    send(data: Uint8Array, options?: { target?: string | string[] | null }): Promise<void>;
    onMessage(handler: (data: unknown, ctx: { peerId: string }) => unknown): unknown;
  };
  onPeerJoin(handler: (ctx: { peerId: string }) => unknown, options?: { replay?: boolean }): unknown;
  onPeerLeave(handler: (ctx: { peerId: string }) => unknown): unknown;
  onError?(handler: (error: { code: string; message?: string }) => unknown): unknown;
  leave(): Promise<void>;
}

export type TrysteroJoin = (config: Record<string, unknown>, roomId: string) => TrysteroRoomLike;

export interface DirectPathOptions {
  /** Nostr relays for signaling */
  relays?: readonly string[];
  /** TURN servers (none by default: relays take over when WebRTC cannot connect) */
  turn?: Array<{ urls: string | string[]; username?: string; credential?: string }>;
  stun?: readonly string[];
  rtcConfig?: RTCConfiguration;
  name?: string;
  maxFrame?: number;
  /** override the Trystero loader (tests, custom builds) */
  joinRoom?: TrysteroJoin | (() => Promise<TrysteroJoin>);
}

let trysteroLoader: Promise<TrysteroJoin> | null = null;
function loadTrystero(): Promise<TrysteroJoin> {
  return (trysteroLoader ??= import('trystero').then((m) => (m as unknown as { joinRoom: TrysteroJoin }).joinRoom));
}

export class DirectPath implements Path {
  readonly kind = 'direct' as const;
  readonly direct = true;
  readonly name: string;
  readonly maxFrame: number;
  readonly events = new Emitter<PathEvents>();
  private room: TrysteroRoomLike | null = null;
  private action: ReturnType<TrysteroRoomLike['makeAction']> | null = null;
  private channels = new Set<string>();
  private byPeer = new Map<PeerId, string>();
  private closed = false;
  private failure: string | null = null;

  constructor(
    private ctx: PathContext,
    private o: DirectPathOptions = {},
  ) {
    this.name = o.name ?? 'direct';
    this.maxFrame = o.maxFrame ?? 16_000;
  }

  /** resolves once Trystero is loaded and the signaling room joined (or failed) */
  async start(): Promise<this> {
    if (typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection !== 'function' && !this.o.joinRoom) {
      this.failure = 'no WebRTC in this browser';
      return this;
    }
    let join: TrysteroJoin;
    try {
      const j = this.o.joinRoom;
      join = j ? (j.length === 0 ? await (j as () => Promise<TrysteroJoin>)() : (j as TrysteroJoin)) : await loadTrystero();
    } catch (error) {
      this.failure = `could not load Trystero: ${String(error)}`;
      this.events.emit('error', 'unsupported', this.failure);
      return this;
    }
    if (this.closed) return this;
    const iceServers = [...(this.o.stun ?? DEFAULT_STUN).map((urls) => ({ urls })), ...(this.o.turn ?? [])];
    try {
      this.room = join(
        {
          appId: `hostless/${this.ctx.appId}`,
          password: this.ctx.secrets.rtcPassword,
          identity: 'none',
          maxUsers: this.ctx.maxPeers,
          maxReceiveBytes: this.maxFrame + 1024,
          relayConfig: { urls: [...(this.o.relays ?? DEFAULT_SIGNALING_RELAYS)], warnOnRelayFailure: false },
          rtcConfig: { iceServers, ...this.o.rtcConfig },
          ...(this.o.turn?.length ? { turnConfig: this.o.turn } : {}),
        },
        this.ctx.secrets.topic,
      );
    } catch (error) {
      this.failure = `Trystero failed: ${String(error)}`;
      this.events.emit('error', 'unsupported', this.failure);
      return this;
    }
    const action = this.room.makeAction('hl');
    this.action = action;
    action.onMessage((data, { peerId }) => {
      const bytes = asBytes(data);
      if (bytes && bytes.length <= this.maxFrame + 1024) this.events.emit('frame', bytes, peerId);
    });
    this.room.onPeerJoin(
      ({ peerId }) => {
        const wasUp = this.up;
        this.channels.add(peerId);
        netlog('direct-channel', { via: peerId });
        if (!wasUp) this.events.emit('up');
        this.events.emit('via-join', peerId);
      },
      { replay: true },
    );
    this.room.onPeerLeave(({ peerId }) => {
      if (!this.channels.delete(peerId)) return;
      for (const [peer, via] of this.byPeer) if (via === peerId) this.byPeer.delete(peer);
      this.events.emit('via-gone', peerId);
      if (!this.up) this.events.emit('down');
    });
    this.room.onError?.((error) => {
      netlog('direct-error', { code: error.code, message: error.message });
      this.events.emit('error', error.code, error.message ?? '');
    });
    return this;
  }

  /** at least one data channel is open */
  get up(): boolean {
    return !this.closed && this.channels.size > 0;
  }

  reachable(peer: PeerId): boolean {
    const via = this.byPeer.get(peer);
    return via !== undefined && this.channels.has(via);
  }

  bind(peer: PeerId, via: unknown): void {
    if (typeof via !== 'string' || !this.channels.has(via)) return;
    this.byPeer.set(peer, via);
  }

  send(to: PeerId | null, frame: Uint8Array): boolean {
    if (!this.action || this.closed) return false;
    if (frame.length > this.maxFrame) throw new Error(`direct path: frame ${frame.length} > ${this.maxFrame}`);
    const target = to === null ? null : this.byPeer.get(to);
    if (to !== null && (!target || !this.channels.has(target))) return false;
    if (to === null && !this.channels.size) return false;
    this.action.send(frame, { target: target ?? null }).catch((error) => {
      netlog('direct-send-failed', { error: String(error) });
    });
    return true;
  }

  status(): Record<string, unknown> {
    return { channels: this.channels.size, bound: this.byPeer.size, failure: this.failure };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.room?.leave().catch(() => {});
    this.channels.clear();
    this.byPeer.clear();
    this.events.emit('down');
  }
}

export function directPath(options: DirectPathOptions = {}): PathFactory {
  return (ctx) => new DirectPath(ctx, options).start();
}
