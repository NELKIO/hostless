import { describe, expect, it } from 'vitest';
import { collect, crash, world, CODE } from '../helpers.js';
import { Identity } from '../../src/identity.js';
import type { Room } from '../../src/room/room.js';
import { roomSecrets } from '../../src/room/secrets.js';
import { decodeHello } from '../../src/room/frames.js';

describe('room', () => {
  it('two peers find each other and talk over the direct path', async () => {
    const w = world();
    const a = await w.join({ meta: { name: 'Ann' } });
    const b = await w.join({ meta: { name: 'Bob' } });
    const joined: string[] = [];
    a.on('peer-join', (p) => joined.push(`a:${p.meta.name}`));
    b.on('peer-join', (p) => joined.push(`b:${p.meta.name}`));
    const gotA = collect(a);
    const gotB = collect(b);
    await w.run(3000);
    expect(joined.sort()).toEqual(['a:Bob', 'b:Ann']);
    expect(a.send(b.peerId, { hi: 1 })).toBe(true);
    b.send(a.peerId, 'yo');
    await w.run(500);
    expect(gotB).toEqual([{ hi: 1 }]);
    expect(gotA).toEqual(['yo']);
    expect(a.getPeer(b.peerId)?.route).toBe('direct');
    expect(a.getPeer(b.peerId)?.paths.sort()).toEqual(['direct', 'relay']);
  });

  it('a room of five is a full mesh', async () => {
    const w = world();
    const rooms: Room[] = [];
    for (let i = 0; i < 5; i++) rooms.push(await w.join({ meta: { i } }));
    const inbox = rooms.map((r) => collect<number>(r));
    await w.run(5000);
    for (const r of rooms) expect(r.getPeers()).toHaveLength(4);
    rooms.forEach((r, i) => r.broadcast(i));
    await w.run(1000);
    inbox.forEach((got, i) => expect(got.sort()).toEqual([0, 1, 2, 3, 4].filter((x) => x !== i)));
  });

  it('works over the relay alone, and moves there when the direct path dies', async () => {
    const w = world();
    const a = await w.join();
    const b = await w.join();
    const got = collect<number>(b);
    await w.run(3000);
    for (let i = 0; i < 10; i++) a.send(b.peerId, i);
    await w.run(200);
    w.net.freeze('direct', b.peerId);
    for (let i = 10; i < 20; i++) a.send(b.peerId, i);
    await w.run(3000);
    expect(got).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(a.getPeer(b.peerId)?.route).toBe('relay');
    w.net.freeze('direct', b.peerId, false);
    await w.run(6000);
    expect(a.getPeer(b.peerId)?.route).toBe('direct');
  });

  it('relay-only peers link up', async () => {
    const w = world();
    const a = await w.join({ media: ['relay'] });
    const b = await w.join({ media: ['relay'] });
    const got = collect(b);
    await w.run(3000);
    a.send(b.peerId, 'over relay');
    await w.run(1000);
    expect(got).toEqual(['over relay']);
    expect(a.getPeer(b.peerId)?.route).toBe('relay');
  });

  it('marks silent peers away, then back, then gone', async () => {
    const w = world();
    const a = await w.join({ awayMs: 12_000, leaveMs: 40_000 });
    const b = await w.join();
    const events: string[] = [];
    a.on('peer-away', () => events.push('away'));
    a.on('peer-back', () => events.push('back'));
    a.on('peer-leave', (_p, reason) => events.push(`leave:${reason}`));
    await w.run(3000);
    w.net.freeze('direct', b.peerId);
    w.net.freeze('relay', b.peerId);
    await w.run(14_000);
    expect(events).toEqual(['away']);
    w.net.freeze('direct', b.peerId, false);
    w.net.freeze('relay', b.peerId, false);
    await w.run(5000);
    expect(events).toEqual(['away', 'back']);
    w.net.freeze('direct', b.peerId);
    w.net.freeze('relay', b.peerId);
    await w.run(45_000);
    expect(events).toEqual(['away', 'back', 'away', 'leave:timeout']);
    expect(a.getPeers()).toHaveLength(0);
  });

  it('says goodbye on leave', async () => {
    const w = world();
    const a = await w.join();
    const b = await w.join();
    await w.run(3000);
    const reasons: string[] = [];
    a.on('peer-leave', (_p, r) => reasons.push(r));
    await Promise.all([b.leave(), w.run(500)]);
    expect(reasons).toEqual(['bye']);
  });

  it('never links incompatible protocol versions', async () => {
    const w = world();
    const a = await w.join();
    const b = await w.join({ app: { id: 'test-game', protocol: 2, version: '2.0' } });
    const seen: unknown[] = [];
    a.on('incompatible', (i) => seen.push(i.theirs.protocol));
    b.on('incompatible', (i) => seen.push(i.theirs.protocol));
    await w.run(5000);
    expect(a.getPeers()).toHaveLength(0);
    expect(b.getPeers()).toHaveLength(0);
    expect(seen.sort()).toEqual([1, 2]);
  });

  it('detects a reload of the peer and keeps talking to the new page', async () => {
    const w = world();
    const id = Identity.generate();
    const a = await w.join();
    const b1 = await w.join({ identity: id });
    await w.run(3000);
    const restarts: string[] = [];
    a.on('peer-restart', (p) => restarts.push(p.id));
    // b1 crashes: no goodbye
    crash(b1);
    await w.run(2000);
    const b2 = await w.join({ identity: id });
    const got = collect(b2);
    await w.run(3000);
    expect(restarts).toEqual([id.peerId]);
    a.send(id.peerId, 'after reload');
    await w.run(1000);
    expect(got).toEqual(['after reload']);
  });

  it('ignores an old hello replayed by an eavesdropper', async () => {
    const w = world();
    const id = Identity.generate();
    const tap = w.net.attach('relay', Identity.generate().peerId);
    const captured: Uint8Array[] = [];
    tap.events.on('frame', (f) => {
      if (f[0] === 1) captured.push(f);
    });
    const a = await w.join();
    const b1 = await w.join({ identity: id });
    await w.run(3000);
    const secrets = await roomSecrets('test-game', CODE, 1000);
    const oldHello = captured.find((f) => {
      const r = decodeHello(secrets, f, w.clock.now());
      return r.ok && r.hello.from === id.peerId;
    })!;
    expect(oldHello).toBeTruthy();
    // b reloads; then the attacker replays the hello of the first page
    crash(b1);
    const b2 = await w.join({ identity: id });
    const got = collect(b2);
    await w.run(3000);
    const restarts: number[] = [];
    a.on('peer-restart', () => restarts.push(1));
    tap.send(null, oldHello);
    await w.run(500);
    expect(restarts).toEqual([]);
    a.send(id.peerId, 'still linked');
    await w.run(1000);
    expect(got).toEqual(['still linked']);
  });

  it('refuses peers beyond capacity', async () => {
    const w = world();
    const a = await w.join({ maxPeers: 2 });
    const b = await w.join({ maxPeers: 2 });
    await w.run(3000);
    const c = await w.join({ maxPeers: 2 });
    const full: string[] = [];
    c.on('full', (i) => full.push(i.peer));
    await w.run(3000);
    expect(a.getPeers().map((p) => p.id)).toEqual([b.peerId]);
    expect(full.length).toBeGreaterThan(0);
    expect(c.getPeers()).toHaveLength(0);
  });

  it('keeps channels apart and survives heavy relay loss', async () => {
    const w = world({ media: { relay: { latency: 150, jitter: 300, loss: 0.3, duplicate: 0.2 } } });
    const a = await w.join();
    const b = await w.join();
    const game = collect<number>(b, 'game');
    const chat = collect<string>(b, 'chat');
    await w.run(10_000);
    for (let i = 0; i < 30; i++) {
      a.channel('game').send(b.peerId, i);
      if (i % 3 === 0) a.channel('chat').send(b.peerId, `m${i}`);
    }
    await w.run(30_000);
    expect(game).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(chat).toEqual(['m0', 'm3', 'm6', 'm9', 'm12', 'm15', 'm18', 'm21', 'm24', 'm27']);
  });

  it('rejects joining with the wrong code', async () => {
    const w = world();
    const a = await w.join();
    const b = await w.join({ code: 'ZZZZZZZZZZ' });
    await w.run(5000);
    expect(a.getPeers()).toHaveLength(0);
    expect(b.getPeers()).toHaveLength(0);
    expect(CODE).not.toBe('ZZZZZZZZZZ');
  });
});
