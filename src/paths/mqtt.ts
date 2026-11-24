/**
 * A relay path over public MQTT brokers (MQTT 3.1.1 over secure WebSocket). Brokers are a different
 * kind of infrastructure than Nostr relays (big hosted services, port 8084/8884/8081), so the two
 * relay families rarely fail together.
 *
 * Topics: `hostless/1/<room topic>` for room-wide frames and `hostless/1/<peer topic>` for each
 * peer, both derived from the room's public topic. Payloads are the already-encrypted frames.
 * The path connects to every broker, subscribes on each, publishes each frame on `fanout` brokers in
 * rotation, and reconnects with backoff. Ported in spirit from influence-web `mqttRelay.ts`, but as a
 * datagram path (ordering and reliability are the link layer's job).
 */
import { Emitter } from '../util/emitter.js';
import { backoff } from '../util/backoff.js';
import { randomHex } from '../util/bytes.js';
import { netlog } from '../util/log.js';
import { defaultWsFactory, type WsFactory } from '../nostr/socket.js';
import { subTopic } from '../room/secrets.js';
import type { PeerId } from '../identity.js';
import type { Path, PathContext, PathEvents, PathFactory } from './types.js';
import { MqttClient } from './mqtt-client.js';
import { DEFAULT_MQTT_BROKERS } from './defaults.js';

export interface MqttPathOptions {
  brokers?: readonly string[];
  name?: string;
  fanout?: number;
  maxFrame?: number;
  keepaliveS?: number;
  connectTimeoutMs?: number;
  ws?: WsFactory;
}

interface BrokerConn {
  url: string;
  client: MqttClient | null;
  up: boolean;
  fails: number;
  timer: unknown;
  everUp: boolean;
  lastError: string | null;
  sent: number;
}

export class MqttPath implements Path {
  readonly kind = 'mqtt' as const;
  readonly direct = false;
  readonly name: string;
  readonly maxFrame: number;
  readonly events = new Emitter<PathEvents>();
  private conns: BrokerConn[];
  private roomTopic: string;
  private myTopic: string;
  private peerTopics = new Map<PeerId, string>();
  private closed = false;
  private wasUp = false;
  private turn = 0;
  private ws: WsFactory;
  private fanout: number;
  private failTimer: unknown;

  constructor(
    private ctx: PathContext,
    private o: MqttPathOptions = {},
  ) {
    this.name = o.name ?? 'mqtt';
    this.maxFrame = o.maxFrame ?? 8192;
    this.ws = o.ws ?? defaultWsFactory;
    this.fanout = Math.max(1, o.fanout ?? 2);
    this.roomTopic = `hostless/1/${subTopic(ctx.secrets.topic, 'mqtt-room')}`;
    this.myTopic = this.topicOf(ctx.self);
    this.conns = [...new Set(o.brokers ?? DEFAULT_MQTT_BROKERS)].map((url) => ({ url, client: null, up: false, fails: 0, timer: null, everUp: false, lastError: null, sent: 0 }));
    for (const c of this.conns) this.connect(c);
    this.failTimer = ctx.clock.setTimeout(() => {
      if (!this.closed && !this.conns.some((c) => c.everUp)) this.events.emit('error', 'unreachable', 'no MQTT broker is reachable');
    }, o.connectTimeoutMs ?? 12_000);
  }

  private topicOf(peer: PeerId): string {
    let t = this.peerTopics.get(peer);
    if (!t) this.peerTopics.set(peer, (t = `hostless/1/${subTopic(this.ctx.secrets.topic, `mqtt-peer:${peer}`)}`));
    return t;
  }

  get up(): boolean {
    return this.conns.some((c) => c.up);
  }

  reachable(): boolean {
    return this.up;
  }

  bind(): void {}

  status(): Record<string, unknown> {
    return { brokers: this.conns.map((c) => ({ url: c.url, up: c.up, error: c.lastError, sent: c.sent })) };
  }

  private connect(c: BrokerConn): void {
    if (this.closed) return;
    const client = new MqttClient(c.url, {
      clientId: `hl${randomHex(8, this.ctx.random)}`,
      ws: this.ws,
      clock: this.ctx.clock,
      keepaliveS: this.o.keepaliveS ?? 30,
      connectTimeoutMs: this.o.connectTimeoutMs ?? 10_000,
    });
    c.client = client;
    client.events.on('connect', () => {
      if (c.client !== client) return;
      client.subscribe([this.roomTopic, this.myTopic]);
      c.up = true;
      c.everUp = true;
      c.fails = 0;
      c.lastError = null;
      this.changed();
    });
    client.events.on('message', (topic, payload) => {
      if (c.client !== client || (topic !== this.roomTopic && topic !== this.myTopic)) return;
      if (payload.length > this.maxFrame) return;
      this.events.emit('frame', payload.slice(), null);
    });
    client.events.on('close', (reason) => {
      if (c.client !== client) return;
      netlog('mqtt-close', { broker: c.url, reason });
      c.client = null;
      c.up = false;
      c.lastError = reason;
      this.changed();
      if (this.closed) return;
      c.timer = this.ctx.clock.setTimeout(() => {
        c.timer = null;
        this.connect(c);
      }, backoff(c.fails++));
    });
  }

  private changed(): void {
    const up = this.up;
    if (up === this.wasUp) return;
    this.wasUp = up;
    this.events.emit(up ? 'up' : 'down');
  }

  send(to: PeerId | null, frame: Uint8Array): boolean {
    if (this.closed) return false;
    if (frame.length > this.maxFrame) throw new Error(`mqtt path: frame ${frame.length} > ${this.maxFrame}`);
    const live = this.conns.filter((c) => c.up && c.client);
    if (!live.length) return false;
    const topic = to === null ? this.roomTopic : this.topicOf(to);
    const n = Math.min(live.length, this.fanout);
    let ok = false;
    for (let i = 0; i < n; i++) {
      const c = live[(this.turn + i) % live.length];
      c.sent++;
      ok = c.client!.publish(topic, frame) || ok;
    }
    this.turn = (this.turn + n) % live.length;
    return ok;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ctx.clock.clearTimeout(this.failTimer);
    for (const c of this.conns) {
      if (c.timer) this.ctx.clock.clearTimeout(c.timer);
      c.client?.end();
      c.client = null;
      c.up = false;
    }
    this.events.emit('down');
  }
}

export function mqttPath(options: MqttPathOptions = {}): PathFactory {
  return (ctx) => new MqttPath(ctx, options);
}
