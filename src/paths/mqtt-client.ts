/**
 * A minimal MQTT 3.1.1 client over WebSocket: CONNECT, SUBSCRIBE (QoS 0), PUBLISH (QoS 0, accepts
 * incoming QoS 1), PINGREQ keepalive, DISCONNECT. Enough for a datagram relay; no persistence, no
 * retained messages, no wills. Replaces a ~300 KB dependency with ~250 lines.
 */
import { concat, utf8, asBytes } from '../util/bytes.js';
import { Emitter } from '../util/emitter.js';
import type { Clock } from '../util/timers.js';
import { WS_OPEN, type WsFactory, type WsLike } from '../nostr/socket.js';

export enum PacketType {
  Connect = 1,
  Connack = 2,
  Publish = 3,
  Puback = 4,
  Subscribe = 8,
  Suback = 9,
  Unsubscribe = 10,
  Unsuback = 11,
  Pingreq = 12,
  Pingresp = 13,
  Disconnect = 14,
}

export interface Packet {
  type: number;
  flags: number;
  body: Uint8Array;
}

export function encodeLength(n: number): Uint8Array {
  const out: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0 && out.length < 4);
  return new Uint8Array(out);
}

export function packet(type: number, flags: number, body: Uint8Array = new Uint8Array()): Uint8Array {
  return concat(new Uint8Array([(type << 4) | (flags & 0x0f)]), encodeLength(body.length), body);
}

export const str = (s: string): Uint8Array => {
  const b = utf8(s);
  return concat(new Uint8Array([b.length >> 8, b.length & 0xff]), b);
};

export const u16 = (n: number) => new Uint8Array([(n >> 8) & 0xff, n & 0xff]);

/** Incremental parser: WebSocket messages may hold several packets or part of one. */
export class PacketReader {
  private buf = new Uint8Array(0);
  constructor(private maxPacket = 1 << 20) {}

  push(chunk: Uint8Array): Packet[] | null {
    this.buf = this.buf.length ? concat(this.buf, chunk) : chunk.slice();
    const out: Packet[] = [];
    for (;;) {
      if (this.buf.length < 2) break;
      let len = 0;
      let mul = 1;
      let i = 1;
      let complete = false;
      for (; i < 5 && i < this.buf.length; i++) {
        len += (this.buf[i] & 0x7f) * mul;
        mul *= 128;
        if (!(this.buf[i] & 0x80)) {
          complete = true;
          break;
        }
      }
      if (!complete) {
        if (i >= 5) return null; // malformed length
        break;
      }
      if (len > this.maxPacket) return null;
      const start = i + 1;
      if (this.buf.length < start + len) break;
      out.push({ type: this.buf[0] >> 4, flags: this.buf[0] & 0x0f, body: this.buf.slice(start, start + len) });
      this.buf = this.buf.subarray(start + len);
    }
    return out;
  }
}

export function readStr(body: Uint8Array, at: number): [string, number] | null {
  if (at + 2 > body.length) return null;
  const n = (body[at] << 8) | body[at + 1];
  if (at + 2 + n > body.length) return null;
  try {
    return [new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(at + 2, at + 2 + n)), at + 2 + n];
  } catch {
    return null;
  }
}

export interface MqttClientOptions {
  clientId: string;
  ws: WsFactory;
  clock: Clock;
  keepaliveS?: number;
  connectTimeoutMs?: number;
}

export interface MqttEvents {
  [event: string]: unknown[];
  connect: [];
  close: [reason: string];
  message: [topic: string, payload: Uint8Array];
}

export class MqttClient {
  readonly events = new Emitter<MqttEvents>();
  connected = false;
  private socket: WsLike | null = null;
  private reader = new PacketReader();
  private nextId = 1;
  private lastRx = 0;
  private timer: unknown = null;
  private connectTimer: unknown = null;
  private closed = false;
  private keepalive: number;

  constructor(
    readonly url: string,
    private o: MqttClientOptions,
  ) {
    this.keepalive = o.keepaliveS ?? 30;
    let ws: WsLike;
    try {
      ws = o.ws(url, 'mqtt');
    } catch (error) {
      queueMicrotask(() => this.fail(`socket: ${String(error)}`));
      return;
    }
    this.socket = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      const body = concat(str('MQTT'), new Uint8Array([4, 0x02]), u16(this.keepalive), str(o.clientId));
      this.write(packet(PacketType.Connect, 0, body));
    };
    ws.onmessage = (ev) => {
      const bytes = asBytes(ev.data);
      if (!bytes) return;
      const packets = this.reader.push(bytes);
      if (!packets) return this.fail('malformed packet');
      this.lastRx = o.clock.now();
      for (const p of packets) this.onPacket(p);
    };
    ws.onclose = () => this.fail('closed');
    ws.onerror = () => {};
    this.connectTimer = o.clock.setTimeout(() => {
      if (!this.connected) this.fail('connect timeout');
    }, o.connectTimeoutMs ?? 10_000);
  }

  private write(bytes: Uint8Array): boolean {
    if (!this.socket || this.socket.readyState !== WS_OPEN) return false;
    try {
      this.socket.send(bytes);
      return true;
    } catch {
      return false;
    }
  }

  private onPacket(p: Packet): void {
    switch (p.type) {
      case PacketType.Connack:
        if (p.body.length < 2 || p.body[1] !== 0) return this.fail(`refused (${p.body[1]})`);
        this.connected = true;
        if (this.connectTimer) this.o.clock.clearTimeout(this.connectTimer);
        this.timer = this.o.clock.setInterval(() => this.keep(), (this.keepalive * 1000) / 3);
        this.events.emit('connect');
        return;
      case PacketType.Publish: {
        const qos = (p.flags >> 1) & 3;
        const t = readStr(p.body, 0);
        if (!t) return;
        let at = t[1];
        if (qos > 0) {
          if (at + 2 > p.body.length) return;
          const id = (p.body[at] << 8) | p.body[at + 1];
          at += 2;
          if (qos === 1) this.write(packet(PacketType.Puback, 0, u16(id)));
        }
        this.events.emit('message', t[0], p.body.subarray(at));
        return;
      }
      case PacketType.Suback:
        if (p.body.length >= 3 && p.body[2] === 0x80) this.fail('subscription refused');
        return;
      default:
        return;
    }
  }

  private keep(): void {
    const now = this.o.clock.now();
    // no packet at all for 1.5 keepalives: the connection is dead even if the socket looks open
    if (now - this.lastRx > this.keepalive * 1500) return this.fail('keepalive timeout');
    this.write(packet(PacketType.Pingreq, 0));
  }

  subscribe(topics: string[]): void {
    const id = this.nextId++ & 0xffff || 1;
    const body = concat(u16(id), ...topics.map((t) => concat(str(t), new Uint8Array([0]))));
    this.write(packet(PacketType.Subscribe, 2, body));
  }

  publish(topic: string, payload: Uint8Array): boolean {
    if (!this.connected) return false;
    return this.write(packet(PacketType.Publish, 0, concat(str(topic), payload)));
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    if (this.timer) this.o.clock.clearInterval(this.timer);
    if (this.connectTimer) this.o.clock.clearTimeout(this.connectTimer);
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.events.emit('close', reason);
  }

  end(): void {
    if (this.closed) return;
    this.write(packet(PacketType.Disconnect, 0));
    this.fail('ended');
  }
}
