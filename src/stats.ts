/**
 * Public statistics of a whole game without a server: every browser publishes its own report as
 * one replaceable Nostr event (kind 30078) under a per-browser key, tagged with the app. Anyone can
 * read all reports and add them up. A browser's report replaces its previous one, so nothing is
 * counted twice; with DeviceSync, report only this device's own ledger entry (`ledger.of`), so
 * linked devices do not double count either. Ported from the locator's site-stats.js.
 *
 * Reports are public and unauthenticated as to "who" (anyone can invent browsers), so treat totals
 * as indicative, not as a leaderboard to trust.
 */
import { sha256Hex } from './crypto/hash.js';
import { generateSecret, isValidSecret } from './crypto/schnorr.js';
import { fromHex, isHex, toHex } from './util/bytes.js';
import { isRecord } from './util/stable-json.js';
import { realClock, type Clock } from './util/timers.js';
import { signEvent, verifyEvent, type NostrEvent } from './nostr/event.js';
import { publishEvent, queryRelays } from './nostr/pool.js';
import type { WsFactory } from './nostr/socket.js';
import { DEFAULT_STORAGE_RELAYS } from './paths/defaults.js';
import { defaultStorage, SafeStore, type StorageLike } from './storage/kv.js';

export const STATS_KIND = 30078;

/** numbers, or one level of named numbers (e.g. { wins: 3, byFighter: { fries: 2 } }) */
export type Report = Record<string, number | Record<string, number>>;

export interface Totals {
  /** browsers with a non-empty report */
  players: number;
  sums: Record<string, number>;
  maps: Record<string, Record<string, number>>;
  /** newest report time */
  updatedAt: number | null;
}

const MAX_KEYS = 200;

export function cleanReport(x: unknown): Report | null {
  if (!isRecord(x)) return null;
  const out: Report = {};
  let n = 0;
  for (const [k, v] of Object.entries(x)) {
    if (++n > MAX_KEYS || k.length > 64) return null;
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || v < 0 || v > 1e12) return null;
      out[k] = v;
    } else if (isRecord(v)) {
      const inner: Record<string, number> = {};
      let m = 0;
      for (const [ik, iv] of Object.entries(v)) {
        if (++m > MAX_KEYS || ik.length > 64 || typeof iv !== 'number' || !Number.isFinite(iv) || iv < 0 || iv > 1e12) return null;
        inner[ik] = iv;
      }
      out[k] = inner;
    } else return null;
  }
  return out;
}

const empty = (r: Report) => Object.values(r).every((v) => (typeof v === 'number' ? v === 0 : Object.values(v).every((x) => x === 0)));

export interface PublicStatsOptions {
  app: string;
  /** this browser's contribution right now */
  report: () => Report;
  relays?: readonly string[];
  ws?: WsFactory;
  storage?: StorageLike | null;
  clock?: Clock;
  debounceMs?: number;
  timeoutMs?: number;
}

export class PublicStats {
  private store: SafeStore;
  private clock: Clock;
  private timer: unknown = null;
  private lastPublished: string | null = null;
  readonly tag: string;
  readonly d: string;

  constructor(private o: PublicStatsOptions) {
    this.store = new SafeStore(o.storage === undefined ? defaultStorage() : o.storage);
    this.clock = o.clock ?? realClock;
    this.tag = sha256Hex(`hostless/1/stats/${o.app}`).slice(0, 32);
    this.d = `hostless-stats:${this.tag}`;
  }

  /** the per-browser key (created on first use; null without storage: nothing is published) */
  private secret(): Uint8Array | null {
    const k = `hostless:${this.o.app}:stats-key`;
    const saved = this.store.get(k);
    if (saved && isHex(saved, 64) && isValidSecret(fromHex(saved))) return fromHex(saved);
    if (!this.store.available) return null;
    const fresh = generateSecret();
    if (!this.store.set(k, toHex(fresh))) return null;
    // two tabs may race on the first write: whatever is stored now is the key
    const now = this.store.get(k);
    return now && isHex(now, 64) ? fromHex(now) : null;
  }

  /** Publish this browser's report now; resolves with how many relays took it. */
  async publish(): Promise<number> {
    const report = cleanReport(this.o.report());
    if (!report || empty(report)) return 0;
    const text = JSON.stringify(report);
    if (text === this.lastPublished) return 0;
    const secret = this.secret();
    if (!secret) return 0;
    const event = signEvent(secret, { kind: STATS_KIND, created_at: Math.floor(this.clock.now() / 1000), tags: [['d', this.d], ['t', this.tag]], content: text });
    const res = await publishEvent(event, { relays: this.o.relays ?? DEFAULT_STORAGE_RELAYS, ws: this.o.ws, timeoutMs: this.o.timeoutMs ?? 7000 });
    if (res.accepted) this.lastPublished = text;
    return res.accepted;
  }

  /** Publish after `debounceMs` of quiet (call it after every change). */
  schedule(): void {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.publish().catch(() => {});
    }, this.o.debounceMs ?? 20_000);
  }

  /** Read every browser's newest valid report and add them up. */
  async totals(): Promise<Totals> {
    const res = await queryRelays({ kinds: [STATS_KIND], '#t': [this.tag], limit: 5000 }, { relays: this.o.relays ?? DEFAULT_STORAGE_RELAYS, ws: this.o.ws, timeoutMs: this.o.timeoutMs ?? 7000 });
    return totalOf(res.events, this.d);
  }

  stop(): void {
    if (this.timer) this.clock.clearTimeout(this.timer);
  }
}

/** The newest valid report per author, summed. */
export function totalOf(events: NostrEvent[], d: string): Totals {
  const byAuthor = new Map<string, NostrEvent[]>();
  for (const e of events) {
    if (e?.kind !== STATS_KIND || !Array.isArray(e.tags) || !e.tags.some((t) => t[0] === 'd' && t[1] === d)) continue;
    if (typeof e.content !== 'string' || e.content.length > 20_000) continue;
    byAuthor.set(e.pubkey, [...(byAuthor.get(e.pubkey) ?? []), e]);
  }
  const out: Totals = { players: 0, sums: {}, maps: {}, updatedAt: null };
  for (const list of byAuthor.values()) {
    list.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1));
    const e = list.find((x) => verifyEvent(x));
    if (!e) continue;
    let report: Report | null = null;
    try {
      report = cleanReport(JSON.parse(e.content));
    } catch {
      report = null;
    }
    if (!report || empty(report)) continue;
    out.players++;
    out.updatedAt = Math.max(out.updatedAt ?? 0, e.created_at * 1000);
    for (const [k, v] of Object.entries(report)) {
      if (typeof v === 'number') out.sums[k] = (out.sums[k] ?? 0) + v;
      else {
        const m = (out.maps[k] ??= {});
        for (const [ik, iv] of Object.entries(v)) m[ik] = (m[ik] ?? 0) + iv;
      }
    }
  }
  return out;
}

/** The `n` largest entries of a summed map, e.g. the most played fighters. */
export function top(map: Record<string, number> = {}, n = 3): Array<{ key: string; value: number }> {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n)
    .map(([key, value]) => ({ key, value }));
}

export function createPublicStats(opts: PublicStatsOptions): PublicStats {
  return new PublicStats(opts);
}
