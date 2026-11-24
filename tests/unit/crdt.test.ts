import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ledger, lww, mapOf, max, object, pickMax, union, type Counters, type Ledger, type Merger } from '../../src/sync/crdt.js';
import { stableJson } from '../../src/util/stable-json.js';

function laws<T>(name: string, arb: fc.Arbitrary<T>, merge: Merger<T>) {
  const eq = (a: T, b: T): void => {
    expect(stableJson(a)).toBe(stableJson(b));
  };
  describe(`${name} is a join`, () => {
    it('commutative', () => fc.assert(fc.property(arb, arb, (a, b) => void eq(merge(a, b), merge(b, a)))));
    it('associative', () => fc.assert(fc.property(arb, arb, arb, (a, b, c) => void eq(merge(merge(a, b), c), merge(a, merge(b, c))))));
    it('idempotent', () => fc.assert(fc.property(arb, arb, (a, b) => void eq(merge(merge(a, b), b), merge(a, b)))));
  });
}

const counters: fc.Arbitrary<Counters> = fc.dictionary(
  fc.constantFrom('xp', 'wins', 'losses', 'cards', 'visits'),
  fc.oneof(fc.nat(1000), fc.dictionary(fc.constantFrom('a', 'b', 'c'), fc.nat(50), { maxKeys: 3 })),
  { maxKeys: 4 },
) as fc.Arbitrary<Counters>;
const ledgers: fc.Arbitrary<Ledger> = fc.dictionary(fc.constantFrom('d1', 'd2', 'd3', 'd4'), counters, { maxKeys: 4 });

laws('max', fc.integer(), max);
laws('union', fc.array(fc.oneof(fc.integer({ min: 0, max: 20 }), fc.string({ maxLength: 2 })), { maxLength: 6 }), union);
laws('lww', fc.record({ at: fc.integer({ min: 0, max: 5 }), value: fc.jsonValue() }), lww);
laws('pickMax', fc.jsonValue(), pickMax);
laws('mapOf(max)', fc.dictionary(fc.constantFrom('a', 'b', 'c', 'd'), fc.integer(), { maxKeys: 4 }), mapOf(max));
laws('ledger.merge', ledgers, ledger.merge);
laws(
  'object schema',
  fc.record({ best: fc.integer(), tags: fc.array(fc.constantFrom('x', 'y', 'z'), { maxLength: 3 }), extra: fc.jsonValue() }, { requiredKeys: [] }),
  object<Record<string, unknown>>({ best: max as Merger<unknown>, tags: union as Merger<unknown> }),
);

describe('ledger', () => {
  it('adds progress made offline on two devices, without double counting', () => {
    let l: Ledger = {};
    l = ledger.record(l, 'phone', { xp: 10, wins: 1 });
    const laptopView = ledger.record(l, 'laptop', { xp: 10 + 5, wins: 1 }); // laptop saw phone's 10, added 5
    const phoneView = ledger.record(l, 'phone', { xp: 10 + 7, wins: 2 }); // phone added 7 more offline
    const merged = ledger.merge(laptopView, phoneView);
    expect(ledger.total(merged)).toEqual({ wins: 2, xp: 22 });
    // syncing again changes nothing
    expect(ledger.merge(merged, merged)).toEqual(merged);
    expect(ledger.merge(merged, laptopView)).toEqual(merged);
  });

  it('never shrinks an own entry or goes negative', () => {
    let l: Ledger = { other: { xp: 50 } };
    l = ledger.record(l, 'me', { xp: 60 });
    expect(l.me).toEqual({ xp: 10 });
    l = ledger.record(l, 'me', { xp: 40 }); // totals capped lower than before
    expect(l.me).toEqual({ xp: 10 });
  });

  it('nested counters and contributions', () => {
    let l: Ledger = {};
    l = ledger.record(l, 'a', { cards: { fries: 2, cola: 1 } });
    l = ledger.record(l, 'b', { cards: { fries: 3, cola: 1 } });
    expect(ledger.total(l)).toEqual({ cards: { cola: 1, fries: 3 } });
    expect(ledger.of(l, ['b'])).toEqual({ cards: { fries: 1 } });
  });

  it('trims to the same devices everywhere', () => {
    const l: Ledger = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`d${i}`, { xp: i }]));
    const t = ledger.trim(l, 3);
    expect(Object.keys(t).sort()).toEqual(['d7', 'd8', 'd9']);
  });
});
