import { hkdf, pbkdf2, sha256Hex } from '../crypto/hash.js';
import { toHex } from '../util/bytes.js';

/**
 * Everything derived from (app id, room code). Only `topic` is ever shown to third parties (relay
 * tags, MQTT topics, the WebRTC signaling room); it is the output of a slow KDF, so turning it back
 * into the room code costs one PBKDF2 run per guess over the whole code space.
 */
export interface RoomSecrets {
  appId: string;
  code: string;
  /** 32 hex chars, public */
  topic: string;
  /** AES-GCM key for hellos and mailbox content */
  roomKey: Uint8Array;
  /** Trystero room password */
  rtcPassword: string;
  /** salt for pairwise keys */
  pairSalt: Uint8Array;
}

export const DEFAULT_KDF_ITERATIONS = 60_000;

const cache = new Map<string, Promise<RoomSecrets>>();

export function roomSecrets(appId: string, code: string, iterations = DEFAULT_KDF_ITERATIONS): Promise<RoomSecrets> {
  const id = `${appId}\u0000${code}\u0000${iterations}`;
  let pending = cache.get(id);
  if (!pending) {
    pending = (async () => {
      const master = await pbkdf2(code, `hostless/1/room/${appId}`, iterations, 32);
      return {
        appId,
        code,
        topic: toHex(hkdf(master, '', 'hostless/1/topic', 16)),
        roomKey: hkdf(master, '', 'hostless/1/room-key', 32),
        rtcPassword: toHex(hkdf(master, '', 'hostless/1/rtc', 24)),
        pairSalt: hkdf(master, '', 'hostless/1/pair-salt', 32),
      };
    })();
    cache.set(id, pending);
    pending.catch(() => cache.delete(id));
    if (cache.size > 64) cache.delete(cache.keys().next().value as string);
  }
  return pending;
}

/** A public name derived from the room topic, e.g. the relay topic of one peer. */
export function subTopic(topic: string, name: string): string {
  return sha256Hex(`hostless/1/sub|${topic}|${name}`).slice(0, 32);
}
