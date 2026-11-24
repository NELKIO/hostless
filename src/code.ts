import { randomBytes, type RandomBytes } from './util/bytes.js';

/**
 * Room codes and sync keys: 32 symbols without look-alikes (no I, O, 0, 1), 5 bits each.
 * A 10-symbol room code carries 50 bits; a 32-symbol sync key 160 bits.
 */
export const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 10;
export const SYNC_KEY_LENGTH = 32;

export function randomCode(length: number, random: RandomBytes = randomBytes): string {
  return [...random(length)].map((byte) => ALPHABET[byte & 31]).join('');
}

export const newRoomCode = (length = ROOM_CODE_LENGTH, random?: RandomBytes): string => randomCode(length, random);
export const newSyncKey = (random?: RandomBytes): string => randomCode(SYNC_KEY_LENGTH, random);

export interface ParseOptions {
  /** exact length expected (default: room codes 10, sync keys 32) */
  length?: number;
  /** link parameter that may carry the code, as in `#room=CODE` or `?room=CODE` */
  param?: string;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A code from user input: the bare code (any case, spaces and dashes ignored) or a link that
 * carries it as `param=CODE` in its fragment or query. null when it is not a valid code.
 */
export function parseCode(value: unknown, { length = ROOM_CODE_LENGTH, param = 'room' }: ParseOptions = {}): string | null {
  const text = String(value ?? '').trim();
  if (!text || text.length > 4096) return null;
  const match = new RegExp(`(?:^|[#?&])${escape(param)}=([^&#\\s]+)`, 'i').exec(text);
  let raw = match ? match[1] : text;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* keep as is */
  }
  const code = raw.replace(/[\s-]/g, '').toUpperCase();
  if (code.length !== length) return null;
  for (const symbol of code) if (!ALPHABET.includes(symbol)) return null;
  return code;
}

export const parseRoomCode = (value: unknown, options: ParseOptions = {}) => parseCode(value, { param: 'room', ...options });
export const parseSyncKey = (value: unknown, options: ParseOptions = {}) =>
  parseCode(value, { param: 'sync', length: SYNC_KEY_LENGTH, ...options });

/** `ABCDE-FGHJK` style grouping for display. */
export function formatCode(code: string, group = 5): string {
  return code.match(new RegExp(`.{1,${group}}`, 'g'))?.join('-') ?? code;
}

export const formatSyncKey = (key: string) => formatCode(key, 4);

/**
 * A shareable link: `base` without its fragment plus `#param=code`. The code lives in the fragment,
 * so it is never sent to the web server hosting the page.
 */
export function inviteLink(code: string, { param = 'room', base }: { param?: string; base?: string } = {}): string {
  const href = base ?? globalThis.location?.href ?? '';
  const clean = href.split('#')[0];
  return `${clean}#${param}=${code}`;
}

/** Remove `param=…` from the current URL fragment (after the code was read), keeping history clean. */
export function consumeLinkParam(param = 'room'): void {
  try {
    const loc = globalThis.location;
    if (!loc?.hash) return;
    const rest = loc.hash
      .slice(1)
      .split('&')
      .filter((part) => part && !part.toLowerCase().startsWith(param.toLowerCase() + '='));
    const url = loc.pathname + loc.search + (rest.length ? '#' + rest.join('&') : '');
    globalThis.history?.replaceState?.(globalThis.history.state, '', url);
  } catch {
    /* sandboxed */
  }
}
