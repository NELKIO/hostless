/**
 * A fake Trystero for tests: rooms by id, peers connect to each other automatically after a delay,
 * actions deliver over the injected clock, and channels can be broken on demand.
 */
import { realClock, type Clock } from '../util/timers.js';
import type { TrysteroJoin, TrysteroRoomLike } from '../paths/direct.js';

interface FakePeer {
  id: string;
  roomId: string;
  password: string;
  joinHandlers: Array<(ctx: { peerId: string }) => unknown>;
  leaveHandlers: Array<(ctx: { peerId: string }) => unknown>;
  messageHandlers: Array<(data: unknown, ctx: { peerId: string }) => unknown>;
  links: Set<string>;
  left: boolean;
}

export class FakeTrystero {
  private peers = new Map<string, FakePeer>();
  private counter = 0;
  /** pairs that never manage to connect (symmetric NAT, blocked UDP) */
  readonly blocked = new Set<string>();
  connectDelay = 300;
  latency = 10;
  configs: Array<Record<string, unknown>> = [];

  constructor(private clock: Clock = realClock) {}

  private key(a: string, b: string) {
    return [a, b].sort().join('|');
  }

  readonly joinRoom: TrysteroJoin = (config, roomId) => {
    this.configs.push(config);
    const me: FakePeer = {
      id: `t${++this.counter}`,
      roomId,
      password: String(config.password ?? ''),
      joinHandlers: [],
      leaveHandlers: [],
      messageHandlers: [],
      links: new Set(),
      left: false,
    };
    this.peers.set(me.id, me);
    this.clock.setTimeout(() => {
      for (const other of this.peers.values()) {
        if (other === me || other.left || other.roomId !== roomId || other.password !== me.password) continue;
        this.connect(me, other);
      }
    }, this.connectDelay);
    const room: TrysteroRoomLike = {
      makeAction: () => ({
        send: async (data, options) => {
          if (me.left) return;
          const targets = options?.target == null ? [...me.links] : Array.isArray(options.target) ? options.target : [options.target];
          for (const t of targets) {
            if (!me.links.has(t)) continue;
            const other = this.peers.get(t);
            const copy = (data as Uint8Array).slice();
            this.clock.setTimeout(() => {
              if (other && !other.left && other.links.has(me.id)) for (const h of other.messageHandlers) h(copy, { peerId: me.id });
            }, this.latency);
          }
        },
        onMessage: (handler) => me.messageHandlers.push(handler),
      }),
      onPeerJoin: (handler) => {
        me.joinHandlers.push(handler);
        for (const id of me.links) handler({ peerId: id });
      },
      onPeerLeave: (handler) => me.leaveHandlers.push(handler),
      onError: () => {},
      leave: async () => {
        me.left = true;
        for (const id of [...me.links]) this.disconnect(me.id, id);
      },
    };
    return room;
  };

  private connect(a: FakePeer, b: FakePeer): void {
    if (this.blocked.has(this.key(a.id, b.id)) || a.links.has(b.id)) return;
    a.links.add(b.id);
    b.links.add(a.id);
    for (const h of a.joinHandlers) h({ peerId: b.id });
    for (const h of b.joinHandlers) h({ peerId: a.id });
  }

  /** Close the data channel between two transport peers. */
  disconnect(a: string, b: string): void {
    const pa = this.peers.get(a);
    const pb = this.peers.get(b);
    if (!pa || !pb || !pa.links.has(b)) return;
    pa.links.delete(b);
    pb.links.delete(a);
    for (const h of pa.leaveHandlers) h({ peerId: b });
    for (const h of pb.leaveHandlers) h({ peerId: a });
  }

  /** Re-establish channels between every pair in the same room. */
  reconnectAll(): void {
    const list = [...this.peers.values()].filter((p) => !p.left);
    for (const a of list) for (const b of list) if (a !== b && a.roomId === b.roomId && a.password === b.password) this.connect(a, b);
  }

  /** Break every channel (e.g. the network dropped UDP). */
  disconnectAll(): void {
    for (const a of this.peers.values()) for (const b of [...a.links]) this.disconnect(a.id, b);
  }

  block(a: string, b: string): void {
    this.blocked.add(this.key(a, b));
  }

  get ids(): string[] {
    return [...this.peers.keys()];
  }
}
