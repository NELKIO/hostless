import { ecdhX, generateSecret, isPeerId, isValidSecret, peerIdOf, schnorrSign, schnorrVerify } from './crypto/schnorr.js';
import { sha256 } from './crypto/hash.js';
import { fromHex, isHex, randomBytes, toHex, utf8, type RandomBytes } from './util/bytes.js';
import { stableJson } from './util/stable-json.js';

export type PeerId = string;

/**
 * A participant key: a secp256k1 secret whose x-only public key is the peer id. It signs hellos,
 * moves and ops, and derives pairwise keys (ECDH) with other peers.
 */
export class Identity {
  readonly peerId: PeerId;
  private readonly secret: Uint8Array;
  private readonly pairCache = new Map<PeerId, Uint8Array>();

  private constructor(secret: Uint8Array, private readonly random: RandomBytes) {
    this.secret = secret;
    this.peerId = peerIdOf(secret);
  }

  static generate(random: RandomBytes = randomBytes): Identity {
    return new Identity(generateSecret(random), random);
  }

  static fromSecret(secret: string | Uint8Array, random: RandomBytes = randomBytes): Identity {
    const bytes = typeof secret === 'string' ? (isHex(secret, 64) ? fromHex(secret) : new Uint8Array()) : secret;
    if (!isValidSecret(bytes)) throw new Error('hostless: invalid identity secret');
    return new Identity(new Uint8Array(bytes), random);
  }

  static isSecret(value: unknown): value is string {
    return isHex(value, 64) && isValidSecret(fromHex(value));
  }

  /** The secret as 64 hex chars, for persistence. Treat as a password. */
  exportSecret(): string {
    return toHex(this.secret);
  }

  /** Schnorr signature (64 bytes) of a 32-byte digest. */
  signDigest(digest: Uint8Array): Uint8Array {
    return schnorrSign(digest, this.secret, this.random);
  }

  /** Hex signature of sha256(stableJson(value)). */
  signValue(value: unknown): string {
    return toHex(this.signDigest(sha256(utf8(stableJson(value)))));
  }

  /** The shared x coordinate with `peer` (cached). Both ends compute the same bytes. */
  sharedSecret(peer: PeerId): Uint8Array {
    let shared = this.pairCache.get(peer);
    if (!shared) {
      shared = ecdhX(this.secret, peer);
      this.pairCache.set(peer, shared);
      if (this.pairCache.size > 256) this.pairCache.delete(this.pairCache.keys().next().value as PeerId);
    }
    return shared;
  }
}

/** Verifies a hex signature made by `Identity.signValue`. */
export function verifyValue(peerId: PeerId, value: unknown, signatureHex: unknown): boolean {
  if (!isHex(signatureHex, 128) || !isPeerId(peerId)) return false;
  let digest: Uint8Array;
  try {
    digest = sha256(utf8(stableJson(value)));
  } catch {
    return false;
  }
  return schnorrVerify(fromHex(signatureHex), digest, fromHex(peerId));
}

export function verifyDigest(peerId: PeerId, digest: Uint8Array, signature: Uint8Array): boolean {
  if (!isPeerId(peerId)) return false;
  return schnorrVerify(signature, digest, fromHex(peerId));
}

export { isPeerId };
