import { describe, expect, it } from 'vitest';
import { collect, world } from '../helpers.js';
import { FakeTrystero } from '../../src/testing/fake-trystero.js';
import { directPath } from '../../src/paths/direct.js';
import { broadcastPath } from '../../src/paths/broadcast.js';
import { joinRoom } from '../../src/room/room.js';
import { roomSecrets } from '../../src/room/secrets.js';

function setup() {
  const w = world({ media: { relay: { latency: 150 } } });
  const tr = new FakeTrystero(w.clock);
  const join = (extra: object = {}) => w.join({ paths: [directPath({ joinRoom: tr.joinRoom }), w.net.path('relay')], ...extra });
  return { w, tr, join };
}

describe('direct path (Trystero)', () => {
  it('passes the derived password and public topic, never the code', async () => {
    const { tr, join } = setup();
    const a = await join();
    const cfg = tr.configs[0];
    expect(cfg.appId).toBe('hostless/test-game');
    expect(String(cfg.password)).toMatch(/^[0-9a-f]{48}$/);
    expect(JSON.stringify(cfg)).not.toContain(a.code);
  });

  it('links over the data channel and prefers it', async () => {
    const { w, join } = setup();
    const a = await join();
    const b = await join();
    const got = collect<number>(b);
    await w.run(3000);
    for (let i = 0; i < 5; i++) a.send(b.peerId, i);
    await w.run(500);
    expect(got).toEqual([0, 1, 2, 3, 4]);
    expect(a.getPeer(b.peerId)?.route).toBe('direct');
    expect(a.getPeer(b.peerId)?.paths.sort()).toEqual(['direct', 'relay']);
  });

  it('a closed data channel moves traffic to the relay at once, and back when it reopens', async () => {
    const { w, tr, join } = setup();
    const a = await join();
    const b = await join();
    const got = collect<number>(b);
    await w.run(3000);
    tr.disconnectAll();
    await w.run(200);
    expect(a.getPeer(b.peerId)?.paths).toEqual(['relay']);
    for (let i = 0; i < 5; i++) a.send(b.peerId, i);
    await w.run(1500);
    expect(got).toEqual([0, 1, 2, 3, 4]);
    expect(a.getPeer(b.peerId)?.route).toBe('relay');
    tr.reconnectAll();
    await w.run(3000);
    expect(a.getPeer(b.peerId)?.route).toBe('direct');
  });

  it('peers that can never connect directly still play over the relay', async () => {
    const { w, tr, join } = setup();
    tr.connectDelay = 100;
    const a = await join();
    const b = await join();
    tr.disconnectAll();
    tr.block(tr.ids[0], tr.ids[1]);
    const got = collect<string>(b);
    await w.run(3000);
    a.send(b.peerId, 'relayed');
    await w.run(1000);
    expect(got).toEqual(['relayed']);
  });

  it('is simply never up without WebRTC', async () => {
    const { w } = setup();
    const room = await w.join({ paths: [directPath(), w.net.path('relay')] });
    expect(room.pathInfo().find((p) => p.name === 'direct')?.up).toBe(false);
    expect(room.pathInfo().find((p) => p.name === 'direct')?.status?.failure).toMatch(/no WebRTC/);
  });
});

describe('broadcast path (same-browser tabs)', () => {
  it('links two rooms through BroadcastChannel', async () => {
    const secrets = await roomSecrets('bc-game', 'ABCDEFGHJK', 1000);
    const opts = { app: { id: 'bc-game', protocol: 1 }, code: 'ABCDEFGHJK', secrets, leaveOnPageHide: false, paths: [broadcastPath()] };
    const a = await joinRoom(opts);
    const b = await joinRoom(opts);
    const got: unknown[] = [];
    b.channel('app').on((m) => got.push(m.data));
    await a.waitForPeer(5000);
    a.send(b.peerId, 'tab to tab');
    for (let i = 0; i < 50 && !got.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual(['tab to tab']);
    expect(a.getPeer(b.peerId)?.route).toBe('direct');
    await Promise.all([a.leave(), b.leave()]);
  });
});
