import { joinRoom, type JoinOptions, type Room } from '../src/room/room.js';
import { roomSecrets } from '../src/room/secrets.js';
import { MemoryNetwork, seededBytes } from '../src/testing/memory-network.js';
import { ManualClock } from '../src/util/timers.js';
import type { Identity } from '../src/identity.js';

export const CODE = 'ABCDEFGHJK';
export const APP = { id: 'test-game', protocol: 1 };

export interface World {
  clock: ManualClock;
  net: MemoryNetwork;
  join(opts?: Partial<JoinOptions> & { media?: string[]; identity?: Identity }): Promise<Room>;
  run(ms: number): Promise<void>;
}

let seedCounter = 1;

export function world({ seed = 1, media = { direct: { direct: true, latency: 15 }, relay: { latency: 120, jitter: 40 } } as Record<string, object> } = {}): World {
  const clock = new ManualClock();
  const net = new MemoryNetwork(clock, seed);
  for (const [name, opts] of Object.entries(media)) net.medium(name, opts);
  const names = Object.keys(media);
  return {
    clock,
    net,
    async join(opts = {}) {
      const secrets = await roomSecrets(opts.app?.id ?? APP.id, opts.code ?? CODE, 1000);
      const room = await joinRoom({
        app: APP,
        code: CODE,
        clock,
        random: seededBytes(seed * 1000 + seedCounter++),
        secrets,
        leaveOnPageHide: false,
        paths: (opts.media ?? names).map((m) => net.path(m)),
        ...opts,
      });
      await clock.advanceAsync(0);
      return room;
    },
    run: (ms: number) => clock.advanceAsync(ms, 50),
  };
}

export function collect<T>(room: Room, channel = 'app'): T[] {
  const out: T[] = [];
  room.channel<T>(channel).on((m) => out.push(m.data));
  return out;
}

/** Simulate a crashed tab: the page vanishes without a goodbye. */
export function crash(room: Room): void {
  const r = room as unknown as { closed: boolean; timer: unknown; clock: { clearInterval(id: unknown): void }; paths: { close(): void }[] };
  r.closed = true;
  r.clock.clearInterval(r.timer);
  for (const p of r.paths) p.close();
}
