import { describe, expect, it } from 'vitest';
import { DeviceSync, accountOf, sealDoc, SYNC_KIND } from '../../src/sync/device-sync.js';
import { ledger, union, type Ledger } from '../../src/sync/crdt.js';
import { FakeNostrNetwork } from '../../src/testing/fake-nostr-relay.js';
import { MemoryStorage } from '../../src/storage/kv.js';
import { publishEvent, queryRelays } from '../../src/nostr/pool.js';
import { signEvent } from '../../src/nostr/event.js';
import { createPublicStats, top } from '../../src/stats.js';
import { generateSecret } from '../../src/crypto/schnorr.js';
import type { WsFactory } from '../../src/nostr/socket.js';
import { realClock, type Clock } from '../../src/util/timers.js';

const URLS = ['wss://s1.test', 'wss://s2.test', 'wss://s3.test'];

interface Progress {
  ledger: Ledger;
  items: string[];
}

function device(name: string, net: FakeNostrNetwork, opts: { ws?: WsFactory; clock?: Clock; version?: number } = {}) {
  let doc: Progress = { ledger: {}, items: [] };
  const listeners = new Set<() => void>();
  let totals = { xp: 0 };
  const sync = new DeviceSync<Progress>({
    app: 'game',
    store: {
      read: () => doc,
      write: (next) => {
        doc = next;
        totals = { xp: Number(ledger.total(doc.ledger).xp ?? 0) };
      },
      subscribe: (f) => (listeners.add(f), () => listeners.delete(f)),
    },
    merge: (local, remotes) => remotes.reduce((acc, r) => ({ ledger: ledger.merge(acc.ledger, r.ledger), items: union(acc.items, r.items) }), local),
    keyStorage: new MemoryStorage(),
    relays: URLS,
    ws: opts.ws ?? net.ws,
    clock: opts.clock,
    version: opts.version,
    debounceMs: 20,
    timeoutMs: 400,
    document: null,
  });
  return {
    sync,
    get doc() {
      return doc;
    },
    get xp() {
      return totals.xp;
    },
    /** the app earns xp locally */
    earn(xp: number, item?: string) {
      totals = { xp: totals.xp + xp };
      doc = { ledger: ledger.record(doc.ledger, name, totals), items: item ? union(doc.items, [item]) : doc.items };
      for (const f of listeners) f();
    },
  };
}

function fakeNet() {
  const net = new FakeNostrNetwork(realClock);
  for (const url of URLS) net.add(url, { latency: 1 });
  return net;
}

const offline: WsFactory = () => {
  throw new Error('offline');
};

describe('device sync', () => {
  it('two devices linked with one key converge', async () => {
    const net = fakeNet();
    const phone = device('phone', net);
    const laptop = device('laptop', net);
    const key = DeviceSync.newKey();
    phone.earn(10, 'fries');
    expect((await phone.sync.link(key)).ok).toBe(true);
    expect(phone.sync.status.state).toBe('ok');
    laptop.earn(5, 'cola');
    await laptop.sync.link(`https://game.example/#sync=${key}`);
    await phone.sync.syncNow();
    expect(laptop.xp).toBe(15);
    expect(phone.xp).toBe(15);
    expect(phone.doc.items).toEqual(['cola', 'fries']);
    // nothing changes when syncing again
    const before = JSON.stringify(phone.doc);
    await phone.sync.syncNow();
    await laptop.sync.syncNow();
    expect(JSON.stringify(phone.doc)).toBe(before);
  });

  it('progress made offline is added, not lost or doubled', async () => {
    const net = fakeNet();
    const key = DeviceSync.newKey();
    const a = device('a', net);
    let online = true;
    const b = device('b', net, { ws: (url, p) => (online ? net.ws(url, p) : offline(url, p)) });
    a.earn(100);
    await a.sync.link(key);
    await b.sync.link(key);
    expect(b.xp).toBe(100);
    online = false;
    b.earn(7);
    expect((await b.sync.syncNow()).state).toBe('offline');
    a.earn(3);
    await a.sync.syncNow();
    online = true;
    await b.sync.syncNow();
    await a.sync.syncNow();
    expect(a.xp).toBe(110);
    expect(b.xp).toBe(110);
  });

  it('an authentic document it cannot read blocks publishing', async () => {
    const net = fakeNet();
    const key = DeviceSync.newKey();
    const acc = accountOf('game', key);
    const garbage = signEvent(acc.secret, { kind: SYNC_KIND, created_at: Math.floor(Date.now() / 1000), tags: [['d', acc.d]], content: 'z1:AAAA' });
    await publishEvent(garbage, { relays: URLS, ws: net.ws, timeoutMs: 400 });
    const d = device('d', net);
    d.earn(1);
    const res = await d.sync.link(key);
    expect(res.status?.state).toBe('unreadable');
    const stored = await queryRelays({ kinds: [SYNC_KIND], authors: [acc.pubkey] }, { relays: URLS, ws: net.ws, timeoutMs: 400 });
    expect(stored.events.every((e) => e.content === 'z1:AAAA')).toBe(true);
  });

  it('never overwrites a document from a newer version', async () => {
    const net = fakeNet();
    const key = DeviceSync.newKey();
    const newer = device('n', net, { version: 2 });
    newer.earn(50);
    await newer.sync.link(key);
    const older = device('o', net, { version: 1 });
    older.earn(1);
    expect((await older.sync.link(key)).status?.state).toBe('outdated');
    expect(older.xp).toBe(1);
  });

  it('copes with a device clock far ahead (relays refuse the future)', async () => {
    const net = fakeNet();
    const key = DeviceSync.newKey();
    const normal = device('normal', net);
    normal.earn(1);
    await normal.sync.link(key);
    const ahead: Clock = { ...realClock, now: () => Date.now() + 24 * 3600_000 };
    const fast = device('fast', net, { clock: ahead });
    fast.earn(2);
    const res = await fast.sync.link(key);
    expect(res.status?.state).toBe('ok');
    await normal.sync.syncNow();
    expect(normal.xp).toBe(3);
    normal.earn(4);
    expect((await normal.sync.syncNow()).state).toBe('ok');
    await fast.sync.syncNow();
    expect(fast.xp).toBe(7);
  });

  it('runs one sync at a time and coalesces requests', async () => {
    const net = fakeNet();
    const d = device('d', net);
    await d.sync.link(DeviceSync.newKey());
    const before = net.get(URLS[0]).stats.connections;
    await Promise.all(Array.from({ length: 6 }, () => d.sync.syncNow()));
    const runs = net.get(URLS[0]).stats.connections - before;
    // each run is one query (+ at most one publish) per relay: 6 calls → 2 runs
    expect(runs).toBeLessThanOrEqual(4);
  });

  it('rejects bad keys, schedules on local changes, unlinks', async () => {
    const net = fakeNet();
    const d = device('d', net);
    expect(await d.sync.link('not a key')).toEqual({ ok: false, reason: 'bad-key' });
    await d.sync.link(DeviceSync.newKey());
    const states: string[] = [];
    d.sync.events.on('status', (s) => states.push(s.state));
    d.earn(5);
    await new Promise((r) => setTimeout(r, 200));
    expect(states).toContain('ok');
    d.sync.unlink();
    expect(d.sync.key).toBeNull();
    expect(d.sync.status.state).toBe('off');
    d.sync.stop();
  });

  it('documents are encrypted on the relays', async () => {
    const acc = accountOf('game', DeviceSync.newKey());
    const e = sealDoc(acc, { v: 1, doc: { secret: 'treasure-map' } }, 1);
    expect(e.content).not.toContain('treasure');
  });
});

describe('public stats', () => {
  it('adds up the newest report of every browser', async () => {
    const net = fakeNet();
    const mk = (report: () => Record<string, number | Record<string, number>>) => createPublicStats({ app: 'game', report, relays: URLS, ws: net.ws, storage: new MemoryStorage(), timeoutMs: 400 });
    let wins = 1;
    const a = mk(() => ({ games: 3, wins, byFighter: { fries: 2, cola: 1 } }));
    const b = mk(() => ({ games: 5, wins: 2, byFighter: { fries: 4 } }));
    const c = mk(() => ({ games: 0 }));
    expect(await a.publish()).toBeGreaterThan(0);
    await b.publish();
    expect(await c.publish()).toBe(0); // nothing to report
    wins = 3;
    await new Promise((r) => setTimeout(r, 1100)); // replaceable events need a newer second
    await a.publish();
    const t = await a.totals();
    expect(t.players).toBe(2);
    expect(t.sums).toEqual({ games: 8, wins: 5 });
    expect(top(t.maps.byFighter, 1)).toEqual([{ key: 'fries', value: 6 }]);
  });

  it('ignores forged and malformed reports', async () => {
    const net = fakeNet();
    const s = createPublicStats({ app: 'game', report: () => ({ games: 1 }), relays: URLS, ws: net.ws, storage: new MemoryStorage(), timeoutMs: 400 });
    await s.publish();
    const bad = signEvent(generateSecret(), { kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', s.d], ['t', s.tag]], content: '{"games":-5}' });
    await publishEvent(bad, { relays: URLS, ws: net.ws, timeoutMs: 400 });
    const huge = signEvent(generateSecret(), { kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', s.d], ['t', s.tag]], content: '{"games":1e15}' });
    await publishEvent(huge, { relays: URLS, ws: net.ws, timeoutMs: 400 });
    const t = await s.totals();
    expect(t).toMatchObject({ players: 1, sums: { games: 1 } });
  });
});
