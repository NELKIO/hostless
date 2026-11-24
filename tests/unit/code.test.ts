import { describe, expect, it } from 'vitest';
import { ALPHABET, formatCode, formatSyncKey, inviteLink, newRoomCode, newSyncKey, parseRoomCode, parseSyncKey } from '../../src/code.js';
import { ManualClock } from '../../src/util/timers.js';
import { Emitter } from '../../src/util/emitter.js';
import { backoff, BoundedSet } from '../../src/util/backoff.js';

describe('room codes', () => {
  it('generates codes from the alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const code = newRoomCode();
      expect(code).toHaveLength(10);
      expect([...code].every((c) => ALPHABET.includes(c))).toBe(true);
    }
    expect(newRoomCode(6)).toHaveLength(6);
  });

  it('parses bare codes, formatted codes and links', () => {
    const code = 'ABCDEFGHJK';
    expect(parseRoomCode(code)).toBe(code);
    expect(parseRoomCode('abcde-fghjk')).toBe(code);
    expect(parseRoomCode(' ab cde fghjk ')).toBe(code);
    expect(parseRoomCode(`https://x.github.io/game/#room=${code}`)).toBe(code);
    expect(parseRoomCode(`https://x.github.io/game/?lang=ru#foo=1&room=${code.toLowerCase()}`)).toBe(code);
    expect(parseRoomCode(`https://x.github.io/?room=${code}`)).toBe(code);
    expect(parseRoomCode(`#duel=${code}`, { param: 'duel' })).toBe(code);
    expect(parseRoomCode(formatCode(code))).toBe(code);
  });

  it('rejects wrong length or look-alike symbols', () => {
    expect(parseRoomCode('ABCDEFGHJ')).toBeNull();
    expect(parseRoomCode('ABCDEFGHJI')).toBeNull();
    expect(parseRoomCode('ABCDEFGHJ0')).toBeNull();
    expect(parseRoomCode('')).toBeNull();
    expect(parseRoomCode(null)).toBeNull();
    expect(parseRoomCode('x'.repeat(5000))).toBeNull();
  });

  it('sync keys', () => {
    const key = newSyncKey();
    expect(key).toHaveLength(32);
    expect(parseSyncKey(formatSyncKey(key))).toBe(key);
    expect(parseSyncKey(`https://a.b/#sync=${key}`)).toBe(key);
    expect(parseSyncKey(key.slice(1))).toBeNull();
  });

  it('builds invite links in the fragment', () => {
    expect(inviteLink('ABCDEFGHJK', { base: 'https://a.b/game/?x=1#old' })).toBe('https://a.b/game/?x=1#room=ABCDEFGHJK');
    expect(inviteLink('K', { base: 'https://a.b/', param: 'duel' })).toBe('https://a.b/#duel=K');
  });
});

describe('utilities', () => {
  it('manual clock fires timers in order', () => {
    const clock = new ManualClock(0);
    const seen: string[] = [];
    clock.setTimeout(() => seen.push('b'), 20);
    clock.setTimeout(() => seen.push('a'), 10);
    const every = clock.setInterval(() => seen.push('i'), 15);
    clock.advance(31);
    expect(seen).toEqual(['a', 'i', 'b', 'i']);
    clock.clearInterval(every);
    clock.advance(100);
    expect(seen).toHaveLength(4);
    expect(clock.now()).toBe(131);
  });

  it('emitter isolates throwing listeners', () => {
    const em = new Emitter<{ x: [number] }>();
    const got: number[] = [];
    em.on('x', () => {
      throw new Error('boom');
    });
    em.on('x', (n) => got.push(n));
    const original = console.error;
    console.error = () => {};
    try {
      em.emit('x', 1);
    } finally {
      console.error = original;
    }
    expect(got).toEqual([1]);
  });

  it('backoff grows and caps', () => {
    const fixed = () => 0.5;
    expect(backoff(0, 1000, 8000, fixed)).toBe(1000);
    expect(backoff(2, 1000, 8000, fixed)).toBe(4000);
    expect(backoff(10, 1000, 8000, fixed)).toBe(8000);
  });

  it('bounded set forgets the oldest', () => {
    const set = new BoundedSet<number>(2);
    expect(set.add(1)).toBe(true);
    expect(set.add(1)).toBe(false);
    set.add(2);
    set.add(3);
    expect(set.has(1)).toBe(false);
    expect(set.has(3)).toBe(true);
  });
});
