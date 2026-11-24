/**
 * Store-and-forward on Nostr: a finished match's final journal is offered to relays as an encrypted,
 * signed, parameterized-replaceable event (kind 30078, NIP-78) with a NIP-40 expiration. A player who
 * comes back days later can fetch it even if everyone else has closed the game.
 *
 * - the author is the seat identity of the player who stored it (relays see a per-room key);
 * - `d` = H(room topic | key): relays see neither the room code nor the match;
 * - content = AES-GCM(roomKey, {to, value}): only code holders can read it; the reader also checks
 *   the author is the peer it expects. Ported from the locator's duel-mailbox.js / sealFinal.
 */
import { aesOpen, aesSeal } from './crypto/aes.js';
import { sha256Hex } from './crypto/hash.js';
import { fromB64, fromUtf8, toB64, utf8, randomBytes, type RandomBytes } from './util/bytes.js';
import { isRecord } from './util/stable-json.js';
import { signEvent, verifyEvent, type NostrEvent } from './nostr/event.js';
import { publishEvent, queryRelays } from './nostr/pool.js';
import type { WsFactory } from './nostr/socket.js';
import { DEFAULT_STORAGE_RELAYS } from './paths/defaults.js';
import { fromHex } from './util/bytes.js';
import type { Identity, PeerId } from './identity.js';
import type { RoomSecrets } from './room/secrets.js';

export const MAILBOX_KIND = 30078;
const AAD = utf8('hostless/1/mailbox');

export interface MailboxOptions {
  secrets: RoomSecrets;
  identity: Identity;
  relays?: readonly string[];
  ws?: WsFactory;
  /** how long relays should keep a copy (NIP-40), default 30 days */
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
  random?: RandomBytes;
}

export class Mailbox {
  private relays: readonly string[];
  constructor(private o: MailboxOptions) {
    this.relays = o.relays ?? DEFAULT_STORAGE_RELAYS;
  }

  private tag(author: PeerId, key: string): string {
    return sha256Hex(`hostless/1/mailbox|${this.o.secrets.topic}|${author}|${key}`);
  }

  private secret(): Uint8Array {
    return fromHex(this.o.identity.exportSecret());
  }

  /** Seal a value under `key` (e.g. a match id) for `to` (peer ids). */
  seal(key: string, value: unknown, to: PeerId[]): NostrEvent {
    const now = (this.o.now ?? Date.now)();
    const expires = Math.floor((now + (this.o.ttlMs ?? 30 * 24 * 3600_000)) / 1000);
    const plain = utf8(JSON.stringify({ k: key, to, value }));
    const content = toB64(aesSeal(this.o.secrets.roomKey, plain, AAD, this.o.random ?? randomBytes));
    return signEvent(
      this.secret(),
      {
        kind: MAILBOX_KIND,
        created_at: Math.floor(now / 1000),
        tags: [
          ['d', this.tag(this.o.identity.peerId, key)],
          ['expiration', String(expires)],
        ],
        content,
      },
      this.o.random,
    );
  }

  /** Publish; resolves with how many relays accepted the copy. */
  async put(key: string, value: unknown, to: PeerId[]): Promise<number> {
    const event = this.seal(key, value, to);
    const res = await publishEvent(event, { relays: this.relays, ws: this.o.ws, timeoutMs: this.o.timeoutMs ?? 7000 });
    return res.accepted;
  }

  /** Read and verify an event: the author must be `author`, the key and recipient must match. */
  open(event: unknown, author: PeerId, key: string): unknown | undefined {
    if (!verifyEvent(event) || event.pubkey !== author || event.kind !== MAILBOX_KIND) return undefined;
    if (!event.tags.some((t) => t[0] === 'd' && t[1] === this.tag(author, key))) return undefined;
    const blob = fromB64(event.content);
    if (!blob) return undefined;
    const plain = aesOpen(this.o.secrets.roomKey, blob, AAD);
    if (!plain) return undefined;
    let body: unknown;
    try {
      body = JSON.parse(fromUtf8(plain));
    } catch {
      return undefined;
    }
    if (!isRecord(body) || body.k !== key || !Array.isArray(body.to) || !body.to.includes(this.o.identity.peerId)) return undefined;
    return body.value;
  }

  /** Fetch what `author` stored under `key` for us (undefined when nothing is there). */
  async get(author: PeerId, key: string): Promise<unknown | undefined> {
    const res = await queryRelays(
      { kinds: [MAILBOX_KIND], authors: [author], '#d': [this.tag(author, key)], limit: 2 },
      { relays: this.relays, ws: this.o.ws, timeoutMs: this.o.timeoutMs ?? 7000 },
    );
    const sorted = res.events.sort((a, b) => b.created_at - a.created_at);
    for (const e of sorted) {
      const value = this.open(e, author, key);
      if (value !== undefined) return value;
    }
    return undefined;
  }
}
