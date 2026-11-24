import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { crash, world } from '../helpers.js';
import { Replica, REPLICA_PROTOCOL, type Op, type ReplicaJournal } from '../../src/sessions/replica.js';
import { openSeat } from '../../src/storage/seats.js';
import { MemoryStorage } from '../../src/storage/kv.js';
import { MemoryLocks } from '../../src/storage/locks.js';
import { Identity } from '../../src/identity.js';

type Paint = { cell: number; color: string };

const paint = (state: Record<number, string>, op: Op<Paint>) => ({ ...state, [op.op.cell]: op.op.color });
const EMPTY: Record<number, string> = {};

describe('replica', () => {
  it('converges when everyone acts at once', async () => {
    const w = world();
    const rooms = [await w.join(), await w.join(), await w.join()];
    const reps = rooms.map((room) => new Replica<Paint>({ room, clock: w.clock }));
    await w.run(3000);
    for (let i = 0; i < 30; i++) reps[i % 3].push({ cell: i % 7, color: ['r', 'g', 'b'][i % 3] });
    await w.run(5000);
    const views = reps.map((r) => JSON.stringify(r.fold(paint, EMPTY)));
    expect(new Set(views).size).toBe(1);
    expect(reps.map((r) => r.size)).toEqual([30, 30, 30]);
    expect(new Set(reps.map((r) => JSON.stringify(r.ordered().map((o) => o.sig)))).size).toBe(1);
  });

  it('converges under loss, duplication and reordering (fuzzed schedules)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1e6 }), fc.array(fc.tuple(fc.integer({ min: 0, max: 2 }), fc.integer({ min: 0, max: 9 }), fc.integer({ min: 0, max: 400 })), { minLength: 1, maxLength: 40 }), async (seed, schedule) => {
        const w = world({ seed, media: { relay: { latency: 100, jitter: 400, loss: 0.25, duplicate: 0.2 } } });
        const rooms = [await w.join(), await w.join(), await w.join()];
        const reps = rooms.map((room) => new Replica<Paint>({ room, clock: w.clock, syncMs: 2000 }));
        await w.run(4000);
        for (const [who, cell, wait] of schedule) {
          reps[who].push({ cell, color: `c${who}` });
          await w.run(wait);
        }
        await w.run(30_000);
        const views = reps.map((r) => JSON.stringify(r.fold(paint, EMPTY)));
        expect(new Set(views).size).toBe(1);
        expect(reps.map((r) => r.size)).toEqual([schedule.length, schedule.length, schedule.length]);
      }),
      { numRuns: Number(process.env.FUZZ_RUNS ?? 12) },
    );
  });

  it('rejects ops in someone else\'s name', async () => {
    const w = world();
    const a = await w.join();
    const b = await w.join();
    const ra = new Replica<Paint>({ room: a, clock: w.clock });
    new Replica<Paint>({ room: b, clock: w.clock });
    await w.run(2000);
    const mallory = Identity.generate();
    const forged = (signer: Identity): Op<Paint> => {
      const body = { doc: 'main', a: b.peerId, n: 1, l: 1, at: 0, op: { cell: 1, color: 'x' } };
      return { a: b.peerId, n: 1, l: 1, at: 0, op: body.op, sig: signer.signValue(body) };
    };
    b.send(a.peerId, { v: REPLICA_PROTOCOL, t: 'ops', doc: 'main', ops: [forged(mallory)] }, { channel: 'rp' });
    await w.run(500);
    expect(ra.size).toBe(0);
    // a genuine op from b is fine
    b.send(a.peerId, { v: REPLICA_PROTOCOL, t: 'ops', doc: 'main', ops: [forged(b.identity)] }, { channel: 'rp' });
    await w.run(500);
    expect(ra.size).toBe(1);
  });

  it('a late joiner receives the whole log', async () => {
    const w = world();
    const a = new Replica<Paint>({ room: await w.join(), clock: w.clock });
    for (let i = 0; i < 400; i++) a.push({ cell: i, color: 'r' });
    const late = new Replica<Paint>({ room: await w.join(), clock: w.clock });
    await w.run(10_000);
    expect(late.size).toBe(400);
  });

  it('keeps its sequence across a reload (no reused numbers)', async () => {
    const w = world();
    const storage = new MemoryStorage();
    const locks = new MemoryLocks();
    const other = new Replica<Paint>({ room: await w.join(), clock: w.clock });
    let seat = (await openSeat<ReplicaJournal<Paint>>({ app: 'test-game', room: 'ABCDEFGHJK', storage, locks }))!;
    let room = await w.join({ identity: seat.identity });
    let me = new Replica<Paint>({ room, seat, clock: w.clock });
    await w.run(2000);
    me.push({ cell: 1, color: 'a' });
    me.push({ cell: 2, color: 'b' });
    // the tab dies right after the ops were committed, before they were flushed
    crash(room);
    me.destroy();
    await seat.release();
    seat = (await openSeat<ReplicaJournal<Paint>>({ app: 'test-game', room: 'ABCDEFGHJK', storage, locks }))!;
    room = await w.join({ identity: seat.identity });
    me = new Replica<Paint>({ room, seat, clock: w.clock });
    expect(me.size).toBe(2);
    const third = me.push({ cell: 3, color: 'c' })!;
    expect(third.n).toBe(3);
    await w.run(6000);
    expect(other.size).toBe(3);
    expect(JSON.stringify(other.fold(paint, EMPTY))).toBe(JSON.stringify(me.fold(paint, EMPTY)));
  });

  it('refuses an op it cannot store', async () => {
    const w = world();
    const storage = new MemoryStorage();
    const seat = (await openSeat<ReplicaJournal<Paint>>({ app: 'test-game', room: 'ABCDEFGHJK', storage, locks: new MemoryLocks() }))!;
    const me = new Replica<Paint>({ room: await w.join({ identity: seat.identity }), seat, clock: w.clock });
    storage.failWrites = true;
    expect(me.push({ cell: 1, color: 'a' })).toBeNull();
    expect(me.size).toBe(0);
  });

  it('fold equals a fresh reduction even when ops arrive out of order', async () => {
    const w = world({ media: { relay: { latency: 50, jitter: 2000 } } });
    const rooms = [await w.join(), await w.join()];
    const reps = rooms.map((room) => new Replica<Paint>({ room, clock: w.clock }));
    await w.run(3000);
    let calls = 0;
    const counting = (s: Record<number, string>, op: Op<Paint>) => (calls++, paint(s, op));
    for (let i = 0; i < 40; i++) {
      reps[i % 2].push({ cell: i % 5, color: `x${i}` });
      reps[0].fold(counting, EMPTY);
      await w.run(30);
    }
    await w.run(10_000);
    const cached = JSON.stringify(reps[0].fold(counting, EMPTY));
    const fresh = JSON.stringify(reps[0].ordered().reduce(paint, EMPTY));
    expect(cached).toBe(fresh);
  });

  it('validates ops with the app hook', async () => {
    const w = world();
    const validate = (op: unknown) => typeof (op as Paint)?.cell === 'number' && (op as Paint).cell < 100;
    const a = new Replica<Paint>({ room: await w.join(), clock: w.clock, validate });
    const b = new Replica<Paint>({ room: await w.join(), clock: w.clock });
    const invalid: number[] = [];
    a.on('invalid', (i) => invalid.push(i.n));
    await w.run(2000);
    b.push({ cell: 1000, color: 'r' });
    b.push({ cell: 5, color: 'r' });
    await w.run(6000);
    // the invalid first op blocks the author's later ops (causal order), as it should
    expect(a.size).toBe(0);
    expect(a.hasGaps).toBe(false);
    expect(invalid).toEqual([1]);
  });
});
