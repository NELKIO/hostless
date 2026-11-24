import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { aesOpen, aesSeal, deflate, ecdhX, generateSecret, hkdf, inflate, pbkdf2, peerIdOf, schnorrSign, schnorrVerify, sha256Hex } from '../../src/crypto/index.js';
import { fromB64, fromHex, toB64, toHex, utf8 } from '../../src/util/bytes.js';
import { stableJson } from '../../src/util/stable-json.js';
import { Identity, verifyValue } from '../../src/identity.js';

describe('hashes', () => {
  it('sha256 matches the FIPS vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hkdf matches RFC 5869 case 1', () => {
    const okm = hkdf(new Uint8Array(22).fill(0x0b), fromHex('000102030405060708090a0b0c'), fromHex('f0f1f2f3f4f5f6f7f8f9'), 42);
    expect(toHex(okm)).toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
  });

  it('pbkdf2-sha256 matches published vectors', async () => {
    expect(toHex(await pbkdf2('password', 'salt', 1))).toBe('120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b');
    expect(toHex(await pbkdf2('password', 'salt', 2))).toBe('ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43');
  });
});

describe('aes-gcm', () => {
  const key = new Uint8Array(32).fill(7);

  it('round-trips and authenticates', () => {
    const blob = aesSeal(key, utf8('hello'), utf8('aad'));
    expect(new TextDecoder().decode(aesOpen(key, blob, utf8('aad'))!)).toBe('hello');
    expect(aesOpen(key, blob, utf8('other'))).toBeNull();
    expect(aesOpen(new Uint8Array(32).fill(8), blob, utf8('aad'))).toBeNull();
    const tampered = blob.slice();
    tampered[tampered.length - 1] ^= 1;
    expect(aesOpen(key, tampered, utf8('aad'))).toBeNull();
    expect(aesOpen(key, blob.subarray(0, 10))).toBeNull();
  });

  it('uses a fresh IV every time', () => {
    expect(toHex(aesSeal(key, utf8('x')))).not.toBe(toHex(aesSeal(key, utf8('x'))));
  });
});

describe('schnorr', () => {
  it('matches BIP-340 test vector 0', () => {
    const secret = fromHex('0000000000000000000000000000000000000000000000000000000000000003');
    expect(peerIdOf(secret).toUpperCase()).toBe('F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9');
    const sig = schnorrSign(new Uint8Array(32), secret, (n) => new Uint8Array(n));
    expect(toHex(sig).toUpperCase()).toBe(
      'E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA821525F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0',
    );
    expect(schnorrVerify(sig, new Uint8Array(32), fromHex(peerIdOf(secret)))).toBe(true);
    expect(schnorrVerify(sig, new Uint8Array(32).fill(1), fromHex(peerIdOf(secret)))).toBe(false);
  });

  it('ecdh agrees from both ends for any parity', () => {
    for (let i = 0; i < 20; i++) {
      const a = generateSecret();
      const b = generateSecret();
      expect(toHex(ecdhX(a, peerIdOf(b)))).toBe(toHex(ecdhX(b, peerIdOf(a))));
    }
  });
});

describe('identity', () => {
  it('signs values and verifies them', () => {
    const id = Identity.generate();
    const sig = id.signValue({ b: 1, a: [1, 2] });
    expect(verifyValue(id.peerId, { a: [1, 2], b: 1 }, sig)).toBe(true);
    expect(verifyValue(id.peerId, { a: [1, 2], b: 2 }, sig)).toBe(false);
    expect(verifyValue(Identity.generate().peerId, { a: [1, 2], b: 1 }, sig)).toBe(false);
    expect(verifyValue('zz', {}, sig)).toBe(false);
  });

  it('exports and imports the secret', () => {
    const id = Identity.generate();
    const again = Identity.fromSecret(id.exportSecret());
    expect(again.peerId).toBe(id.peerId);
    expect(() => Identity.fromSecret('00'.repeat(32))).toThrow();
    expect(Identity.isSecret(id.exportSecret())).toBe(true);
    expect(Identity.isSecret('ff'.repeat(32))).toBe(false);
  });

  it('pair secrets agree', () => {
    const a = Identity.generate();
    const b = Identity.generate();
    expect(toHex(a.sharedSecret(b.peerId))).toBe(toHex(b.sharedSecret(a.peerId)));
  });
});

describe('compression', () => {
  it('round-trips arbitrary data', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 5000 }), (data) => {
        const back = inflate(deflate(data), 10_000);
        expect(back && toHex(back)).toBe(toHex(data));
      }),
      { numRuns: 60 },
    );
  });

  it('refuses output above the cap (bomb) and garbage', () => {
    const bomb = deflate(new Uint8Array(5_000_000));
    expect(bomb.length).toBeLessThan(10_000);
    expect(inflate(bomb, 1_000_000)).toBeNull();
    expect(inflate(new Uint8Array([1, 2, 3, 4, 5]), 1000)).toBeNull();
    expect(inflate(deflate(utf8('hello world')).subarray(0, 3), 1000)).toBeNull();
  });
});

describe('bytes and json', () => {
  it('base64 round-trips and rejects junk', () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 3000 }), (data) => { expect(toHex(fromB64(toB64(data))!)).toBe(toHex(data)); }));
    expect(fromB64('###')).toBeNull();
    expect(fromB64('abc')).toBeNull();
  });

  it('stableJson orders keys and is stable', () => {
    expect(stableJson({ b: 1, a: { d: undefined, c: [3, undefined] } })).toBe('{"a":{"c":[3,null]},"b":1}');
    expect(() => stableJson({ x: NaN })).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => stableJson(cyclic)).toThrow();
    fc.assert(fc.property(fc.jsonValue(), (value) => { expect(stableJson(JSON.parse(stableJson(value)))).toBe(stableJson(value)); }));
  });
});
