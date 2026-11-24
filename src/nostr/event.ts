/** NIP-01 events: canonical id, BIP-340 signatures, shape checks. */
import { sha256 } from '../crypto/hash.js';
import { schnorrSign, schnorrVerify, peerIdOf } from '../crypto/schnorr.js';
import { fromHex, isHex, randomBytes, toHex, type RandomBytes } from '../util/bytes.js';

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type UnsignedEvent = Omit<NostrEvent, 'id' | 'pubkey' | 'sig'>;

export const canonical = (e: Omit<NostrEvent, 'id' | 'sig'>) => JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);

export function eventId(e: Omit<NostrEvent, 'id' | 'sig'>): string {
  return toHex(sha256(canonical(e)));
}

export function signEvent(secret: Uint8Array, event: UnsignedEvent, random: RandomBytes = randomBytes): NostrEvent {
  const full = { ...event, pubkey: peerIdOf(secret) };
  const digest = sha256(canonical(full));
  return { ...full, id: toHex(digest), sig: toHex(schnorrSign(digest, secret, random)) };
}

export function isEventShape(e: unknown): e is NostrEvent {
  if (!e || typeof e !== 'object') return false;
  const x = e as Record<string, unknown>;
  return (
    isHex(x.id, 64) &&
    isHex(x.pubkey, 64) &&
    isHex(x.sig, 128) &&
    Number.isSafeInteger(x.created_at) &&
    Number.isSafeInteger(x.kind) &&
    typeof x.content === 'string' &&
    Array.isArray(x.tags) &&
    x.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string'))
  );
}

/** Shape, id and signature. */
export function verifyEvent(e: unknown): e is NostrEvent {
  if (!isEventShape(e)) return false;
  try {
    const digest = sha256(canonical(e));
    if (toHex(digest) !== e.id) return false;
    return schnorrVerify(fromHex(e.sig), digest, fromHex(e.pubkey));
  } catch {
    return false;
  }
}

export const tagValue = (e: Pick<NostrEvent, 'tags'>, name: string): string | undefined => e.tags.find((t) => t[0] === name)?.[1];

/** NIP-40: the event carries an expiration in the past. */
export function isExpired(e: Pick<NostrEvent, 'tags'>, nowSeconds: number): boolean {
  const exp = tagValue(e, 'expiration');
  return exp !== undefined && /^\d{1,12}$/.test(exp) && Number(exp) <= nowSeconds;
}
