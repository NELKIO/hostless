/**
 * Wire frames carried by every path.
 *
 *   HELLO = 0x01 | AES-GCM(roomKey, json(HelloBody), aad = 0x01)
 *   DATA  = 0x02 | from(32) | to(32) | AES-GCM(pairKey(from, to), segment, aad = 0x02|from|to)
 *
 * A HELLO is readable by anyone holding the room code and is schnorr-signed by its author. A DATA
 * frame is readable only by the two peers; one that decrypts is authenticated as the other peer.
 */
import { aesOpen, aesSeal, SEAL_OVERHEAD } from '../crypto/aes.js';
import { hkdf, sha256 } from '../crypto/hash.js';
import { concat, fromHex, fromUtf8, isHex, toHex, utf8, type RandomBytes, randomBytes } from '../util/bytes.js';
import { isRecord, stableJson, tryParse } from '../util/stable-json.js';
import { Identity, isPeerId, verifyDigest, type PeerId } from '../identity.js';
import type { RoomSecrets } from './secrets.js';

export const HELLO = 0x01;
export const DATA = 0x02;
export const DATA_HEADER = 1 + 32 + 32;
/** bytes a DATA frame adds around its segment */
export const DATA_OVERHEAD = DATA_HEADER + SEAL_OVERHEAD;
export const MAX_HELLO_BYTES = 1500;
export const HELLO_WINDOW_MS = 120_000;

export interface AppInfo {
  id: string;
  /** peers with different protocol numbers never link */
  protocol: number | string;
  /** informational (shown in version errors) */
  version?: string;
}

export interface HelloBody {
  v: 1;
  from: PeerId;
  /** session id of the sender page, 16 hex */
  sid: string;
  /** sender clock, ms */
  at: number;
  /** addressed hello (reply to a peer) or null (to the room) */
  to: PeerId | null;
  app: AppInfo;
  meta: Record<string, unknown>;
  /** per-path hints, e.g. { nostr: relayMask } */
  hints: Record<string, unknown>;
  /** the room refuses the addressee */
  reject?: 'full' | 'protocol';
  /** the sender leaves (bye) */
  bye?: boolean;
}

export interface Hello extends HelloBody {
  sig: string;
}

const HELLO_AAD = new Uint8Array([HELLO]);

export function encodeHello(identity: Identity, secrets: RoomSecrets, body: Omit<HelloBody, 'v' | 'from'>, random: RandomBytes = randomBytes): Uint8Array {
  const full: HelloBody = { v: 1, from: identity.peerId, ...body };
  const signed: Hello = { ...full, sig: toHex(identity.signDigest(sha256(stableJson(full)))) };
  const plain = utf8(JSON.stringify(signed));
  const frame = concat(new Uint8Array([HELLO]), aesSeal(secrets.roomKey, plain, HELLO_AAD, random));
  if (frame.length > MAX_HELLO_BYTES) throw new Error(`hostless: hello too large (${frame.length} B); keep meta small`);
  return frame;
}

export type HelloResult = { ok: true; hello: Hello } | { ok: false; reason: 'malformed' | 'key' | 'signature' | 'stale' };

/** Decrypts and verifies a HELLO frame. `now` is the receiver clock. */
export function decodeHello(secrets: RoomSecrets, frame: Uint8Array, now: number, windowMs = HELLO_WINDOW_MS): HelloResult {
  if (frame[0] !== HELLO || frame.length > MAX_HELLO_BYTES) return { ok: false, reason: 'malformed' };
  const plain = aesOpen(secrets.roomKey, frame.subarray(1), HELLO_AAD);
  if (!plain) return { ok: false, reason: 'key' };
  let parsed: unknown;
  try {
    parsed = tryParse(fromUtf8(plain));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!validHello(parsed)) return { ok: false, reason: 'malformed' };
  const { sig, ...body } = parsed;
  let digest: Uint8Array;
  try {
    digest = sha256(stableJson(body));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!verifyDigest(parsed.from, digest, fromHex(sig))) return { ok: false, reason: 'signature' };
  if (Math.abs(now - parsed.at) > windowMs) return { ok: false, reason: 'stale' };
  return { ok: true, hello: parsed };
}

function validHello(x: unknown): x is Hello {
  if (!isRecord(x)) return false;
  return (
    x.v === 1 &&
    isPeerId(x.from) &&
    isHex(x.sid, 16) &&
    Number.isSafeInteger(x.at) &&
    (x.to === null || isPeerId(x.to)) &&
    isRecord(x.app) &&
    typeof x.app.id === 'string' &&
    (typeof x.app.protocol === 'number' || typeof x.app.protocol === 'string') &&
    isRecord(x.meta) &&
    isRecord(x.hints) &&
    (x.reject === undefined || x.reject === 'full' || x.reject === 'protocol') &&
    (x.bye === undefined || typeof x.bye === 'boolean') &&
    isHex(x.sig, 128)
  );
}

/** Pairwise AES keys of one identity in one room, cached per peer. */
export class PairKeys {
  private keys = new Map<PeerId, Uint8Array>();
  constructor(
    private identity: Identity,
    private secrets: RoomSecrets,
  ) {}

  key(peer: PeerId): Uint8Array {
    let key = this.keys.get(peer);
    if (!key) {
      const [a, b] = [this.identity.peerId, peer].sort();
      key = hkdf(this.identity.sharedSecret(peer), this.secrets.pairSalt, `hostless/1/pair/${a}/${b}`, 32);
      this.keys.set(peer, key);
      if (this.keys.size > 256) this.keys.delete(this.keys.keys().next().value as PeerId);
    }
    return key;
  }
}

export function encodeData(keys: PairKeys, from: PeerId, to: PeerId, segment: Uint8Array, random: RandomBytes = randomBytes): Uint8Array {
  const header = concat(new Uint8Array([DATA]), fromHex(from), fromHex(to));
  return concat(header, aesSeal(keys.key(to), segment, header, random));
}

/** The addressing of a DATA frame (unauthenticated until opened). */
export function dataHeader(frame: Uint8Array): { from: PeerId; to: PeerId } | null {
  if (frame[0] !== DATA || frame.length < DATA_OVERHEAD) return null;
  return { from: toHex(frame.subarray(1, 33)), to: toHex(frame.subarray(33, 65)) };
}

/** The segment of a DATA frame from `from`, or null if it does not authenticate. */
export function openData(keys: PairKeys, from: PeerId, frame: Uint8Array): Uint8Array | null {
  if (!isPeerId(from)) return null;
  return aesOpen(keys.key(from), frame.subarray(DATA_HEADER), frame.subarray(0, DATA_HEADER));
}

export const frameKind = (frame: Uint8Array): 'hello' | 'data' | null => (frame[0] === HELLO ? 'hello' : frame[0] === DATA ? 'data' : null);

export { utf8 };
