// Regression tests for the issues found by the independent review (2026-11-24).
import { describe, expect, it } from 'vitest';
import { crash, world } from '../helpers.js';
import { ticTacToe, firstFree, type TttState } from '../engines.js';
import { TurnMatch, TURN_PROTOCOL } from '../../src/sessions/turn-match.js';
import { Replica, REPLICA_PROTOCOL } from '../../src/sessions/replica.js';
import { HostAuthority, type AuthorityEngine, type HostJournal } from '../../src/sessions/host-authority.js';
import { openSeat } from '../../src/storage/seats.js';
import { MemoryStorage } from '../../src/storage/kv.js';
import { MemoryLocks } from '../../src/storage/locks.js';
import { Identity } from '../../src/identity.js';
import { inviteLink, parseHostHint, parseRoomCode } from '../../src/code.js';
import { DeviceSync } from '../../src/sync/device-sync.js';
import { FakeNostrNetwork } from '../../src/testing/fake-nostr-relay.js';
import { realClock, type Clock } from '../../src/util/timers.js';

type T = TurnMatch<TttState, number, { name: string }>;

describe('turn match lobby races', () => {
  it('a lineup changed while the host starts ends in one match with the new lineup, without a message storm', async () => {
    const w = world({ media: { direct: { direct: true, latency: 15 } } });
    const ra = await w.join();
    const rb = await w.join();
    const a: T = new TurnMatch({ room: ra, engine: ticTacToe(), role: 'host', clock: w.clock });
    const b: T = new TurnMatch({ room: rb, engine: ticTacToe(), role: 'guest', clock: w.clock });
    await w.run(2000);
    a.ready({ name: 'A' });
    b.ready({ name: 'B1' });
    await w.clock.advanceAsync(5); // the host starts with B1 when it gets the first ready…
    b.ready({ name: 'B2' }); // …while the guest already changed its mind
    await w.run(5000);
    expect(a.phase).toBe('playing');
    expect(b.phase).toBe('playing');
    expect(a.matchId).toBe(b.matchId);
    expect(a.state!.names).toEqual(['A', 'B2']);
    const before = w.net.stats('direct').sent;
    await w.run(10_000);
    expect(w.net.stats('direct').sent - before).toBeLessThan(200);
  });

  it('never answers a stop from another protocol version, and answers others at most every 10 s', async () => {
    const w = world();
    const ra = await w.join();
    const rb = await w.join();
    new TurnMatch({ room: ra, engine: ticTacToe(), role: 'host', clock: w.clock });
    await w.run(2000);
    const replies: unknown[] = [];
    rb.channel('tm').on((m) => (m.data as { t: string }).t === 'stop' && replies.push(m.data));
    rb.channel('tm').send(ra.peerId, { v: TURN_PROTOCOL + 1, t: 'stop', id: null, reason: 'version' });
    await w.run(500);
    expect(replies).toHaveLength(0);
    await w.run(10_000);
    for (let i = 0; i < 5; i++) rb.channel('tm').send(ra.peerId, { v: TURN_PROTOCOL + 1, t: 'head', id: null, len: 0, last: '' });
    await w.run(500);
    expect(replies).toHaveLength(1);
  });

  it('a guest pinned to its host ignores a match started by someone else with the code', async () => {
    const w = world();
    const rHost = await w.join();
    const rGuest = await w.join();
    const rIntruder = await w.join();
    const link = inviteLink('ABCDEFGHJK', { base: 'https://x.test/', host: rHost.peerId });
    expect(parseRoomCode(link)).toBe('ABCDEFGHJK');
    const pin = parseHostHint(link)!;
    const guest: T = new TurnMatch({ room: rGuest, engine: ticTacToe(), role: 'guest', clock: w.clock, host: pin });
    const intruder: T = new TurnMatch({ room: rIntruder, engine: ticTacToe(), role: 'host', clock: w.clock });
    intruder.ready({ name: 'Mallory' });
    guest.ready({ name: 'Guest' });
    await w.run(2000);
    expect(intruder.phase).toBe('playing'); // the intruder thinks it started…
    expect(guest.phase).toBe('lobby'); // …the guest did not follow
    const host: T = new TurnMatch({ room: rHost, engine: ticTacToe(), role: 'host', clock: w.clock });
    host.ready({ name: 'Host' });
    await w.run(3000);
    expect(guest.phase).toBe('playing');
    expect(guest.seats[0]).toBe(rHost.peerId);
    expect(guest.matchId).toBe(host.matchId);
    // a forged-but-genuinely-signed header by the intruder never stops the pinned guest
    expect(guest.stopReason).toBeNull();
    const mover = host.myTurn ? host : guest;
    expect(mover.move(firstFree(mover.state!))).toBe(true);
  });
});

describe('host authority after a host reload', () => {
  type S = { coins: number };
  const shop: AuthorityEngine<S, 'buy'> = { init: () => ({ coins: 0 }), apply: (s) => ({ coins: s.coins + 1 }) };

  it('a request re-sent to a reloaded host is not applied twice', async () => {
    const w = world();
    const storage = new MemoryStorage();
    const locks = new MemoryLocks();
    let seat = (await openSeat<HostJournal<S>>({ app: 'test-game', room: 'ABCDEFGHJK', role: 'host', storage, locks }))!;
    let rh = await w.join({ identity: seat.identity });
    let host = new HostAuthority<S, 'buy'>({ room: rh, engine: shop, role: 'host', seat, clock: w.clock });
    const rg = await w.join();
    const guest = new HostAuthority<S, 'buy'>({ room: rg, engine: shop, role: 'guest', clock: w.clock });
    await w.run(3000);
    expect(guest.seatNumber).toBe(1);
    // the host's answers never reach the guest, and the host page dies right after applying
    for (const m of ['direct', 'relay']) w.net.block(m, rh.peerId, rg.peerId);
    guest.act('buy');
    await w.run(300);
    expect(host.state).toEqual({ coins: 1 });
    crash(rh);
    host.destroy();
    await seat.release();
    await w.run(3000);
    seat = (await openSeat<HostJournal<S>>({ app: 'test-game', room: 'ABCDEFGHJK', role: 'host', storage, locks }))!;
    for (const m of ['direct', 'relay']) w.net.block(m, rh.peerId, rg.peerId, false);
    rh = await w.join({ identity: seat.identity });
    host = new HostAuthority<S, 'buy'>({ room: rh, engine: shop, role: 'host', seat, clock: w.clock });
    await w.run(15_000);
    expect(host.state).toEqual({ coins: 1 });
    expect(guest.state).toEqual({ coins: 1 });
  });
});

describe('replica clock bounds', () => {
  it('an op with an absurd Lamport clock is ignored and honest ops keep flowing', async () => {
    const w = world();
    const ra = await w.join();
    const rb = await w.join();
    const rc = await w.join();
    const a = new Replica<number>({ room: ra, clock: w.clock });
    const b = new Replica<number>({ room: rb, clock: w.clock });
    await w.run(3000);
    const body = { doc: 'main', a: rc.peerId, n: 1, l: Number.MAX_SAFE_INTEGER, at: 0, op: 1 };
    const evil = { ...body, sig: rc.identity.signValue(body) };
    rc.broadcast({ v: REPLICA_PROTOCOL, t: 'ops', doc: 'main', ops: [evil] }, { channel: 'rp' });
    await w.run(500);
    a.push(42);
    await w.run(2000);
    expect(b.ops().map((o) => o.op)).toEqual([42]);
    expect(a.ops()[0].l).toBe(1);
  });

  it('far-ahead sequence numbers from strangers are not buffered', async () => {
    const w = world();
    const ra = await w.join();
    const rx = await w.join();
    const a = new Replica<number>({ room: ra, clock: w.clock });
    await w.run(2000);
    const id = Identity.generate();
    const ops = Array.from({ length: 50 }, (_, i) => {
      const body = { doc: 'main', a: rx.peerId, n: 5000 + i, l: 1, at: 0, op: i };
      return { ...body, sig: rx.identity.signValue(body) };
    });
    void id;
    rx.send(ra.peerId, { v: REPLICA_PROTOCOL, t: 'ops', doc: 'main', ops }, { channel: 'rp' });
    await w.run(500);
    expect(a.hasGaps).toBe(false);
  });
});

describe('seats recover from a failed write', () => {
  it('commit works again once storage accepts writes', async () => {
    const storage = new MemoryStorage();
    const seat = (await openSeat({ app: 'game', room: 'R1', storage, locks: new MemoryLocks() }))!;
    storage.failWrites = true;
    expect(seat.commit({ n: 1 })).toBe(false);
    expect(seat.persistent).toBe(false);
    storage.failWrites = false;
    expect(seat.commit({ n: 2 })).toBe(true);
    expect(seat.persistent).toBe(true);
    expect(JSON.parse(storage.getItem('hostless:game:seat:R1:player')!).journal).toEqual({ n: 2 });
  });
});

describe('device sync with a clock far behind', () => {
  it('still replaces the document on the relays', async () => {
    const net = new FakeNostrNetwork(realClock);
    const urls = ['wss://a.test', 'wss://b.test'];
    for (const u of urls) net.add(u, { latency: 1 });
    const key = DeviceSync.newKey();
    const mk = (clock: Clock, start: number) => {
      let doc = { n: start };
      const sync = new DeviceSync<{ n: number }>({
        app: 'g',
        store: { read: () => doc, write: (d) => void (doc = d) },
        merge: (l, rs) => ({ n: Math.max(l.n, ...rs.map((r) => r.n)) }),
        keyStorage: new MemoryStorage(),
        relays: urls,
        ws: net.ws,
        clock,
        timeoutMs: 400,
        document: null,
      });
      return { sync, get: () => doc, set: (n: number) => void (doc = { n }) };
    };
    const normal = mk(realClock, 1);
    await normal.sync.link(key);
    const behind = mk({ ...realClock, now: () => Date.now() - 24 * 3600_000 }, 5);
    expect((await behind.sync.link(key)).status?.state).toBe('ok');
    await normal.sync.syncNow();
    expect(normal.get().n).toBe(5);
  });
});
