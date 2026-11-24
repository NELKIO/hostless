import { describe, expect, it } from 'vitest';
import { collect, world } from '../helpers.js';
import { FakeNostrNetwork } from '../../src/testing/fake-nostr-relay.js';
import { nostrPath, NostrPath } from '../../src/paths/nostr.js';
import { publishEvent, queryRelays } from '../../src/nostr/pool.js';
import { signEvent, verifyEvent } from '../../src/nostr/event.js';
import { generateSecret } from '../../src/crypto/schnorr.js';
import type { Room } from '../../src/room/room.js';

const URLS = ['wss://r1.test', 'wss://r2.test', 'wss://r3.test'];

function setup(behaviours: Record<string, object> = {}) {
  const w = world({ media: {} });
  const fake = new FakeNostrNetwork(w.clock);
  for (const url of URLS) fake.add(url, (behaviours as Record<string, object>)[url] ?? {});
  const join = (relays = URLS, extra: object = {}) => w.join({ paths: [nostrPath({ relays, ws: fake.ws })], ...extra });
  const nostrOf = (room: Room) => (room as unknown as { paths: NostrPath[] }).paths[0];
  return { w, fake, join, nostrOf };
}

describe('nostr event utils and pool', () => {
  it('signs and verifies NIP-01 events', () => {
    const e = signEvent(generateSecret(), { kind: 1, created_at: 1, tags: [], content: 'x' });
    expect(verifyEvent(e)).toBe(true);
    expect(verifyEvent({ ...e, content: 'y' })).toBe(false);
    expect(verifyEvent({ ...e, sig: '0'.repeat(128) })).toBe(false);
  });

  it('publishes and queries stored events across relays', async () => {
    const fake = new FakeNostrNetwork();
    for (const url of URLS) fake.add(url, { latency: 1 });
    fake.get(URLS[2]).behaviour.down = true;
    const secret = generateSecret();
    const now = Math.floor(Date.now() / 1000);
    const first = signEvent(secret, { kind: 30078, created_at: now - 10, tags: [['d', 'doc']], content: 'v1' });
    const second = signEvent(secret, { kind: 30078, created_at: now, tags: [['d', 'doc']], content: 'v2' });
    expect((await publishEvent(first, { relays: URLS, ws: fake.ws, timeoutMs: 500 })).accepted).toBe(2);
    expect((await publishEvent(second, { relays: URLS, ws: fake.ws, timeoutMs: 500 })).accepted).toBe(2);
    const res = await queryRelays({ kinds: [30078], authors: [first.pubkey], '#d': ['doc'] }, { relays: URLS, ws: fake.ws, timeoutMs: 500 });
    expect(res.reachable).toBe(2);
    expect(res.events.map((e) => e.content)).toEqual(['v2']);
  });

  it('honours NIP-40 expiration', async () => {
    const fake = new FakeNostrNetwork();
    fake.add(URLS[0], { latency: 1 });
    const now = Math.floor(Date.now() / 1000);
    const expired = signEvent(generateSecret(), { kind: 30078, created_at: now, tags: [['d', 'x'], ['expiration', String(now - 1)]], content: '' });
    const res = await publishEvent(expired, { relays: [URLS[0]], ws: fake.ws, timeoutMs: 500 });
    expect(res.accepted).toBe(0);
    expect(res.replies[0].message).toMatch(/expired/);
  });
});

describe('nostr path', () => {
  it('links two rooms over relays only', async () => {
    const { w, join } = setup();
    const a = await join();
    const b = await join();
    const got = collect(b);
    await w.run(4000);
    expect(a.getPeers()).toHaveLength(1);
    a.send(b.peerId, { over: 'nostr' });
    await w.run(1500);
    expect(got).toEqual([{ over: 'nostr' }]);
    expect(a.getPeer(b.peerId)?.route).toBe('relay');
  });

  it('carries a long exchange through relays that freeze connections (DPI)', async () => {
    const { w, fake, join, nostrOf } = setup({
      [URLS[0]]: { freezeAfterBytes: 12_000 },
      [URLS[1]]: { freezeAfterBytes: 16_000 },
      [URLS[2]]: { down: true },
    });
    const a = await join();
    const b = await join();
    const got = collect<number>(b);
    const back = collect<number>(a);
    await w.run(5000);
    expect(a.getPeers()).toHaveLength(1);
    for (let i = 0; i < 150; i++) {
      a.send(b.peerId, i);
      if (i % 2) b.send(a.peerId, i);
      await w.run(150);
    }
    await w.run(30_000);
    expect(got).toEqual(Array.from({ length: 150 }, (_, i) => i));
    expect(back).toEqual(Array.from({ length: 75 }, (_, i) => i * 2 + 1));
    expect(fake.get(URLS[0]).stats.freezes + fake.get(URLS[1]).stats.freezes).toBeGreaterThan(3);
    const status = nostrOf(a).status() as { relays: { freezes: number }[] };
    expect(status.relays.some((r) => r.freezes > 0)).toBe(true);
  });

  it('drops relays that refuse us and keeps going on the others', async () => {
    const { w, join, nostrOf } = setup({ [URLS[0]]: { refuse: 'blocked: not on the allow list' } });
    const a = await join();
    const b = await join();
    const got = collect<number>(b);
    await w.run(5000);
    for (let i = 0; i < 20; i++) a.send(b.peerId, i);
    await w.run(10_000);
    expect(got).toHaveLength(20);
    const relays = (nostrOf(a).status() as { relays: { url: string; dead: string | null }[] }).relays;
    expect(relays.find((r) => r.url === URLS[0])?.dead).toMatch(/blocked/);
  });

  it('drops relays that keep rate-limiting', async () => {
    const { w, join, nostrOf } = setup({ [URLS[1]]: { rateLimitEvery: 2 } });
    const a = await join();
    const b = await join();
    await w.run(5000);
    for (let i = 0; i < 30; i++) {
      a.send(b.peerId, i);
      await w.run(100);
    }
    await w.run(5000);
    const relays = (nostrOf(a).status() as { relays: { url: string; dead: string | null }[] }).relays;
    expect(relays.find((r) => r.url === URLS[1])?.dead).toMatch(/rate-limited/);
  });

  it('drops relays that close the subscription', async () => {
    const { w, join, nostrOf } = setup({ [URLS[2]]: { closeSubscriptions: 'auth-required: sign in' } });
    const a = await join();
    await w.run(3000);
    const relays = (nostrOf(a).status() as { relays: { url: string; dead: string | null }[] }).relays;
    expect(relays.find((r) => r.url === URLS[2])?.dead).toMatch(/subscription closed/);
  });

  it('reconnects after a relay restart', async () => {
    const { w, fake, join } = setup();
    const a = await join([URLS[0]]);
    const b = await join([URLS[0]]);
    const got = collect<string>(b);
    await w.run(4000);
    fake.get(URLS[0]).dropConnections();
    a.send(b.peerId, 'after restart');
    await w.run(20_000);
    expect(got).toEqual(['after restart']);
  });

  it('reaches peers that share only some relays', async () => {
    const { w, join } = setup();
    const a = await join([URLS[0], URLS[1]]);
    const b = await join([URLS[1], URLS[2]]);
    const got = collect<number>(b);
    await w.run(6000);
    for (let i = 0; i < 10; i++) a.send(b.peerId, i);
    await w.run(5000);
    expect(got).toEqual(Array.from({ length: 10 }, (_, i) => i));
  });

  it('reports when no relay is reachable', async () => {
    const { w, fake, join } = setup();
    for (const url of URLS) fake.get(url).behaviour.down = true;
    const a = await join();
    const errors: string[] = [];
    a.on('path', (p) => p.error && errors.push(p.error));
    await w.run(13_000);
    expect(errors.some((e) => e.startsWith('unreachable'))).toBe(true);
    expect(a.status).toBe('connecting');
  });
});
