import { describe, expect, it } from 'vitest';
import { listSeats, openSeat, pruneSeats } from '../../src/storage/seats.js';
import { MemoryStorage } from '../../src/storage/kv.js';
import { MemoryLocks, type LockManagerLike } from '../../src/storage/locks.js';

const base = () => ({ app: 'game', room: 'ROOMCODE01', storage: new MemoryStorage(), locks: new MemoryLocks() });

describe('seats', () => {
  it('keep the identity and journal across a reload', async () => {
    const o = base();
    const s1 = (await openSeat<{ moves: number[] }>(o))!;
    expect(s1.persistent).toBe(true);
    expect(s1.commit({ moves: [1, 2] })).toBe(true);
    const id = s1.peerId;
    await s1.release();
    const s2 = (await openSeat<{ moves: number[] }>(o))!;
    expect(s2.peerId).toBe(id);
    expect(s2.journal).toEqual({ moves: [1, 2] });
  });

  it('a second tab cannot open a held seat', async () => {
    const o = base();
    const s1 = await openSeat(o);
    expect(s1).not.toBeNull();
    // another tab: same storage and lock manager, different page scope is modelled by a fresh
    // storage object view over the same data
    expect(await openSeat(o)).toBeNull();
    await s1!.release();
    expect(await openSeat(o)).not.toBeNull();
  });

  it('different roles and rooms are separate seats', async () => {
    const o = base();
    const host = (await openSeat({ ...o, role: 'host' }))!;
    const guest = (await openSeat({ ...o, role: 'guest' }))!;
    const other = (await openSeat({ ...o, room: 'ROOMCODE02' }))!;
    expect(new Set([host.peerId, guest.peerId, other.peerId]).size).toBe(3);
  });

  it('never persists a key without a lock', async () => {
    const o = { ...base(), locks: null };
    const s = (await openSeat(o))!;
    expect(s.persistent).toBe(false);
    expect(o.storage.length).toBe(0);
    expect(s.commit({ x: 1 })).toBe(true); // nothing durable exists, nothing to protect
  });

  it('treats denied locks like missing ones', async () => {
    const denied: LockManagerLike = {
      request: async () => {
        const e = new Error('denied');
        e.name = 'SecurityError';
        throw e;
      },
    };
    const o = { ...base(), locks: denied };
    const s = (await openSeat(o))!;
    expect(s.persistent).toBe(false);
  });

  it('works without storage at all (private mode), volatile', async () => {
    const s = (await openSeat({ app: 'game', room: 'R', storage: null, locks: new MemoryLocks() }))!;
    expect(s.persistent).toBe(false);
    expect(s.commit({ a: 1 })).toBe(true);
  });

  it('refuses to commit when durable storage starts failing (write-ahead rule)', async () => {
    const o = base();
    const s = (await openSeat(o))!;
    expect(s.commit({ n: 1 })).toBe(true);
    o.storage.failWrites = true;
    expect(s.commit({ n: 2 })).toBe(false);
    expect(s.persistent).toBe(false);
    // the in-memory copy is still current for this page
    expect(s.journal).toEqual({ n: 2 });
  });

  it('a quota error on the very first write leaves a volatile seat', async () => {
    const o = base();
    o.storage.quota = 10;
    const s = (await openSeat(o))!;
    expect(s.persistent).toBe(false);
    expect(s.commit({ n: 1 })).toBe(true);
  });

  it('lists and prunes by policy', async () => {
    let t = 1_000_000_000_000;
    const now = () => t;
    const o = { ...base(), now };
    const settled = (await openSeat({ ...o, room: 'SETTLED' }))!;
    settled.save({ done: true }, { settled: true });
    await settled.release();
    const active = (await openSeat({ ...o, room: 'ACTIVE' }))!;
    active.save({ moves: [1] });
    await active.release();
    const empty = (await openSeat({ ...o, room: 'EMPTY' }))!;
    await empty.release();
    const busy = (await openSeat({ ...o, room: 'BUSY' }))!; // still open in "another tab"
    expect(listSeats('game', o.storage).map((s) => s.room).sort()).toEqual(['ACTIVE', 'BUSY', 'EMPTY', 'SETTLED']);
    t += 2 * 3600_000;
    expect((await pruneSeats('game', {}, { storage: o.storage, locks: o.locks, now })).sort()).toEqual(['EMPTY']);
    t += 24 * 3600_000;
    expect(await pruneSeats('game', {}, { storage: o.storage, locks: o.locks, now })).toEqual(['SETTLED']);
    t += 7 * 24 * 3600_000;
    expect(await pruneSeats('game', {}, { storage: o.storage, locks: o.locks, now })).toEqual(['ACTIVE']);
    expect(listSeats('game', o.storage).map((s) => s.room)).toEqual(['BUSY']);
    busy.release();
  });

  it('ignores corrupted records', async () => {
    const o = base();
    o.storage.setItem('hostless:game:seat:ROOMCODE01:player', '{"v":1,"secret":"nope"');
    const s = (await openSeat(o))!;
    expect(s.journal).toBeNull();
    expect(s.persistent).toBe(true);
  });
});
