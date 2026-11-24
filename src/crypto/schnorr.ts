import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { concat, fromHex, isHex, randomBytes, toHex, type RandomBytes } from '../util/bytes.js';

/**
 * BIP-340 Schnorr over secp256k1 (the Nostr signature scheme) and x-only ECDH.
 * A "peer id" is the 32-byte x-only public key in hex.
 */
const N = secp256k1.Point.CURVE().n;

export function isValidSecret(secret: Uint8Array): boolean {
  if (secret.length !== 32) return false;
  let value = 0n;
  for (const byte of secret) value = (value << 8n) | BigInt(byte);
  return value > 0n && value < N;
}

export function generateSecret(random: RandomBytes = randomBytes): Uint8Array {
  for (;;) {
    const secret = random(32);
    if (isValidSecret(secret)) return secret;
  }
}

export function publicKeyOf(secret: Uint8Array): Uint8Array {
  return schnorr.getPublicKey(secret);
}

export function schnorrSign(message: Uint8Array, secret: Uint8Array, random: RandomBytes = randomBytes): Uint8Array {
  return schnorr.sign(message, secret, random(32));
}

export function schnorrVerify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return schnorr.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

const validIds = new Set<string>();

export function isPeerId(value: unknown): value is string {
  if (!isHex(value, 64)) return false;
  if (validIds.has(value)) return true;
  try {
    schnorr.utils.lift_x(BigInt('0x' + value));
  } catch {
    return false;
  }
  validIds.add(value);
  if (validIds.size > 4096) validIds.delete(validIds.values().next().value as string);
  return true;
}

/**
 * The x coordinate of secret·P for the x-only key `peer`. x(k·P) = x(k·(−P)), so both parities of
 * the lifted point give the same result and the two ends agree.
 */
export function ecdhX(secret: Uint8Array, peer: string | Uint8Array): Uint8Array {
  const xonly = typeof peer === 'string' ? fromHex(peer) : peer;
  const shared = secp256k1.getSharedSecret(secret, concat(new Uint8Array([2]), xonly), true);
  return shared.subarray(1, 33);
}

export const peerIdOf = (secret: Uint8Array): string => toHex(publicKeyOf(secret));
