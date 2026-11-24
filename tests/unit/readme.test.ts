import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { world } from '../helpers.js';
import { TurnMatch, type TurnEngine } from '../../src/sessions/turn-match.js';

// The tic-tac-toe engine shown in README.md must actually work.
const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const source = readme.match(/const ticTacToe = (\{[\s\S]*?\n\});/)![1];
const engine = new Function(`return (${source});`)() as TurnEngine<{ board: (number | null)[]; next: number; winner: number | null }, number>;

describe('README example', () => {
  it('plays a full game through TurnMatch', async () => {
    const w = world();
    const a = new TurnMatch({ room: await w.join(), engine, role: 'host', clock: w.clock });
    const b = new TurnMatch({ room: await w.join(), engine, role: 'guest', clock: w.clock });
    await w.run(2000);
    a.ready({ name: 'Ann' });
    b.ready({ name: 'Bob' });
    await w.run(1000);
    expect(a.phase).toBe('playing');
    expect(a.move(a.myTurn ? 9 : 0)).toBe(false);
    for (let i = 0; i < 9 && a.phase === 'playing'; i++) {
      const m = a.myTurn ? a : b;
      expect(m.move(m.state!.board.indexOf(null))).toBe(true);
      await w.run(300);
    }
    expect(a.phase).toBe('finished');
    expect(b.result).toEqual(a.result);
  });
});
