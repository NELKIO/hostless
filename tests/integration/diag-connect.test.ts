import { describe, expect, it } from 'vitest';
import { checkMqttBroker, checkNetwork, checkNostrRelay, classifyNat } from '../../src/diag/check.js';
import { FakeNostrNetwork } from '../../src/testing/fake-nostr-relay.js';
import { FakeMqttNetwork } from '../../src/testing/fake-mqtt-broker.js';
import { createTurnMatch, createReplica, HostlessError } from '../../src/connect.js';
import { MemoryStorage } from '../../src/storage/kv.js';
import { MemoryLocks } from '../../src/storage/locks.js';
import { MemoryNetwork } from '../../src/testing/memory-network.js';
import { realClock } from '../../src/util/timers.js';
import { roomSecrets } from '../../src/room/secrets.js';
import { ticTacToe, firstFree } from '../engines.js';
import type { WsFactory } from '../../src/nostr/socket.js';

describe('network check', () => {
  it('echoes through healthy relays and reports broken ones', async () => {
    const nostr = new FakeNostrNetwork();
    nostr.add('wss://ok.test', { latency: 1 });
    nostr.add('wss://refuse.test', { latency: 1, refuse: 'blocked: no' });
    const ok = await checkNostrRelay('wss://ok.test', nostr.ws, 3000);
    expect(ok).toMatchObject({ ok: true, error: null });
    expect(ok.echoMs).not.toBeNull();
    expect((await checkNostrRelay('wss://refuse.test', nostr.ws, 3000)).error).toMatch(/refused: blocked/);
    expect((await checkNostrRelay('wss://missing.test', nostr.ws, 3000)).error).toMatch(/connection failed/);
  });

  it('checks MQTT brokers with an echo', async () => {
    const mq = new FakeMqttNetwork();
    mq.add('wss://b.test/mqtt', { latency: 1 });
    mq.add('wss://no.test/mqtt', { latency: 1, refuseCode: 5 });
    expect(await checkMqttBroker('wss://b.test/mqtt', mq.ws, 3000)).toMatchObject({ ok: true });
    expect((await checkMqttBroker('wss://no.test/mqtt', mq.ws, 3000)).ok).toBe(false);
  });

  it('summarises a whole check', async () => {
    const nostr = new FakeNostrNetwork();
    nostr.add('wss://ok.test', { latency: 1 });
    const mq = new FakeMqttNetwork();
    mq.add('wss://b.test/mqtt', { latency: 1 });
    const ws: WsFactory = (url, p) => (url.includes('mqtt') ? mq.ws(url, p) : nostr.ws(url, p));
    const r = await checkNetwork({ nostr: ['wss://ok.test'], mqtt: ['wss://b.test/mqtt'], ws, rtc: null, timeoutMs: 3000 });
    expect([...r.nostr, ...r.mqtt].map((e) => [e.url, e.ok, e.error])).toEqual([
      ['wss://ok.test', true, null],
      ['wss://b.test/mqtt', true, null],
    ]);
    expect(r.summary).toEqual({ relays: 2, direct: 'unlikely', ok: true });
    expect(r.webrtc.available).toBe(false);
  });

  it('classifies NAT types from ICE candidates', () => {
    const host = 'candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host generation 0';
    const s1 = 'candidate:2 1 udp 1686052607 203.0.113.7 50000 typ srflx raddr 192.168.1.2 rport 50000';
    const s2same = 'candidate:3 1 udp 1686052607 203.0.113.7 50000 typ srflx raddr 192.168.1.2 rport 50000';
    const s2diff = 'candidate:3 1 udp 1686052607 203.0.113.7 61000 typ srflx raddr 192.168.1.2 rport 50000';
    expect(classifyNat([])).toBe('blocked');
    expect(classifyNat([host])).toBe('unknown');
    expect(classifyNat([host, s1, s2same])).toBe('cone');
    expect(classifyNat([host, s1, s2diff])).toBe('symmetric');
    expect(classifyNat(['candidate:1 1 udp 2122260223 203.0.113.7 50000 typ host', s1])).toBe('open');
  });
});

describe('one-call sessions', () => {
  it('createTurnMatch opens seat, room and match; a second tab is refused', async () => {
    const net = new MemoryNetwork(realClock).medium('relay', { latency: 5 });
    await roomSecrets('ttt', 'ABCDEFGHJK');
    const storage = new MemoryStorage();
    const locks = new MemoryLocks();
    const common = { app: { id: 'ttt', protocol: 1 }, code: 'ABCDEFGHJK', engine: ticTacToe(), mailbox: false as const, leaveOnPageHide: false };
    const host = await createTurnMatch({ ...common, role: 'host', storage, locks, paths: [net.path('relay')] });
    await expect(createTurnMatch({ ...common, role: 'host', storage, locks, paths: [net.path('relay')] })).rejects.toBeInstanceOf(HostlessError);
    const guest = await createTurnMatch({ ...common, role: 'guest', storage: new MemoryStorage(), locks: new MemoryLocks(), paths: [net.path('relay')] });
    host.ready({ name: 'H' });
    guest.ready({ name: 'G' });
    for (let i = 0; i < 100 && (host.phase !== 'playing' || guest.phase !== 'playing'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(host.phase).toBe('playing');
    const mover = host.myTurn ? host : guest;
    expect(mover.move(firstFree(mover.state!))).toBe(true);
    for (let i = 0; i < 100 && (guest.history.length < 1 || host.history.length < 1); i++) await new Promise((r) => setTimeout(r, 20));
    expect(guest.history).toHaveLength(1);
    expect(host.seat?.persistent).toBe(true);
    await host.close();
    await guest.close();
    // the seat is free again and remembers the match
    const again = await createTurnMatch({ ...common, role: 'host', storage, locks, paths: [net.path('relay')] });
    expect(again.history).toHaveLength(1);
    await again.close();
  });

  it('createReplica works without persistence', async () => {
    const net = new MemoryNetwork(realClock).medium('relay', { latency: 5 });
    const common = { app: { id: 'paint', protocol: 1 }, code: 'ABCDEFGHJK', persist: false, leaveOnPageHide: false, paths: [net.path('relay')] };
    const a = await createReplica<{ c: number }>(common);
    const b = await createReplica<{ c: number }>(common);
    expect(a.seat).toBeNull();
    a.push({ c: 1 });
    for (let i = 0; i < 200 && b.size < 1; i++) await new Promise((r) => setTimeout(r, 20));
    expect(b.size).toBe(1);
    await Promise.all([a.close(), b.close()]);
  });
});
