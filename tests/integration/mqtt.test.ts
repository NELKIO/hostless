import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { collect, world } from '../helpers.js';
import { FakeMqttNetwork, topicMatches } from '../../src/testing/fake-mqtt-broker.js';
import { mqttPath } from '../../src/paths/mqtt.js';
import { encodeLength, packet, PacketReader } from '../../src/paths/mqtt-client.js';
import { nostrPath } from '../../src/paths/nostr.js';
import { FakeNostrNetwork } from '../../src/testing/fake-nostr-relay.js';

const BROKERS = ['wss://b1.test/mqtt', 'wss://b2.test/mqtt'];

function setup() {
  const w = world({ media: {} });
  const fake = new FakeMqttNetwork(w.clock);
  for (const url of BROKERS) fake.add(url);
  const join = (extra: object = {}) => w.join({ paths: [mqttPath({ brokers: BROKERS, ws: fake.ws, keepaliveS: 6 })], ...extra });
  return { w, fake, join };
}

describe('mqtt codec', () => {
  it('encodes remaining lengths as varints', () => {
    expect([...encodeLength(0)]).toEqual([0]);
    expect([...encodeLength(127)]).toEqual([127]);
    expect([...encodeLength(128)]).toEqual([0x80, 1]);
    expect([...encodeLength(16_383)]).toEqual([0xff, 0x7f]);
    expect([...encodeLength(2_097_151)]).toEqual([0xff, 0xff, 0x7f]);
  });

  it('reassembles packets split or merged arbitrarily', () => {
    fc.assert(
      fc.property(fc.array(fc.uint8Array({ maxLength: 400 }), { maxLength: 8 }), fc.integer({ min: 1, max: 50 }), (bodies, cut) => {
        const stream = bodies.map((b) => packet(3, 0, b));
        const all = new Uint8Array(stream.reduce((n, s) => n + s.length, 0));
        let at = 0;
        for (const s of stream) {
          all.set(s, at);
          at += s.length;
        }
        const reader = new PacketReader();
        const got: Uint8Array[] = [];
        for (let i = 0; i < all.length; i += cut) for (const p of reader.push(all.subarray(i, i + cut))!) got.push(p.body);
        expect(got.map((b) => [...b])).toEqual(bodies.map((b) => [...b]));
      }),
    );
  });

  it('matches topic filters', () => {
    expect(topicMatches('a/b', 'a/b')).toBe(true);
    expect(topicMatches('a/+', 'a/b')).toBe(true);
    expect(topicMatches('a/#', 'a/b/c')).toBe(true);
    expect(topicMatches('a/+', 'a/b/c')).toBe(false);
    expect(topicMatches('a/b', 'a/c')).toBe(false);
  });
});

describe('mqtt path', () => {
  it('links two rooms over brokers only', async () => {
    const { w, join } = setup();
    const a = await join();
    const b = await join();
    const got = collect<number>(b);
    await w.run(3000);
    for (let i = 0; i < 30; i++) a.send(b.peerId, i);
    await w.run(3000);
    expect(got).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(a.getPeer(b.peerId)?.route).toBe('relay');
  });

  it('survives a broker outage and reconnects', async () => {
    const { w, fake, join } = setup();
    const a = await join();
    const b = await join();
    const got = collect<number>(b);
    await w.run(3000);
    fake.get(BROKERS[0]).behaviour.down = true;
    fake.get(BROKERS[0]).dropConnections();
    for (let i = 0; i < 10; i++) a.send(b.peerId, i);
    await w.run(5000);
    expect(got).toHaveLength(10);
    fake.get(BROKERS[1]).behaviour.down = true;
    fake.get(BROKERS[1]).dropConnections();
    fake.get(BROKERS[0]).behaviour.down = false;
    for (let i = 10; i < 20; i++) a.send(b.peerId, i);
    await w.run(40_000);
    expect(got).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('detects a half-dead broker by keepalive and moves on', async () => {
    const { w, fake, join } = setup();
    const a = await join();
    const b = await join();
    const got = collect<number>(b);
    await w.run(3000);
    // b1 freezes every existing connection (no close), b2 is fine
    fake.get(BROKERS[0]).behaviour.freezeAfterBytes = 1;
    for (const c of fake.get(BROKERS[0]).connections) c.frozen = true;
    for (let i = 0; i < 10; i++) a.send(b.peerId, i);
    await w.run(30_000);
    expect(got).toEqual(Array.from({ length: 10 }, (_, i) => i));
  });

  it('refused connections are reported and retried', async () => {
    const { w, fake, join } = setup();
    fake.get(BROKERS[0]).behaviour.refuseCode = 5;
    fake.get(BROKERS[1]).behaviour.down = true;
    const a = await join();
    const errors: string[] = [];
    a.on('path', (p) => p.error && errors.push(p.error));
    await w.run(13_000);
    expect(errors.some((e) => e.startsWith('unreachable'))).toBe(true);
    expect(fake.get(BROKERS[0]).stats.connects).toBeGreaterThan(1);
  });

  it('links peers that share different relay families', async () => {
    const w = world({ media: {} });
    const mq = new FakeMqttNetwork(w.clock);
    const ns = new FakeNostrNetwork(w.clock);
    mq.add(BROKERS[0]);
    ns.add('wss://n1.test');
    const a = await w.join({ paths: [mqttPath({ brokers: [BROKERS[0]], ws: mq.ws }), nostrPath({ relays: ['wss://n1.test'], ws: ns.ws })] });
    const b = await w.join({ paths: [mqttPath({ brokers: [BROKERS[0]], ws: mq.ws })] });
    const c = await w.join({ paths: [nostrPath({ relays: ['wss://n1.test'], ws: ns.ws })] });
    await w.run(5000);
    expect(a.getPeers().map((p) => p.id).sort()).toEqual([b.peerId, c.peerId].sort());
    expect(b.getPeers().map((p) => p.id)).toEqual([a.peerId]);
    expect(a.getPeer(b.peerId)?.paths).toEqual(['mqtt', 'nostr']);
  });
});
