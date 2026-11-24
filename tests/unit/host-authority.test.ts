import { describe, expect, it } from 'vitest';
import { crash, world } from '../helpers.js';
import { HostAuthority, type AuthorityEngine, type HostJournal } from '../../src/sessions/host-authority.js';
import { openSeat } from '../../src/storage/seats.js';
import { MemoryStorage } from '../../src/storage/kv.js';
import { MemoryLocks } from '../../src/storage/locks.js';
import type { Room } from '../../src/room/room.js';

interface Arena {
  players: Record<number, { name: string; hp: number }>;
  log: string[];
}
type Action = { hit: number } | { heal: true };

const arena: AuthorityEngine<Arena, Action> = {
  init: () => ({ players: {}, log: [] }),
  join: (s, seat, meta) => ({ ...s, players: { ...s.players, [seat]: { name: String(meta.name ?? seat), hp: 10 } }, log: [...s.log, `join ${seat}`] }),
  leave: (s, seat) => {
    const players = { ...s.players };
    delete players[seat];
    return { ...s, players, log: [...s.log, `leave ${seat}`] };
  },
  validateAction: (a) => !!a && typeof a === 'object',
  apply: (s, seat, a) => {
    if ('hit' in a) {
      const target = s.players[a.hit];
      if (!target) return 'no such player';
      if (a.hit === seat) return null;
      return { ...s, players: { ...s.players, [a.hit]: { ...target, hp: target.hp - 1 } }, log: [...s.log, `${seat} hits ${a.hit}`] };
    }
    return { ...s, players: { ...s.players, [seat]: { ...s.players[seat], hp: s.players[seat].hp + 1 } }, log: [...s.log, `${seat} heals`] };
  },
};

type HA = HostAuthority<Arena, Action>;

async function setup(guests: number, maxSeats = 16) {
  const w = world();
  const rh = await w.join();
  const host: HA = new HostAuthority({ room: rh, engine: arena, role: 'host', meta: { name: 'Host' }, clock: w.clock, maxSeats });
  const gs: HA[] = [];
  const rooms: Room[] = [];
  for (let i = 0; i < guests; i++) {
    const r = await w.join();
    rooms.push(r);
    gs.push(new HostAuthority({ room: r, engine: arena, role: 'guest', meta: { name: `G${i}` }, clock: w.clock }));
  }
  return { w, rh, host, gs, rooms };
}

describe('host authority', () => {
  it('seats guests and keeps every copy equal', async () => {
    const { w, host, gs } = await setup(2);
    await w.run(4000);
    expect(gs.map((g) => g.seatNumber).sort()).toEqual([1, 2]);
    expect(gs[0].act({ hit: 0 })).toBeTruthy();
    host.act({ hit: gs[1].seatNumber! });
    gs[1].act({ heal: true });
    await w.run(2000);
    for (const g of gs) expect(g.state).toEqual(host.state);
    expect(host.state!.players[0].hp).toBe(9);
    expect(host.state!.log.at(-1)).toMatch(/heals|hits/);
  });

  it('rejects invalid actions with a reason', async () => {
    const { w, gs } = await setup(1);
    await w.run(3000);
    const reasons: string[] = [];
    gs[0].on('rejected', (r) => reasons.push(r.reason));
    gs[0].act({ hit: 7 });
    gs[0].act({ hit: gs[0].seatNumber! });
    await w.run(1000);
    expect(reasons).toEqual(['no such player', 'rejected']);
  });

  it('repairs a diverged guest with a snapshot', async () => {
    const { w, host, gs } = await setup(1);
    await w.run(3000);
    const desyncs: number[] = [];
    gs[0].on('desync', (d) => desyncs.push(d.seq));
    // corrupt the guest's shadow copy
    (gs[0] as unknown as { _state: Arena })._state = { players: {}, log: ['garbage'] };
    host.act({ heal: true });
    await w.run(2000);
    expect(desyncs).toHaveLength(1);
    expect(gs[0].state).toEqual(host.state);
  });

  it('a late joiner gets the current state', async () => {
    const { w, host, gs } = await setup(1);
    await w.run(3000);
    for (let i = 0; i < 5; i++) host.act({ hit: 1 });
    await w.run(1000);
    const r = await w.join();
    const late: HA = new HostAuthority({ room: r, engine: arena, role: 'guest', meta: { name: 'Late' }, clock: w.clock });
    await w.run(4000);
    expect(late.seatNumber).toBe(2);
    expect(late.state).toEqual(host.state);
    expect(gs[0].state).toEqual(host.state);
  });

  it('a guest that reloads with its seat identity keeps its seat', async () => {
    const { w, host } = await setup(0);
    const storage = new MemoryStorage();
    const locks = new MemoryLocks();
    let seat = (await openSeat<HostJournal<Arena>>({ app: 'test-game', room: 'ABCDEFGHJK', role: 'guest', storage, locks }))!;
    let room = await w.join({ identity: seat.identity });
    let g: HA = new HostAuthority({ room, engine: arena, role: 'guest', seat, clock: w.clock });
    await w.run(3000);
    const mine = g.seatNumber;
    expect(mine).toBe(1);
    crash(room);
    g.destroy();
    await seat.release();
    seat = (await openSeat<HostJournal<Arena>>({ app: 'test-game', room: 'ABCDEFGHJK', role: 'guest', storage, locks }))!;
    room = await w.join({ identity: seat.identity });
    g = new HostAuthority({ room, engine: arena, role: 'guest', seat, clock: w.clock });
    await w.run(4000);
    expect(g.seatNumber).toBe(mine);
    expect(Object.keys(host.state!.players)).toEqual(['0', '1']);
  });

  it('turns guests away when full', async () => {
    const { w, gs } = await setup(2, 2);
    const full: number[] = [];
    gs.forEach((g, i) => g.on('full', () => full.push(i)));
    await w.run(4000);
    expect(gs.filter((g) => g.seatNumber !== null)).toHaveLength(1);
    expect(full).toHaveLength(1);
  });

  it('the host resumes from its journal and guests follow', async () => {
    const w = world();
    const storage = new MemoryStorage();
    const locks = new MemoryLocks();
    let seat = (await openSeat<HostJournal<Arena>>({ app: 'test-game', room: 'ABCDEFGHJK', role: 'host', storage, locks }))!;
    let rh = await w.join({ identity: seat.identity });
    let host: HA = new HostAuthority({ room: rh, engine: arena, role: 'host', seat, clock: w.clock });
    const g: HA = new HostAuthority({ room: await w.join(), engine: arena, role: 'guest', clock: w.clock });
    await w.run(3000);
    g.act({ hit: 0 });
    await w.run(1000);
    const before = host.state;
    crash(rh);
    host.destroy();
    await seat.release();
    await w.run(3000);
    seat = (await openSeat<HostJournal<Arena>>({ app: 'test-game', room: 'ABCDEFGHJK', role: 'host', storage, locks }))!;
    rh = await w.join({ identity: seat.identity });
    host = new HostAuthority({ room: rh, engine: arena, role: 'host', seat, clock: w.clock });
    expect(host.state).toEqual(before);
    await w.run(4000);
    expect(g.act({ heal: true })).toBeTruthy();
    await w.run(2000);
    expect(g.state).toEqual(host.state);
    expect(host.state!.players[1].hp).toBe(11);
  });
});
