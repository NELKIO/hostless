import { gcm } from '@noble/ciphers/aes.js';
import { concat, randomBytes, type RandomBytes } from '../util/bytes.js';

export const IV_BYTES = 12;
export const TAG_BYTES = 16;
/** Bytes AES-GCM adds to a plaintext: IV + tag. */
export const SEAL_OVERHEAD = IV_BYTES + TAG_BYTES;

/** `iv(12) | ciphertext+tag`. Synchronous. */
export function aesSeal(key: Uint8Array, plain: Uint8Array, aad?: Uint8Array, random: RandomBytes = randomBytes): Uint8Array {
  const iv = random(IV_BYTES);
  return concat(iv, gcm(key, iv, aad).encrypt(plain));
}

/** null when the blob is malformed, the key is wrong, or anything was tampered with. */
export function aesOpen(key: Uint8Array, blob: Uint8Array, aad?: Uint8Array): Uint8Array | null {
  if (blob.length < SEAL_OVERHEAD) return null;
  try {
    return gcm(key, blob.subarray(0, IV_BYTES), aad).decrypt(blob.subarray(IV_BYTES));
  } catch {
    return null;
  }
}
