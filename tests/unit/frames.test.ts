import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { roomSecrets, subTopic } from '../../src/room/secrets.js';
import { dataHeader, decodeHello, encodeData, encodeHello, openData, PairKeys } from '../../src/room/frames.js';
import { decodeSegment, encodeSegment, SegType, type Segment } from '../../src/room/segments.js';
import { Identity } from '../../src/identity.js';
import { utf8 } from '../../src/util/bytes.js';

const ITER = 1000;
const now = 1_700_000_000_000;
const helloBody = (at = now) => ({ sid: '0123456789abcdef', at, to: null, app: { id: 'game', protocol: 1 }, meta: { name: 'Ann' }, hints: {} });

describe('room secrets', () => {
  it('derive stable public topics that differ per app and code', async () => {
    const a = await roomSecrets('game', 'ABCDEFGHJK', ITER);
    const b = await roomSecrets('game', 'ABCDEFGHJK', ITER);
    const c = await roomSecrets('other', 'ABCDEFGHJK', ITER);
    const d = await roomSecrets('game', 'ABCDEFGHJL', ITER);
    expect(a.topic).toMatch(/^[0-9a-f]{32}$/);
    expect(b.topic).toBe(a.topic);
    expect(new Set([a.topic, c.topic, d.topic]).size).toBe(3);
    expect(a.topic).not.toContain('ABCDEFGHJK');
    expect(subTopic(a.topic, 'x')).not.toBe(subTopic(a.topic, 'y'));
  });
});

describe('hello frames', () => {
  it('round-trip and verify', async () => {
    const s = await roomSecrets('game', 'ABCDEFGHJK', ITER);
    const id = Identity.generate();
    const frame = encodeHello(id, s, helloBody());
    const res = decodeHello(s, frame, now + 1000);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.hello.from).toBe(id.peerId);
      expect(res.hello.meta).toEqual({ name: 'Ann' });
    }
  });

  it('reject wrong room, stale time and forged signatures', async () => {
    const s = await roomSecrets('game', 'ABCDEFGHJK', ITER);
    const other = await roomSecrets('game', 'ABCDEFGHJL', ITER);
    const id = Identity.generate();
    const frame = encodeHello(id, s, helloBody());
    expect(decodeHello(other, frame, now)).toEqual({ ok: false, reason: 'key' });
    expect(decodeHello(s, frame, now + 121_000)).toEqual({ ok: false, reason: 'stale' });
    expect(decodeHello(s, frame, now - 121_000)).toEqual({ ok: false, reason: 'stale' });

    // Re-encrypt a hello whose body was altered after signing (someone with the code forging meta).
    const { aesOpen, aesSeal } = await import('../../src/crypto/aes.js');
    const plain = JSON.parse(new TextDecoder().decode(aesOpen(s.roomKey, frame.subarray(1), new Uint8Array([1]))!));
    plain.meta.name = 'Mallory';
    const forged = new Uint8Array([1, ...aesSeal(s.roomKey, utf8(JSON.stringify(plain)), new Uint8Array([1]))]);
    expect(decodeHello(s, forged, now)).toEqual({ ok: false, reason: 'signature' });
    // someone claiming another identity
    plain.meta.name = 'Ann';
    plain.from = Identity.generate().peerId;
    const impostor = new Uint8Array([1, ...aesSeal(s.roomKey, utf8(JSON.stringify(plain)), new Uint8Array([1]))]);
    expect(decodeHello(s, impostor, now)).toEqual({ ok: false, reason: 'signature' });
  });

  it('refuses oversized meta', async () => {
    const s = await roomSecrets('game', 'ABCDEFGHJK', ITER);
    expect(() => encodeHello(Identity.generate(), s, { ...helloBody(), meta: { blob: 'x'.repeat(2000) } })).toThrow(/too large/);
  });
});

describe('data frames', () => {
  it('only the pair can open them', async () => {
    const s = await roomSecrets('game', 'ABCDEFGHJK', ITER);
    const a = Identity.generate();
    const b = Identity.generate();
    const c = Identity.generate();
    const ka = new PairKeys(a, s);
    const kb = new PairKeys(b, s);
    const kc = new PairKeys(c, s);
    const frame = encodeData(ka, a.peerId, b.peerId, utf8('secret'));
    expect(dataHeader(frame)).toEqual({ from: a.peerId, to: b.peerId });
    expect(new TextDecoder().decode(openData(kb, a.peerId, frame)!)).toBe('secret');
    expect(openData(kc, a.peerId, frame)).toBeNull();
    // c cannot pretend to be a by rewriting the header
    const fake = encodeData(kc, c.peerId, b.peerId, utf8('evil'));
    fake.set(frame.subarray(1, 33), 1);
    expect(openData(kb, a.peerId, fake)).toBeNull();
  });

  it('pair keys differ per room', async () => {
    const s1 = await roomSecrets('game', 'ABCDEFGHJK', ITER);
    const s2 = await roomSecrets('game', 'ABCDEFGHJL', ITER);
    const a = Identity.generate();
    const b = Identity.generate();
    const frame = encodeData(new PairKeys(a, s1), a.peerId, b.peerId, utf8('x'));
    expect(openData(new PairKeys(b, s2), a.peerId, frame)).toBeNull();
  });
});

describe('segments', () => {
  const sid = fc.uint8Array({ minLength: 8, maxLength: 8 }).map((b) => Buffer.from(b).toString('hex'));
  const u32 = fc.integer({ min: 0, max: 2 ** 32 - 1 });
  const seg: fc.Arbitrary<Segment> = fc.oneof(
    fc.record({ t: fc.constant(SegType.Data as const), fs: sid, ts: sid, seq: u32, ack: u32, flags: fc.integer({ min: 0, max: 7 }), payload: fc.uint8Array({ maxLength: 300 }) }),
    fc.record({ t: fc.constant(SegType.Ack as const), fs: sid, ts: sid, ack: u32, missing: fc.array(u32, { maxLength: 32 }) }),
    fc.record({ t: fc.constantFrom(SegType.Ping as const, SegType.Pong as const), fs: sid, ts: sid, t0: fc.integer({ min: 0, max: 2 ** 50 }), path: fc.integer({ min: 0, max: 5 }) }),
    fc.record({ t: fc.constant(SegType.Unreliable as const), fs: sid, ts: sid, n: u32, payload: fc.uint8Array({ maxLength: 300 }) }),
    fc.record({ t: fc.constant(SegType.Bye as const), fs: sid, ts: sid }),
  );
  it('round-trip', () => {
    fc.assert(
      fc.property(seg, (s) => {
        const back = decodeSegment(encodeSegment(s));
        expect(back).toEqual(s);
      }),
    );
  });
  it('reject garbage', () => {
    expect(decodeSegment(new Uint8Array([0x99, ...new Uint8Array(20)]))).toBeNull();
    expect(decodeSegment(new Uint8Array(3))).toBeNull();
    expect(decodeSegment(new Uint8Array([0x11, ...new Uint8Array(16), 0, 0, 0, 0, 40]))).toBeNull();
  });
});
