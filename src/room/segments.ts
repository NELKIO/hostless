/**
 * Segments: the plaintext inside a DATA frame, used by the reliability layer (link.ts).
 *
 *   data   0x10 | fromSid(8) | toSid(8) | seq u32 | ack u32 | flags u8 | payload
 *   ack    0x11 | fromSid | toSid | ack u32 | count u8 | missing u32 × count
 *   ping   0x12 | fromSid | toSid | t0 f64 | path u8
 *   pong   0x13 | fromSid | toSid | t0 f64 | path u8
 *   unrel  0x14 | fromSid | toSid | channel-free payload (one whole message)
 *   bye    0x15 | fromSid | toSid
 *
 * Session ids are 8 random bytes per page; `toSid` all zero means "your session, whatever it is"
 * (used before the peer's session is known).
 */
import { fromHex, toHex } from '../util/bytes.js';

export enum SegType {
  Data = 0x10,
  Ack = 0x11,
  Ping = 0x12,
  Pong = 0x13,
  Unreliable = 0x14,
  Bye = 0x15,
}

export const FLAG_FIRST = 1;
export const FLAG_LAST = 2;
export const FLAG_DEFLATED = 4;
export const SEG_HEADER = 1 + 8 + 8;
export const DATA_SEG_HEADER = SEG_HEADER + 4 + 4 + 1;
export const ANY_SID = '0000000000000000';
export const MAX_MISSING = 32;

export const PATH_CODES = ['direct', 'nostr', 'mqtt', 'broadcast', 'memory', 'other'] as const;
export type PathCode = (typeof PATH_CODES)[number];
export const pathCode = (kind: string): number => {
  const i = PATH_CODES.indexOf(kind as PathCode);
  return i < 0 ? PATH_CODES.length - 1 : i;
};

export type Segment =
  | { t: SegType.Data; fs: string; ts: string; seq: number; ack: number; flags: number; payload: Uint8Array }
  | { t: SegType.Ack; fs: string; ts: string; ack: number; missing: number[] }
  | { t: SegType.Ping | SegType.Pong; fs: string; ts: string; t0: number; path: number }
  | { t: SegType.Unreliable; fs: string; ts: string; payload: Uint8Array }
  | { t: SegType.Bye; fs: string; ts: string };

function header(size: number, type: SegType, fs: string, ts: string): { out: Uint8Array; view: DataView } {
  const out = new Uint8Array(size);
  out[0] = type;
  out.set(fromHex(fs), 1);
  out.set(fromHex(ts), 9);
  return { out, view: new DataView(out.buffer) };
}

export function encodeSegment(seg: Segment): Uint8Array {
  switch (seg.t) {
    case SegType.Data: {
      const { out, view } = header(DATA_SEG_HEADER + seg.payload.length, seg.t, seg.fs, seg.ts);
      view.setUint32(17, seg.seq);
      view.setUint32(21, seg.ack);
      out[25] = seg.flags;
      out.set(seg.payload, DATA_SEG_HEADER);
      return out;
    }
    case SegType.Ack: {
      const missing = seg.missing.slice(0, MAX_MISSING);
      const { out, view } = header(SEG_HEADER + 5 + missing.length * 4, seg.t, seg.fs, seg.ts);
      view.setUint32(17, seg.ack);
      out[21] = missing.length;
      missing.forEach((m, i) => view.setUint32(22 + i * 4, m));
      return out;
    }
    case SegType.Ping:
    case SegType.Pong: {
      const { out, view } = header(SEG_HEADER + 9, seg.t, seg.fs, seg.ts);
      view.setFloat64(17, seg.t0);
      out[25] = seg.path;
      return out;
    }
    case SegType.Unreliable: {
      const { out } = header(SEG_HEADER + seg.payload.length, seg.t, seg.fs, seg.ts);
      out.set(seg.payload, SEG_HEADER);
      return out;
    }
    case SegType.Bye:
      return header(SEG_HEADER, seg.t, seg.fs, seg.ts).out;
  }
}

export function decodeSegment(bytes: Uint8Array): Segment | null {
  if (bytes.length < SEG_HEADER) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fs = toHex(bytes.subarray(1, 9));
  const ts = toHex(bytes.subarray(9, 17));
  switch (bytes[0]) {
    case SegType.Data:
      if (bytes.length < DATA_SEG_HEADER) return null;
      return { t: SegType.Data, fs, ts, seq: view.getUint32(17), ack: view.getUint32(21), flags: bytes[25], payload: bytes.subarray(DATA_SEG_HEADER) };
    case SegType.Ack: {
      if (bytes.length < SEG_HEADER + 5) return null;
      const count = bytes[21];
      if (count > MAX_MISSING || bytes.length !== SEG_HEADER + 5 + count * 4) return null;
      const missing: number[] = [];
      for (let i = 0; i < count; i++) missing.push(view.getUint32(22 + i * 4));
      return { t: SegType.Ack, fs, ts, ack: view.getUint32(17), missing };
    }
    case SegType.Ping:
    case SegType.Pong:
      if (bytes.length !== SEG_HEADER + 9) return null;
      return { t: bytes[0] as SegType.Ping | SegType.Pong, fs, ts, t0: view.getFloat64(17), path: bytes[25] };
    case SegType.Unreliable:
      return { t: SegType.Unreliable, fs, ts, payload: bytes.subarray(SEG_HEADER) };
    case SegType.Bye:
      return bytes.length === SEG_HEADER ? { t: SegType.Bye, fs, ts } : null;
    default:
      return null;
  }
}
