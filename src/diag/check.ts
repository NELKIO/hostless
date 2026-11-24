/**
 * A connection check for a settings page or a bug report: which relays and brokers this network
 * reaches (with an echo through each), and whether direct WebRTC is likely (NAT type via STUN).
 * Ported in spirit from influence-web `connCheck.ts`.
 */
import { generateSecret } from '../crypto/schnorr.js';
import { randomHex, toHex } from '../util/bytes.js';
import { signEvent } from '../nostr/event.js';
import { defaultWsFactory, type WsFactory, type WsLike } from '../nostr/socket.js';
import { MqttClient } from '../paths/mqtt-client.js';
import { realClock } from '../util/timers.js';
import { DEFAULT_MQTT_BROKERS, DEFAULT_NOSTR_RELAYS, DEFAULT_STUN } from '../paths/defaults.js';

export interface EndpointResult {
  url: string;
  ok: boolean;
  /** socket open time, ms */
  connectMs: number | null;
  /** a message sent through it came back after, ms */
  echoMs: number | null;
  error: string | null;
}

export type NatType = 'open' | 'cone' | 'symmetric' | 'blocked' | 'unknown';

export interface NetworkReport {
  nostr: EndpointResult[];
  mqtt: EndpointResult[];
  webrtc: { available: boolean; nat: NatType; candidates: string[] };
  /** a one-line verdict */
  summary: { relays: number; direct: 'likely' | 'unlikely' | 'unknown'; ok: boolean };
}

export interface CheckOptions {
  nostr?: readonly string[];
  mqtt?: readonly string[];
  stun?: readonly string[];
  ws?: WsFactory;
  timeoutMs?: number;
  /** a RTCPeerConnection constructor (default the global one) */
  rtc?: typeof RTCPeerConnection | null;
}

const elapsed = (t0: number) => Math.round(performance.now() - t0);

export function checkNostrRelay(url: string, ws: WsFactory = defaultWsFactory, timeoutMs = 8000): Promise<EndpointResult> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const res: EndpointResult = { url, ok: false, connectMs: null, echoMs: null, error: null };
    let socket: WsLike | null = null;
    let finished = false;
    const done = (error: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      res.error = error;
      res.ok = error === null;
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      resolve(res);
    };
    const timer = setTimeout(() => done(res.connectMs === null ? 'no connection' : 'no echo'), timeoutMs);
    const topic = randomHex(16);
    const sub = `hlcheck${randomHex(4)}`;
    let sentAt = 0;
    try {
      socket = ws(url);
    } catch (e) {
      done(String(e));
      return;
    }
    socket.onopen = () => {
      res.connectMs = elapsed(t0);
      socket!.send(JSON.stringify(['REQ', sub, { kinds: [25050], '#t': [topic], limit: 0 }]));
      const ev = signEvent(generateSecret(), { kind: 25050, created_at: Math.floor(Date.now() / 1000), tags: [['t', topic]], content: 'hostless connection check' });
      sentAt = performance.now();
      // give the subscription a moment to register on the relay
      setTimeout(() => {
        try {
          socket!.send(JSON.stringify(['EVENT', ev]));
        } catch {
          /* closed */
        }
      }, 300);
    };
    socket.onmessage = ({ data }) => {
      let m: unknown;
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!Array.isArray(m)) return;
      if (m[0] === 'EVENT' && m[1] === sub) {
        res.echoMs = Math.max(0, elapsed(sentAt) - 300);
        done(null);
      } else if (m[0] === 'OK' && m[2] === false) done(`refused: ${String(m[3] ?? '')}`);
      else if (m[0] === 'CLOSED' && m[1] === sub) done(`subscription closed: ${String(m[2] ?? '')}`);
    };
    socket.onclose = () => done(res.connectMs === null ? 'connection failed' : 'closed');
    socket.onerror = () => {};
  });
}

export function checkMqttBroker(url: string, ws: WsFactory = defaultWsFactory, timeoutMs = 8000): Promise<EndpointResult> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const res: EndpointResult = { url, ok: false, connectMs: null, echoMs: null, error: null };
    const client = new MqttClient(url, { clientId: `hlcheck${randomHex(6)}`, ws, clock: realClock, connectTimeoutMs: timeoutMs });
    const topic = `hostless/check/${randomHex(8)}`;
    let sentAt = 0;
    let finished = false;
    const done = (error: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      res.error = error;
      res.ok = error === null;
      client.end();
      resolve(res);
    };
    const timer = setTimeout(() => done(res.connectMs === null ? 'no connection' : 'no echo'), timeoutMs);
    client.events.on('connect', () => {
      res.connectMs = elapsed(t0);
      client.subscribe([topic]);
      setTimeout(() => {
        sentAt = performance.now();
        client.publish(topic, new Uint8Array([1, 2, 3]));
      }, 300);
    });
    client.events.on('message', (t) => {
      if (t !== topic) return;
      res.echoMs = elapsed(sentAt);
      done(null);
    });
    client.events.on('close', (reason) => done(reason));
  });
}

/** Classify the NAT from server-reflexive candidates gathered against several STUN servers. */
export function classifyNat(candidates: string[]): NatType {
  const srflx = candidates.filter((c) => / typ srflx( |$)/.test(c));
  const host = candidates.filter((c) => / typ host( |$)/.test(c));
  if (!candidates.length) return 'blocked';
  if (!srflx.length) return host.length ? 'unknown' : 'blocked';
  // "candidate:… 1 udp 1677729535 203.0.113.7 54321 typ srflx raddr 192.168.1.2 rport 50000"
  const mapped = srflx.map((c) => {
    const parts = c.split(' ');
    return { ip: parts[4], port: parts[5], rport: c.match(/ rport (\d+)/)?.[1] };
  });
  if (mapped.some((m) => host.some((h) => h.split(' ')[4] === m.ip))) return 'open';
  // the same local port mapped to different public ports for different servers: symmetric NAT
  const byLocal = new Map<string, Set<string>>();
  for (const m of mapped) {
    const k = m.rport ?? '?';
    if (!byLocal.has(k)) byLocal.set(k, new Set());
    byLocal.get(k)!.add(`${m.ip}:${m.port}`);
  }
  if ([...byLocal.values()].some((s) => s.size > 1)) return 'symmetric';
  return mapped.length > 1 ? 'cone' : 'unknown';
}

export function gatherCandidates(stun: readonly string[], rtc: typeof RTCPeerConnection, timeoutMs = 5000): Promise<string[]> {
  // ONE connection with every STUN server: the same local socket is reported by each server, so a
  // NAT that maps it to a different public port per destination (symmetric) shows up
  return new Promise((resolve) => {
    const out: string[] = [];
    let pc: RTCPeerConnection;
    try {
      pc = new rtc({ iceServers: stun.map((urls) => ({ urls })) });
    } catch {
      resolve(out);
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      try {
        pc.close();
      } catch {
        /* ignore */
      }
      resolve(out);
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.onicecandidate = (e) => {
      if (!e.candidate) return finish();
      if (e.candidate.candidate) out.push(e.candidate.candidate);
    };
    pc.createDataChannel('probe');
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .catch(finish);
  });
}

export async function checkNetwork(o: CheckOptions = {}): Promise<NetworkReport> {
  const ws = o.ws ?? defaultWsFactory;
  const timeoutMs = o.timeoutMs ?? 8000;
  const rtc = o.rtc === undefined ? ((globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection ?? null) : o.rtc;
  const [nostr, mqtt, candidates] = await Promise.all([
    Promise.all((o.nostr ?? DEFAULT_NOSTR_RELAYS).map((u) => checkNostrRelay(u, ws, timeoutMs))),
    Promise.all((o.mqtt ?? DEFAULT_MQTT_BROKERS).map((u) => checkMqttBroker(u, ws, timeoutMs))),
    rtc ? gatherCandidates(o.stun ?? DEFAULT_STUN, rtc, Math.min(timeoutMs, 6000)).catch(() => []) : Promise.resolve([] as string[]),
  ]);
  const nat = rtc ? classifyNat(candidates) : 'unknown';
  const relays = nostr.filter((r) => r.ok).length + mqtt.filter((r) => r.ok).length;
  const direct = !rtc ? 'unlikely' : nat === 'open' || nat === 'cone' ? 'likely' : nat === 'symmetric' || nat === 'blocked' ? 'unlikely' : 'unknown';
  return { nostr, mqtt, webrtc: { available: !!rtc, nat, candidates }, summary: { relays, direct, ok: relays > 0 || direct === 'likely' } };
}

export { toHex };
