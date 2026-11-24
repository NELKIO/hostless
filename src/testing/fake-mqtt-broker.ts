/**
 * In-memory MQTT 3.1.1 brokers for tests (CONNECT, SUBSCRIBE with exact topics and +/# wildcards,
 * PUBLISH QoS 0/1, PING, DISCONNECT), reachable through an injected WebSocket factory.
 */
import { realClock, type Clock } from '../util/timers.js';
import { asBytes, concat } from '../util/bytes.js';
import { WS_OPEN, type WsFactory, type WsLike } from '../nostr/socket.js';
import { packet, PacketReader, PacketType, readStr, str, u16 } from '../paths/mqtt-client.js';

export interface BrokerBehaviour {
  down?: boolean;
  /** CONNACK with this return code (e.g. 5 = not authorized) */
  refuseCode?: number;
  /** freeze each connection after this many bytes */
  freezeAfterBytes?: number | null;
  latency?: number;
  /** never answer PINGREQ (half-dead broker) */
  ignorePings?: boolean;
}

export function topicMatches(filter: string, topic: string): boolean {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

class BrokerConnection {
  subs = new Set<string>();
  bytes = 0;
  frozen = false;
  closed = false;
  connected = false;
  reader = new PacketReader();
  constructor(
    readonly broker: FakeMqttBroker,
    readonly socket: FakeMqttSocket,
  ) {}

  account(n: number): boolean {
    if (this.frozen) return false;
    this.bytes += n;
    const limit = this.broker.behaviour.freezeAfterBytes;
    if (limit && this.bytes > limit) {
      this.frozen = true;
      return false;
    }
    return true;
  }

  push(bytes: Uint8Array): void {
    if (this.closed || !this.account(bytes.length)) return;
    this.socket.deliverFromServer(bytes, this.broker.behaviour.latency ?? 2);
  }
}

export class FakeMqttBroker {
  behaviour: BrokerBehaviour;
  readonly connections = new Set<BrokerConnection>();
  readonly stats = { connects: 0, publishes: 0, delivered: 0 };

  constructor(
    readonly url: string,
    behaviour: BrokerBehaviour = {},
    readonly clock: Clock = realClock,
  ) {
    this.behaviour = behaviour;
  }

  attach(socket: FakeMqttSocket): BrokerConnection | null {
    if (this.behaviour.down) return null;
    const c = new BrokerConnection(this, socket);
    this.connections.add(c);
    return c;
  }

  receive(conn: BrokerConnection, bytes: Uint8Array): void {
    if (!conn.account(bytes.length)) return;
    const packets = conn.reader.push(bytes);
    if (!packets) return conn.socket.serverClose();
    for (const p of packets) {
      switch (p.type) {
        case PacketType.Connect: {
          this.stats.connects++;
          const code = this.behaviour.refuseCode ?? 0;
          conn.push(packet(PacketType.Connack, 0, new Uint8Array([0, code])));
          if (code) conn.socket.serverClose();
          else conn.connected = true;
          break;
        }
        case PacketType.Subscribe: {
          const id = p.body.subarray(0, 2);
          let at = 2;
          const codes: number[] = [];
          while (at < p.body.length) {
            const t = readStr(p.body, at);
            if (!t) break;
            conn.subs.add(t[0]);
            at = t[1] + 1;
            codes.push(0);
          }
          conn.push(packet(PacketType.Suback, 0, concat(id, new Uint8Array(codes))));
          break;
        }
        case PacketType.Publish: {
          if (!conn.connected) break;
          this.stats.publishes++;
          const qos = (p.flags >> 1) & 3;
          const t = readStr(p.body, 0);
          if (!t) break;
          let at = t[1];
          if (qos > 0) {
            conn.push(packet(PacketType.Puback, 0, p.body.subarray(at, at + 2)));
            at += 2;
          }
          const payload = p.body.subarray(at);
          for (const other of this.connections) {
            if (![...other.subs].some((f) => topicMatches(f, t[0]))) continue;
            this.stats.delivered++;
            other.push(packet(PacketType.Publish, 0, concat(str(t[0]), payload)));
          }
          break;
        }
        case PacketType.Pingreq:
          if (!this.behaviour.ignorePings) conn.push(packet(PacketType.Pingresp, 0));
          break;
        case PacketType.Disconnect:
          conn.socket.serverClose();
          break;
        default:
          break;
      }
    }
  }

  dropConnections(): void {
    for (const c of this.connections) c.socket.serverClose();
    this.connections.clear();
  }
}

export class FakeMqttSocket implements WsLike {
  readyState = 0;
  binaryType = 'arraybuffer';
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  private conn: BrokerConnection | null = null;

  constructor(
    readonly url: string,
    private broker: FakeMqttBroker | undefined,
    private clock: Clock,
  ) {
    clock.setTimeout(() => {
      if (this.readyState === 3) return;
      this.conn = broker?.attach(this) ?? null;
      if (!this.conn) {
        this.readyState = 3;
        this.onerror?.({});
        this.onclose?.({});
        return;
      }
      this.readyState = WS_OPEN;
      this.onopen?.({});
    }, broker?.behaviour.latency ?? 2);
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== WS_OPEN) throw new Error('socket not open');
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : (asBytes(data) as Uint8Array).slice();
    const conn = this.conn!;
    this.clock.setTimeout(() => {
      if (!conn.closed) conn.broker.receive(conn, bytes);
    }, this.broker?.behaviour.latency ?? 2);
  }

  deliverFromServer(bytes: Uint8Array, latency: number): void {
    this.clock.setTimeout(() => {
      if (this.readyState === WS_OPEN) this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    }, latency);
  }

  serverClose(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.conn) {
      this.conn.closed = true;
      this.conn.broker.connections.delete(this.conn);
    }
    this.clock.setTimeout(() => this.onclose?.({}), 0);
  }

  close(): void {
    this.serverClose();
  }
}

export class FakeMqttNetwork {
  readonly brokers = new Map<string, FakeMqttBroker>();
  constructor(readonly clock: Clock = realClock) {}
  add(url: string, behaviour: BrokerBehaviour = {}): FakeMqttBroker {
    const b = new FakeMqttBroker(url, behaviour, this.clock);
    this.brokers.set(url, b);
    return b;
  }
  get(url: string): FakeMqttBroker {
    const b = this.brokers.get(url);
    if (!b) throw new Error(`no fake broker ${url}`);
    return b;
  }
  get urls(): string[] {
    return [...this.brokers.keys()];
  }
  readonly ws: WsFactory = (url) => new FakeMqttSocket(url, this.brokers.get(url), this.clock);
}

export { u16 };
