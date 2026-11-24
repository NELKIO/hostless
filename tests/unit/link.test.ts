import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Link, type LinkOptions } from '../../src/room/link.js';
import { decodeSegment, SegType } from '../../src/room/segments.js';
import { ManualClock } from '../../src/util/timers.js';
import { seededRandom } from '../../src/testing/memory-network.js';

interface Chan {
  name: string;
  direct: boolean;
  latency: number;
  jitter: number;
  loss: number;
  dup: number;
  alive: boolean;
  /** delivers nothing but still counts as reachable (silent death) */
  silent: boolean;
  dataSegments: number;
  frames: number;
}

function harness(chans: Partial<Chan>[], seed = 1, opts: LinkOptions = {}) {
  const clock = new ManualClock(0);
  const rnd = seededRandom(seed);
  const paths: Chan[] = chans.map((c, i) => ({
    name: c.name ?? `p${i}`,
    direct: false,
    latency: 20,
    jitter: 0,
    loss: 0,
    dup: 0,
    alive: true,
    silent: false,
    dataSegments: 0,
    frames: 0,
    ...c,
  }));
  const got: { a: unknown[]; b: unknown[] } = { a: [], b: [] };
  const byes = { a: 0, b: 0 };
  const links: { a?: Link; b?: Link } = {};
  const make = (me: 'a' | 'b', other: 'a' | 'b') =>
    new Link(me === 'a' ? 'aaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbb', other === 'a' ? 'aaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbb', {
      paths: () => paths.filter((p) => p.alive).map((p) => ({ name: p.name, direct: p.direct })),
      send: (name, seg) => {
        const p = paths.find((x) => x.name === name)!;
        if (!p.alive) return false;
        p.frames++;
        if (decodeSegment(seg)?.t === SegType.Data) p.dataSegments++;
        if (p.silent || rnd() < p.loss) return true;
        const copies = rnd() < p.dup ? 2 : 1;
        for (let i = 0; i < copies; i++) {
          const copy = seg.slice();
          clock.setTimeout(() => {
            if (p.alive && !p.silent) links[other]!.receive(name, copy);
          }, p.latency + rnd() * p.jitter);
        }
        return true;
      },
      deliver: (v) => got[me].push(v),
      staleTarget: () => {},
      bye: () => byes[me]++,
    }, clock, opts);
  links.a = make('a', 'b');
  links.b = make('b', 'a');
  const ticker = clock.setInterval(() => {
    links.a!.tick();
    links.b!.tick();
  }, 100);
  return { clock, a: links.a, b: links.b, got, paths, byes, stop: () => clock.clearInterval(ticker) };
}

describe('link', () => {
  it('delivers in order over one path', () => {
    const h = harness([{ direct: true }]);
    h.a.pathUp('p0');
    h.b.pathUp('p0');
    for (let i = 0; i < 20; i++) h.a.send({ i });
    h.clock.advance(1000);
    expect(h.got.b).toEqual(Array.from({ length: 20 }, (_, i) => ({ i })));
    expect(h.a.idle).toBe(true);
  });

  it('delivers exactly once, in order, under loss, duplication and reordering', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1e6 }), fc.integer({ min: 1, max: 60 }), fc.double({ min: 0, max: 0.4, noNaN: true }), (seed, n, loss) => {
        const h = harness(
          [
            { name: 'd', direct: true, latency: 15, jitter: 40, loss, dup: 0.1 },
            { name: 'r1', latency: 120, jitter: 200, loss, dup: 0.2 },
            { name: 'r2', latency: 200, jitter: 300, loss, dup: 0.2 },
          ],
          seed,
        );
        for (const p of ['d', 'r1', 'r2']) {
          h.a.pathUp(p);
          h.b.pathUp(p);
        }
        const sent: number[] = [];
        for (let i = 0; i < n; i++) {
          h.clock.advance(Math.floor(seededRandom(seed + i)() * 50));
          h.a.send(i);
          h.b.send('b' + i);
          sent.push(i);
        }
        h.clock.advance(60_000);
        expect(h.got.b).toEqual(sent);
        expect(h.got.a).toEqual(sent.map((i) => 'b' + i));
      }),
      { numRuns: Number(process.env.FUZZ_RUNS ?? 40) },
    );
  });

  it('uses only the direct path while it is healthy', () => {
    const h = harness([
      { name: 'd', direct: true },
      { name: 'r', latency: 150 },
    ]);
    for (const l of [h.a, h.b]) {
      l.pathUp('d');
      l.pathUp('r');
    }
    h.clock.advance(500);
    for (let i = 0; i < 50; i++) {
      h.a.send({ i });
      h.clock.advance(100);
    }
    h.clock.advance(2000);
    expect(h.got.b).toHaveLength(50);
    expect(h.paths[1].dataSegments).toBe(0);
    expect(h.a.route()).toBe('direct');
  });

  it('moves to relays within about one timeout when the direct path dies silently', () => {
    const h = harness([
      { name: 'd', direct: true, latency: 10 },
      { name: 'r', latency: 150 },
    ]);
    for (const l of [h.a, h.b]) {
      l.pathUp('d');
      l.pathUp('r');
    }
    h.clock.advance(1000);
    h.a.send('before');
    h.clock.advance(200);
    h.paths[0].silent = true;
    h.a.send('after');
    const sentAt = h.clock.now();
    while (h.got.b.length < 2 && h.clock.now() - sentAt < 10_000) h.clock.advance(10);
    expect(h.got.b).toEqual(['before', 'after']);
    expect(h.clock.now() - sentAt).toBeLessThan(1500);
    // and the following messages go straight to the relay
    h.a.send('next');
    h.clock.advance(400);
    expect(h.got.b).toEqual(['before', 'after', 'next']);
    expect(h.a.route()).toBe('relay');
  });

  it('comes back to the direct path when it speaks again', () => {
    const h = harness([
      { name: 'd', direct: true, latency: 10 },
      { name: 'r', latency: 150 },
    ]);
    for (const l of [h.a, h.b]) {
      l.pathUp('d');
      l.pathUp('r');
    }
    h.clock.advance(500);
    h.paths[0].silent = true;
    h.a.send('x');
    h.clock.advance(6000);
    expect(h.a.route()).toBe('relay');
    h.paths[0].silent = false;
    h.clock.advance(3000);
    expect(h.a.route()).toBe('direct');
  });

  it('carries a large message over a small-frame relay, compressed and fragmented', () => {
    const h = harness([{ name: 'nostr', latency: 100, jitter: 150, loss: 0.1 }], 7, { segmentBytes: 2281 });
    h.a.pathUp('nostr');
    h.b.pathUp('nostr');
    const level = { cells: Array.from({ length: 20_000 }, (_, i) => ({ i, v: i % 7, tag: 'cell' })) };
    expect(JSON.stringify(level).length).toBeGreaterThan(300_000);
    expect(h.a.send(level)).toBe(true);
    h.clock.advance(120_000);
    expect(h.got.b).toEqual([level]);
    // compression kept it to far fewer segments than the raw size needs
    expect(h.paths[0].dataSegments).toBeLessThan(Math.ceil(JSON.stringify(level).length / 2281));
  });

  it('keeps relay bursts inside the send window', () => {
    const h = harness([{ name: 'r', latency: 300 }], 3, { segmentBytes: 200, windowRelay: 8, compressAbove: 1e9 });
    h.a.pathUp('r');
    h.b.pathUp('r');
    h.a.send('x'.repeat(200 * 40));
    h.clock.advance(1);
    expect(h.paths[0].dataSegments).toBe(8);
    h.clock.advance(30_000);
    expect(h.got.b).toEqual(['x'.repeat(200 * 40)]);
  });

  it('never retransmits everything at once after a timeout (congestion window)', () => {
    const h = harness([{ name: 'r', latency: 200 }], 5, { windowRelay: 24 });
    h.a.pathUp('r');
    h.b.pathUp('r');
    h.clock.advance(500);
    h.paths[0].silent = true;
    for (let i = 0; i < 100; i++) h.a.send(i);
    h.clock.advance(1);
    let last = h.paths[0].dataSegments;
    let worst = 0;
    for (let t = 0; t < 400; t++) {
      h.clock.advance(100);
      worst = Math.max(worst, h.paths[0].dataSegments - last);
      last = h.paths[0].dataSegments;
      if (t === 100) h.paths[0].silent = false;
    }
    expect(worst).toBeLessThanOrEqual(24);
    expect(h.got.b).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it('sends unreliable messages once on the best path', () => {
    const h = harness([{ name: 'd', direct: true, loss: 1 }]);
    h.a.pathUp('d');
    h.b.pathUp('d');
    h.a.send({ cursor: 1 }, false);
    h.clock.advance(5000);
    expect(h.got.b).toEqual([]);
    h.paths[0].loss = 0;
    h.a.send({ cursor: 2 }, false);
    h.clock.advance(100);
    expect(h.got.b).toEqual([{ cursor: 2 }]);
  });

  it('refuses when the queue is full instead of dropping silently', () => {
    const h = harness([{ name: 'r', alive: true, silent: true }], 1, { maxQueued: 10, segmentBytes: 100, compressAbove: 1e9 });
    h.a.pathUp('r');
    expect(h.a.send('y'.repeat(800))).toBe(true);
    expect(h.a.send('y'.repeat(300))).toBe(false);
  });

  it('says goodbye', () => {
    const h = harness([{ name: 'd', direct: true }]);
    h.a.pathUp('d');
    h.b.pathUp('d');
    h.a.bye();
    h.clock.advance(100);
    expect(h.byes.b).toBe(1);
  });

  it('ignores segments from another session of the peer', () => {
    const h = harness([{ name: 'd', direct: true }]);
    h.a.pathUp('d');
    h.b.pathUp('d');
    h.b.reset('cccccccccccccccc');
    h.a.send('lost');
    h.clock.advance(1000);
    expect(h.got.b).toEqual([]);
  });
});
