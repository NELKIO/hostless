/**
 * One player's progress on several devices, with nothing but public Nostr relays: no server, no
 * account. The player carries a sync key (32 symbols, 160 bits) from device to device as a link
 * (`#sync=KEY`) or by typing it. From the key every device derives the same signing key and AES key;
 * the app's document is compressed, encrypted and published as one replaceable NIP-78 event (kind
 * 30078). Relays only see an opaque blob under a pseudonymous key, and only key holders can replace it.
 *
 * The app supplies `merge(local, remotes)`, which must be a CRDT join (see crdt.ts); the controller
 * pulls, merges into the local store in one write, and publishes only when fewer than `holdTarget`
 * reachable relays already hold the merged document. Generalised from the locator's sync.js:
 * - an authentic document it cannot read (newer format, damaged) blocks publishing: overwriting it
 *   could erase someone's progress;
 * - a document from a newer app version is never merged nor overwritten ('outdated');
 * - a device whose clock is ahead is followed by at most ten minutes; relays refuse events from the
 *   future, so a second attempt uses the time of the newest event they hold;
 * - one sync at a time; a request during a run gets exactly one more run after it.
 */
import { aesOpen, aesSeal } from '../crypto/aes.js';
import { deflate, inflate } from '../crypto/compress.js';
import { hkdf, sha256, sha256Hex } from '../crypto/hash.js';
import { isValidSecret, peerIdOf } from '../crypto/schnorr.js';
import { fromB64, fromUtf8, toB64, utf8 } from '../util/bytes.js';
import { Emitter } from '../util/emitter.js';
import { isRecord, stableJson } from '../util/stable-json.js';
import { realClock, type Clock } from '../util/timers.js';
import { newSyncKey, parseSyncKey } from '../code.js';
import { signEvent, verifyEvent, type NostrEvent } from '../nostr/event.js';
import { publishEvent, queryRelays } from '../nostr/pool.js';
import type { WsFactory } from '../nostr/socket.js';
import { DEFAULT_STORAGE_RELAYS } from '../paths/defaults.js';
import { defaultStorage, SafeStore, type StorageLike } from '../storage/kv.js';

export const SYNC_KIND = 30078;
const MAX_DOC_BYTES = 1_000_000;
const MAX_EVENT_CHARS = 400_000;

export interface SyncAccount {
  pubkey: string;
  secret: Uint8Array;
  aes: Uint8Array;
  d: string;
}

export function accountOf(app: string, key: string): SyncAccount {
  let secret = sha256(`hostless/1/sync/sign/${app}/${key}`);
  for (let i = 0; !isValidSecret(secret) && i < 8; i++) secret = sha256(secret);
  return {
    secret,
    pubkey: peerIdOf(secret),
    aes: hkdf(key, `hostless/1/sync/${app}`, 'aes', 32),
    d: sha256Hex(`hostless/1/sync/d/${app}`),
  };
}

export interface SyncedDoc<D> {
  /** document format version */
  v: number;
  doc: D;
}

export function sealDoc<D>(account: SyncAccount, doc: SyncedDoc<D>, createdAt: number): NostrEvent {
  const plain = utf8(JSON.stringify(doc));
  if (plain.length > MAX_DOC_BYTES) throw new Error('hostless: sync document too large');
  const packed = deflate(plain);
  const useZip = packed.length < plain.length;
  const blob = aesSeal(account.aes, useZip ? packed : plain, utf8(account.d));
  const content = (useZip ? 'z1:' : 'p1:') + toB64(blob);
  if (content.length > MAX_EVENT_CHARS) throw new Error('hostless: sync document too large');
  return signEvent(account.secret, { kind: SYNC_KIND, created_at: createdAt, tags: [['d', account.d]], content });
}

export type ReadResult<D> = { doc: SyncedDoc<D> } | { unreadable: true } | null;

/** null: not ours (or forged); unreadable: ours but cannot be read */
export function openDoc<D>(account: SyncAccount, event: unknown): ReadResult<D> {
  if (!verifyEvent(event) || event.pubkey !== account.pubkey || event.kind !== SYNC_KIND || !event.tags.some((t) => t[0] === 'd' && t[1] === account.d)) return null;
  const mode = event.content.slice(0, 3);
  if (event.content.length > MAX_EVENT_CHARS || (mode !== 'z1:' && mode !== 'p1:')) return { unreadable: true };
  const blob = fromB64(event.content.slice(3));
  const body = blob && aesOpen(account.aes, blob, utf8(account.d));
  if (!body) return { unreadable: true };
  const plain = mode === 'z1:' ? inflate(body, MAX_DOC_BYTES) : body;
  if (!plain) return { unreadable: true };
  try {
    const doc = JSON.parse(fromUtf8(plain));
    if (!isRecord(doc) || !Number.isSafeInteger(doc.v) || (doc.v as number) < 1 || !('doc' in doc)) return { unreadable: true };
    return { doc: doc as unknown as SyncedDoc<D> };
  } catch {
    return { unreadable: true };
  }
}

/** Where the app keeps the synced document (e.g. its saved game). */
export interface SyncStore<D> {
  read(): D;
  /** store the merged document; may be async */
  write(next: D): void | boolean | Promise<void | boolean>;
  /** local changes (made by the app) → a sync is scheduled */
  subscribe?(listener: () => void): () => void;
}

export type SyncState = 'off' | 'syncing' | 'ok' | 'offline' | 'unreadable' | 'outdated' | 'error' | 'paused';

export interface SyncStatus {
  state: SyncState;
  /** last successful sync */
  at: number | null;
  /** relays that hold the current document */
  relays: number;
  error: string | null;
}

export interface DeviceSyncOptions<D> {
  app: string;
  store: SyncStore<D>;
  /** join of the local document with remote ones; must be commutative, associative, idempotent */
  merge(local: D, remotes: D[]): D;
  /** the format version this build writes (newer remote versions are never overwritten) */
  version?: number;
  /** stored where? default localStorage under `hostless:<app>:sync` */
  keyStorage?: StorageLike | null;
  relays?: readonly string[];
  ws?: WsFactory;
  clock?: Clock;
  debounceMs?: number;
  intervalMs?: number;
  timeoutMs?: number;
  /** publish until this many relays hold the document */
  holdTarget?: number;
  /** pause automatic syncs (e.g. during a match) */
  paused?: () => boolean;
  /** listen for page visibility (default: the global document, if any) */
  document?: { hidden?: boolean; addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void } | null;
}

export interface DeviceSyncEvents {
  [event: string]: unknown[];
  status: [status: SyncStatus];
  /** the local document changed because of a merge */
  merged: [];
}

export class DeviceSync<D> {
  readonly events = new Emitter<DeviceSyncEvents>();
  private o: DeviceSyncOptions<D>;
  private keys: SafeStore;
  private keyName: string;
  private clock: Clock;
  private _status: SyncStatus = { state: 'off', at: null, relays: 0, error: null };
  private running: Promise<SyncStatus> | null = null;
  private followUp: Promise<SyncStatus> | null = null;
  private timer: unknown = null;
  private ticker: unknown = null;
  private latestCreated = 0;
  private account: { key: string; acc: SyncAccount } | null = null;
  private written: string | null = null;
  private offs: Array<() => void> = [];
  private version: number;

  constructor(opts: DeviceSyncOptions<D>) {
    this.o = opts;
    this.clock = opts.clock ?? realClock;
    this.version = opts.version ?? 1;
    this.keys = new SafeStore(opts.keyStorage === undefined ? defaultStorage() : opts.keyStorage);
    this.keyName = `hostless:${opts.app}:sync`;
    const unsub = opts.store.subscribe?.(() => {
      if (!this.key) return;
      if (this.written !== null && stableJson(opts.store.read()) === this.written) return;
      this.schedule();
    });
    if (unsub) this.offs.push(unsub);
    const doc = opts.document === undefined ? (globalThis as { document?: DeviceSyncOptions<D>['document'] }).document : opts.document;
    if (doc?.addEventListener) {
      const onVisible = () => {
        if (!doc.hidden) this.schedule(300);
      };
      doc.addEventListener('visibilitychange', onVisible);
      this.offs.push(() => doc.removeEventListener?.('visibilitychange', onVisible));
    }
    this.doc = doc ?? null;
  }

  private doc: DeviceSyncOptions<D>['document'];

  get status(): SyncStatus {
    return this._status;
  }

  /** the linked key, or null */
  get key(): string | null {
    const k = this.keys.get(this.keyName);
    return k && parseSyncKey(k) ? k : null;
  }

  /** a fresh key to link a first device with */
  static newKey(): string {
    return newSyncKey();
  }

  private set(next: Partial<SyncStatus>): void {
    this._status = { ...this._status, ...next };
    this.events.emit('status', this._status);
  }

  private accountFor(key: string): SyncAccount {
    if (this.account?.key !== key) {
      this.account = { key, acc: accountOf(this.o.app, key) };
      this.latestCreated = 0;
    }
    return this.account.acc;
  }

  /** Start periodic syncs (and sync now if linked). */
  start(): Promise<SyncStatus> {
    if (this.ticker) this.clock.clearInterval(this.ticker);
    this.ticker = this.clock.setInterval(() => {
      if (!this.doc?.hidden) void this.syncNow();
    }, this.o.intervalMs ?? 90_000);
    if (this.key) return this.syncNow();
    this.set({ state: 'off' });
    return Promise.resolve(this._status);
  }

  stop(): void {
    if (this.timer) this.clock.clearTimeout(this.timer);
    if (this.ticker) this.clock.clearInterval(this.ticker);
    this.timer = this.ticker = null;
    for (const off of this.offs) off();
    this.offs = [];
  }

  /** Link this device to `keyText` (a key or a `#sync=` link) and merge at once. */
  async link(keyText: string): Promise<{ ok: boolean; reason?: string; status?: SyncStatus }> {
    const key = parseSyncKey(keyText);
    if (!key) return { ok: false, reason: 'bad-key' };
    if (!this.keys.set(this.keyName, key)) return { ok: false, reason: 'storage' };
    return { ok: true, status: await this.syncNow() };
  }

  /** Stop syncing on this device; local progress stays. */
  unlink(): void {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.keys.remove(this.keyName);
    this.account = null;
    this.set({ state: 'off', at: null, relays: 0, error: null });
  }

  schedule(delay = this.o.debounceMs ?? 2500): void {
    if (this.timer) this.clock.clearTimeout(this.timer);
    if (!this.key) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.syncNow();
    }, delay);
  }

  /** One sync (single-flight: a call during a run gets one more run right after it). */
  syncNow(): Promise<SyncStatus> {
    if (this.running) {
      this.followUp ??= this.running.then(() => {
        this.followUp = null;
        return this.syncNow();
      });
      return this.followUp;
    }
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<SyncStatus> {
    const key = this.key;
    if (!key) {
      this.set({ state: 'off' });
      return this._status;
    }
    if (this.o.paused?.()) {
      this.schedule(3000);
      return { ...this._status, state: 'paused' };
    }
    this.set({ state: 'syncing', error: null });
    try {
      const acc = this.accountFor(key);
      const relays = this.o.relays ?? DEFAULT_STORAGE_RELAYS;
      const timeoutMs = this.o.timeoutMs ?? 7000;
      const res = await queryRelays({ kinds: [SYNC_KIND], authors: [acc.pubkey], '#d': [acc.d], limit: 3 }, { relays, ws: this.o.ws, timeoutMs, maxFrame: 2 * MAX_EVENT_CHARS });
      if (this.key !== key) {
        this.set({ state: 'off' });
        return this._status;
      }
      const reachable = res.perRelay.filter((r) => r.ok).map((r) => r.url);
      const opened: Array<{ url: string; created: number; doc: SyncedDoc<D> }> = [];
      let unreadable = false;
      for (const r of res.perRelay) {
        for (const e of r.events) {
          const read = openDoc<D>(acc, e);
          if (!read) continue;
          if ('unreadable' in read) unreadable = true;
          else opened.push({ url: r.url, created: e.created_at, doc: read.doc });
        }
      }
      if (unreadable) {
        this.set({ state: 'unreadable', relays: reachable.length });
        return this._status;
      }
      if (!reachable.length) {
        this.set({ state: 'offline', relays: 0 });
        return this._status;
      }
      if (opened.some((o) => o.doc.v > this.version)) {
        this.set({ state: 'outdated', relays: reachable.length });
        return this._status;
      }
      this.latestCreated = Math.max(this.latestCreated, ...opened.map((o) => o.created));
      const local = this.o.store.read();
      const merged = this.o.merge(local, opened.map((o) => o.doc.doc));
      const text = stableJson(merged);
      if (text !== stableJson(local)) {
        this.written = text;
        await this.o.store.write(merged);
        this.events.emit('merged');
      }
      if (this.key !== key) {
        this.set({ state: 'off' });
        return this._status;
      }
      const envelope: SyncedDoc<D> = { v: this.version, doc: merged };
      const docText = stableJson(merged);
      const holding = new Set(opened.filter((o) => stableJson(o.doc.doc) === docText && o.doc.v === this.version).map((o) => o.url));
      let held = holding.size;
      const target = Math.min(this.o.holdTarget ?? 3, reachable.length);
      if (held < target) {
        const nowS = Math.floor(this.clock.now() / 1000);
        // never behind what a relay holds (the relay keeps only the newest); a device clock far
        // ahead is followed by at most ten minutes
        const tries = [Math.max(nowS, Math.min(this.latestCreated + 1, nowS + 600))];
        if (this.latestCreated && tries[0] !== this.latestCreated + 1) tries.push(this.latestCreated + 1);
        for (const createdAt of tries) {
          const pub = await publishEvent(sealDoc(acc, envelope, createdAt), { relays: reachable, ws: this.o.ws, timeoutMs });
          if (pub.accepted) {
            this.latestCreated = Math.max(this.latestCreated, createdAt);
            held = Math.max(held, pub.accepted);
            break;
          }
        }
      }
      if (held) this.set({ state: 'ok', at: this.clock.now(), relays: held });
      else this.set({ state: 'offline', relays: 0 });
    } catch (error) {
      this.set({ state: 'error', error: String((error as Error)?.message ?? error) });
    }
    return this._status;
  }
}

export function createDeviceSync<D>(opts: DeviceSyncOptions<D>): DeviceSync<D> {
  return new DeviceSync(opts);
}
