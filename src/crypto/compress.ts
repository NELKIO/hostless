import { deflateSync, Inflate } from 'fflate';

/** Raw DEFLATE, synchronous. */
export function deflate(bytes: Uint8Array, level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6): Uint8Array {
  return deflateSync(bytes, { level });
}

/**
 * Raw INFLATE with an output cap: a compressed bomb from a peer can not exhaust memory.
 * null when the data is malformed, truncated, or would exceed `maxBytes`.
 */
export function inflate(bytes: Uint8Array, maxBytes: number): Uint8Array | null {
  const parts: Uint8Array[] = [];
  let size = 0;
  let over = false;
  let ended = false;
  const stream = new Inflate((chunk, final) => {
    size += chunk.length;
    if (size > maxBytes) {
      over = true;
      throw new Error('inflate: too large');
    }
    parts.push(chunk);
    if (final) ended = true;
  });
  try {
    // Feed in slices so the cap is enforced long before a bomb is fully expanded.
    const step = 16_384;
    for (let at = 0; at < bytes.length; at += step) {
      const end = Math.min(bytes.length, at + step);
      stream.push(bytes.subarray(at, end), end === bytes.length);
      if (over) return null;
    }
    if (!bytes.length) return null;
  } catch {
    return null;
  }
  if (over || !ended) return null;
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
