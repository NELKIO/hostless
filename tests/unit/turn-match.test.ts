import { describe, expect, it } from 'vitest';
import { crash, world, type World } from '../helpers.js';
import { firstFree, raceTo, ticTacToe, type TttState } from '../engines.js';
import { TurnMatch, TURN_PROTOCOL, type TurnJournal, type TurnEngine } from '../../src/sessions/turn-match.js';
import { openSeat, type Seat } from '../../src/storage/seats.js';
import { MemoryStorage } from '../../src/storage/kv.js';
import { MemoryLocks } from '../../src/storage/locks.js';
import { Mailbox } from '../../src/mailbox.js';
import { FakeNostrNetwork } from '../../src/testing/fake-nostr-relay.js';
import { Identity } from '../../src/identity.js';
import type { Room } from '../../src/room/room.js';

type T = TurnMatch<TttState, number, { name: string }>;

async function seatFor(storage: MemoryStorage, locks: MemoryLocks, role: string): Promise<Seat<TurnJournal>> {
  return (await openSeat<TurnJournal>({ app: 'test-game', room: 'ABCDEFGHJK', role, storage, locks }))!;
}

async function pair(w: World, opts: { engineB?: TurnEngine<TttState, number, { name: string }>; seats?: boolean } = {}) {
  const storeA = new MemoryStorage();
  const storeB = new MemoryStorage();
  const locks = new MemoryLocks();
  const seatA = opts.seats ? await seatFor(storeA, locks, 'host') : null;
  const seatB = opts.seats ? await seatFor(storeB, new MemoryLocks(), 'guest') : null;
  const ra = await w.join({ identity: seatA?.identity });
  const rb = await w.join({ identity: seatB?.identity });
  const a: T = new TurnMatch({ room: ra, engine: ticTacToe(), role: 'host', seat: seatA, clock: w.clock });
  const b: T = new TurnMatch({ room: rb, engine: opts.engineB ?? ticTacToe(), role: 'guest', seat: seatB, clock: w.clock });
  return { ra, rb, a, b, seatA, seatB, storeA, storeB };
}

/** Play until the end: whoever's turn it is takes the first free cell. */
async function playOut(w: World, ms: T[]) {
  for (let i = 0; i < 20; i++) {
    const mover = ms.find((m) => m.myTurn);
    if (!mover) break;
    expect(mover.move(firstFree(mover.state!))).toBe(true);
    await w.run(300);
  }
}

describe('turn match', () => {
  it('plays a full game with the same result on both devices', async () => {
    const w = world();
    const { a, b } = await pair(w);
    const results: unknown[][] = [];
    a.on('result', (r) => results.push(['a', r.winner, r.draw ?? false]));
    b.on('result', (r) => results.push(['b', r.winner, r.draw ?? false]));
    await w.run(2000);
    expect(a.ready({ name: 'Ann' })).toBe(true);
    expect(b.ready({ name: 'Bob' })).toBe(true);
    await w.run(1000);
    expect(a.phase).toBe('playing');
    expect(b.phase).toBe('playing');
    expect(a.matchId).toBe(b.matchId);
    expect(b.mySeat).toBe(1);
    expect(a.state!.names).toEqual(['Ann', 'Bob']);
    await playOut(w, [a, b]);
    await w.run(1000);
    expect(a.phase).toBe('finished');
    expect(b.state).toEqual(a.state);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.slice(1))).toEqual([results[0].slice(1), results[0].slice(1)]);
    expect(a.everyoneHasIt).toBe(true);
  });

  it('rejects illegal and out-of-turn moves', async () => {
    const w = world();
    const { a, b } = await pair(w);
    await w.run(2000);
    a.ready({ name: 'A' });
    b.ready({ name: 'B' });
    await w.run(1000);
    const [mover, other] = a.myTurn ? [a, b] : [b, a];
    expect(other.move(0)).toBe(false);
    expect(mover.move(9)).toBe(false);
    expect(mover.move(4)).toBe(true);
    await w.run(500);
    expect(other.myTurn).toBe(true);
    expect(other.move(4)).toBe(false);
    expect(a.history).toHaveLength(1);
    expect(b.history).toHaveLength(1);
  });

  it('ignores forged moves and moves for another seat', async () => {
    const w = world();
    const { ra, rb, a, b } = await pair(w);
    await w.run(2000);
    a.ready({ name: 'A' });
    b.ready({ name: 'B' });
    await w.run(1000);
    const turn = a.turn!;
    const mallory = Identity.generate();
    const victim = turn === 0 ? a : b;
    const attackerRoom = turn === 0 ? rb : ra;
    const target = turn === 0 ? ra.peerId : rb.peerId;
    // the seat NOT in turn tries to move for the seat in turn, with its own key and a stranger's key
    for (const id of [attackerRoom.identity, mallory]) {
      const header = { id: a.matchId!, seats: a.seats, lineups: [{ name: 'A' }, { name: 'B' }], sig: (a as unknown as { match: { sig: string; hs: string } }).match.sig, hs: (a as unknown as { match: { hs: string } }).match.hs };
      attackerRoom.send(target, { v: TURN_PROTOCOL, t: 'state', ...header, base: 0, moves: [{ s: turn, m: 4, sig: id.signValue({ id: a.matchId, i: 0, s: turn, m: 4 }) }], len: 1 }, { channel: 'tm' });
      await w.run(500);
      expect(victim.history).toHaveLength(0);
    }
  });

  it('stops with "version" when the rules differ', async () => {
    const w = world();
    const { a, b } = await pair(w, { engineB: ticTacToe('misere') });
    const stops: string[] = [];
    a.on('stop', (s) => stops.push(`a:${s.reason}`));
    b.on('stop', (s) => stops.push(`b:${s.reason}`));
    await w.run(2000);
    a.ready({ name: 'A' });
    b.ready({ name: 'B' });
    await w.run(2000);
    expect(stops.sort()).toEqual(['a:version', 'b:version']);
    expect(b.phase).toBe('stopped');
  });

  it('resumes after the guest reloads mid-match', async () => {
    const w = world();
    const storeB = new MemoryStorage();
    const locksB = new MemoryLocks();
    const { a, ra } = await (async () => {
      const ra = await w.join();
      return { ra, a: new TurnMatch({ room: ra, engine: ticTacToe(), role: 'host', clock: w.clock }) as T };
    })();
    let seatB = await seatFor(storeB, locksB, 'guest');
    let rb: Room = await w.join({ identity: seatB.identity });
    let b: T = new TurnMatch({ room: rb, engine: ticTacToe(), role: 'guest', seat: seatB, clock: w.clock });
    await w.run(2000);
    a.ready({ name: 'A' });
    b.ready({ name: 'B' });
    await w.run(1000);
    for (let i = 0; i < 3; i++) {
      const mover = a.myTurn ? a : b;
      mover.move(firstFree(mover.state!));
      await w.run(400);
    }
    const before = b.history.length;
    expect(before).toBe(3);
    // the guest tab crashes and is reopened
    b.destroy();
    crash(rb);
    await seatB.release();
    await w.run(13_000);
    expect(a.seatStatus(1)).toBe('away');
    seatB = await seatFor(storeB, locksB, 'guest');
    rb = await w.join({ identity: seatB.identity });
    b = new TurnMatch({ room: rb, engine: ticTacToe(), role: 'guest', seat: seatB, clock: w.clock });
    expect(b.phase).toBe('playing');
    expect(b.history).toHaveLength(3);
    await w.run(3000);
    expect(a.seatStatus(1)).toBe('online');
    await playOut(w, [a, b]);
    await w.run(1000);
    expect(b.phase).toBe('finished');
    expect(b.state).toEqual(a.state);
    expect(ra.getPeers()).toHaveLength(1);
  });

  it('does not send a move that cannot be stored', async () => {
    const w = world();
    const { a, b, storeA, storeB } = await pair(w, { seats: true });
    const errors: string[] = [];
    a.on('storage-error', () => errors.push('a'));
    b.on('storage-error', () => errors.push('b'));
    await w.run(2000);
    a.ready({ name: 'A' });
    b.ready({ name: 'B' });
    await w.run(1000);
    const [mover, other, store] = a.myTurn ? [a, b, storeA] : [b, a, storeB];
    store.failWrites = true;
    expect(mover.move(0)).toBe(false);
    await w.run(1000);
    expect(other.history).toHaveLength(0);
    expect(errors).toHaveLength(1);
    store.failWrites = false;
  });

  it('closes the lobby when a player leaves before the start', async () => {
    const w = world();
    const { a, b } = await pair(w);
    const stops: string[] = [];
    a.on('stop', (s) => stops.push(s.reason));
    await w.run(2000);
    b.ready({ name: 'B' });
    await w.run(500);
    b.leave();
    await w.run(500);
    expect(stops).toEqual(['left']);
    expect(a.phase).toBe('stopped');
  });

  it('a player who leaves during a match only pauses it; quitting ends it', async () => {
    const w = world();
    const { a, b } = await pair(w);
    const stops: string[] = [];
    a.on('stop', (s) => stops.push(s.reason));
    await w.run(2000);
    a.ready({ name: 'A' });
    b.ready({ name: 'B' });
    await w.run(1000);
    b.leave();
    await w.run(1000);
    expect(a.phase).toBe('playing');
    const { a: a2, b: b2 } = await pair(w);
    await w.run(2000);
    a2.ready({ name: 'A' });
    b2.ready({ name: 'B' });
    await w.run(1000);
    const quits: string[] = [];
    a2.on('stop', (s) => quits.push(s.reason));
    b2.leave({ quit: true });
    await w.run(1000);
    expect(quits).toEqual(['quit']);
    expect(stops).toEqual([]);
  });

  it('gets the final result from the mailbox when the winner has gone', async () => {
    const w = world();
    const relays = new FakeNostrNetwork(w.clock);
    relays.add('wss://store.test');
    const ra = await w.join();
    const rb = await w.join();
    const mbox = (room: Room) => new Mailbox({ secrets: room.secrets, identity: room.identity, relays: ['wss://store.test'], ws: relays.ws, now: () => w.clock.now() });
    const a: T = new TurnMatch({ room: ra, engine: ticTacToe(), role: 'host', mailbox: mbox(ra), clock: w.clock, reconnectMs: 5000 });
    const b: T = new TurnMatch({ room: rb, engine: ticTacToe(), role: 'guest', mailbox: mbox(rb), clock: w.clock, reconnectMs: 5000 });
    await w.run(2000);
    a.ready({ name: 'A' });
    b.ready({ name: 'B' });
    await w.run(1000);
    // play until one move before the end
    for (let i = 0; i < 20; i++) {
      const mover = a.myTurn ? a : b;
      const probe = ticTacToe().apply(mover.state!, mover.mySeat!, firstFree(mover.state!));
      if (probe && ticTacToe().result(probe)) break;
      mover.move(firstFree(mover.state!));
      await w.run(400);
    }
    const last = a.myTurn ? a : b;
    const waiting = last === a ? b : a;
    const results: unknown[] = [];
    waiting.on('result', (r) => results.push(r.winner));
    // the waiting player's connection drops; the last mover finishes and closes the game
    const [lastRoom, waitingRoom] = last === a ? [ra, rb] : [rb, ra];
    w.net.freeze('direct', waitingRoom.peerId);
    w.net.freeze('relay', waitingRoom.peerId);
    expect(last.move(firstFree(last.state!))).toBe(true);
    await w.run(20_000);
    expect(last.phase).toBe('finished');
    // only the last mover stored a copy; the waiting player, cut off from it, found it there
    expect(relays.get('wss://store.test').stored.map((e) => e.pubkey)).toEqual([lastRoom.peerId]);
    expect(waiting.phase).toBe('finished');
    expect(waiting.state).toEqual(last.state);
    expect(results).toHaveLength(1);
  });

  it('plays with three seats', async () => {
    const w = world();
    const rooms = [await w.join(), await w.join(), await w.join()];
    const ms = rooms.map((room, i) => new TurnMatch({ room, engine: raceTo(10, 3), role: i === 0 ? 'host' : 'guest', seats: 3, clock: w.clock }));
    await w.run(3000);
    ms.forEach((m) => m.ready({ ok: true }));
    await w.run(1000);
    expect(new Set(ms.map((m) => m.matchId)).size).toBe(1);
    expect(ms.map((m) => m.mySeat).sort()).toEqual([0, 1, 2]);
    for (let i = 0; i < 20 && ms[0].phase === 'playing'; i++) {
      const mover = ms.find((m) => m.myTurn)!;
      expect(mover.move(2)).toBe(true);
      await w.run(400);
    }
    await w.run(1000);
    for (const m of ms) expect(m.phase).toBe('finished');
    expect(new Set(ms.map((m) => JSON.stringify(m.state))).size).toBe(1);
  });

  it('emits the result again after a reload until it is settled', async () => {
    const w = world();
    const { a, b, seatB } = await pair(w, { seats: true });
    await w.run(2000);
    a.ready({ name: 'A' });
    b.ready({ name: 'B' });
    await w.run(1000);
    await playOut(w, [a, b]);
    await w.run(1000);
    b.destroy();
    const again = (room: Room) => new TurnMatch({ room, engine: ticTacToe(), role: 'guest', seat: seatB, clock: w.clock });
    const rb = (b as unknown as { room: Room }).room;
    const b2: T = again(rb);
    const seen: boolean[] = [];
    b2.on('result', (r) => seen.push(r.settled));
    await w.run(2000);
    expect(b2.phase).toBe('finished');
    expect(seen).toEqual([false]);
    b2.settle();
    b2.destroy();
    const b3: T = again(rb);
    const seen3: boolean[] = [];
    b3.on('result', (r) => seen3.push(r.settled));
    await w.run(2000);
    expect(b3.settled).toBe(true);
    expect(seen3).toEqual([true]);
  });
});
