import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf.js';
import { pbkdf2Async as noblePbkdf2 } from '@noble/hashes/pbkdf2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { toHex, utf8 } from '../util/bytes.js';

type Input = Uint8Array | string;
const bytesOf = (input: Input) => (typeof input === 'string' ? utf8(input) : input);

export function sha256(input: Input): Uint8Array {
  return nobleSha256(bytesOf(input));
}

export function sha256Hex(input: Input): string {
  return toHex(sha256(input));
}

export function hmacSha256(key: Input, message: Input): Uint8Array {
  return hmac(nobleSha256, bytesOf(key), bytesOf(message));
}

/** HKDF-SHA256 (RFC 5869). */
export function hkdf(ikm: Input, salt: Input, info: Input, length = 32): Uint8Array {
  return nobleHkdf(nobleSha256, bytesOf(ikm), bytesOf(salt), bytesOf(info), length);
}

/**
 * PBKDF2-SHA256. Uses WebCrypto when present (fast, off the main thread in most engines) and falls
 * back to the pure-JS implementation, which yields to the event loop while it runs.
 */
export async function pbkdf2(password: Input, salt: Input, iterations: number, length = 32): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const base = await subtle.importKey('raw', bytesOf(password) as BufferSource, 'PBKDF2', false, ['deriveBits']);
      const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: bytesOf(salt) as BufferSource, iterations }, base, length * 8);
      return new Uint8Array(bits);
    } catch {
      /* insecure context or no PBKDF2: fall through */
    }
  }
  return noblePbkdf2(nobleSha256, bytesOf(password), bytesOf(salt), { c: iterations, dkLen: length, asyncTick: 20 });
}
