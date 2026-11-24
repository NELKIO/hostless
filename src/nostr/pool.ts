/**
 * One-shot relay requests (publish one event, run one query) over short-lived sockets, on many relays
 * in parallel. Used for stored data: mailbox finals, device sync documents, public statistics.
 * Ported from the locator's sync.js (`talk`, `publishEvent`, `queryRelays`).
 */
import { defaultWsFactory, type WsFactory } from './socket.js';
import type { NostrEvent } from './event.js';

export interface PoolOptions {
  relays: readonly string[];
  ws?: WsFactory;
  timeoutMs?: number;
  /** frames larger than this end the request on that relay */
  maxFrame?: number;
}

export type Filter = Record<string, unknown>;

interface TalkResult {
  url: string;
  ok: boolean;
  got: unknown[];
  message?: string;
}

function talk(
  ws: WsFactory,
  url: string,
  request: unknown,
  finished: (reply: unknown[], got: unknown[]) => boolean | undefined | { ok: boolean; message?: string },
  timeoutMs: number,
  maxFrame: number,
): Promise<TalkResult> {
  return new Promise((resolve) => {
    const got: unknown[] = [];
    let socket: ReturnType<WsFactory> | null = null;
    let done = false;
    const end = (ok: boolean, message?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
      resolve({ url, ok, got, message });
    };
    const timer = setTimeout(() => end(false, 'timeout'), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    try {
      socket = ws(url);
    } catch (error) {
      end(false, String(error));
      return;
    }
    socket.onopen = () => {
      try {
        socket!.send(JSON.stringify(request));
      } catch (error) {
        end(false, String(error));
      }
    };
    socket.onerror = () => end(false, 'error');
    socket.onclose = () => end(false, 'closed');
    socket.onmessage = ({ data }) => {
      if (typeof data !== 'string') return;
      if (data.length > maxFrame) {
        end(false, 'frame too large');
        return;
      }
      let reply: unknown;
      try {
        reply = JSON.parse(data);
      } catch {
        return;
      }
      if (!Array.isArray(reply)) return;
      const verdict = finished(reply, got);
      if (verdict === undefined) return;
      if (typeof verdict === 'boolean') end(verdict);
      else end(verdict.ok, verdict.message);
    };
  });
}

export interface PublishResult {
  /** relays that confirmed with OK true */
  accepted: number;
  replies: Array<{ url: string; ok: boolean; message?: string }>;
}

/** Publish on every relay; resolves once each relay answered or timed out. */
export async function publishEvent(event: NostrEvent, { relays, ws = defaultWsFactory, timeoutMs = 7000, maxFrame = 65_536 }: PoolOptions): Promise<PublishResult> {
  const replies = await Promise.all(
    relays.map((url) =>
      talk(
        ws,
        url,
        ['EVENT', event],
        (reply) => {
          if (reply[0] === 'OK' && reply[1] === event.id) return { ok: reply[2] === true, message: String(reply[3] ?? '') };
          return undefined;
        },
        timeoutMs,
        maxFrame,
      ),
    ),
  );
  return { accepted: replies.filter((r) => r.ok).length, replies: replies.map(({ url, ok, message }) => ({ url, ok, message })) };
}

export interface QueryResult {
  /** distinct events (identical copies from several relays collapse; differing copies are all kept) */
  events: NostrEvent[];
  /** relays that answered with EOSE */
  reachable: number;
  perRelay: Array<{ url: string; ok: boolean; events: NostrEvent[] }>;
}

let subCounter = 0;

/** Run one REQ on every relay until EOSE; events are NOT verified here (callers verify). */
export async function queryRelays(filter: Filter, { relays, ws = defaultWsFactory, timeoutMs = 7000, maxFrame = 2_000_000 }: PoolOptions): Promise<QueryResult> {
  const sub = `hl${(++subCounter).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const replies = await Promise.all(
    relays.map((url) =>
      talk(
        ws,
        url,
        ['REQ', sub, filter],
        (reply, got) => {
          if (reply[0] === 'EVENT' && reply[1] === sub) got.push(reply[2]);
          if ((reply[0] === 'EOSE' || reply[0] === 'CLOSED') && reply[1] === sub) return reply[0] === 'EOSE';
          return undefined;
        },
        timeoutMs,
        maxFrame,
      ),
    ),
  );
  const seen = new Map<string, NostrEvent>();
  const perRelay = replies.map((r) => ({ url: r.url, ok: r.ok, events: r.got.filter(isObjectWithId) as NostrEvent[] }));
  for (const r of perRelay) for (const e of r.events) seen.set(JSON.stringify(e), e);
  return { events: [...seen.values()], reachable: replies.filter((r) => r.ok).length, perRelay };
}

const isObjectWithId = (e: unknown) => !!e && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string';
