// Compatibility check with a real game: the RU-Fast-Food-Locator duel engine (plain JS, 69 fighters,
// effects, transformations) plugged into TurnMatch unchanged. Runs only when the game is checked out
// next to this repository (../refs/RU-Fast-Food-Locator-Game).
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { world } from '../helpers.js';
import { TurnMatch, type TurnEngine } from '../../src/sessions/turn-match.js';

const dir = new URL('../../../refs/RU-Fast-Food-Locator-Game/public/js/', import.meta.url);
const present = existsSync(new URL('duel-engine.js', dir));

describe.skipIf(!present)('locator duel engine on TurnMatch', () => {
  it('plays a 3v3 duel between two rooms, identical on both devices', async () => {
    const duel = await import(/* @vite-ignore */ new URL('duel-engine.js', dir).href);
    const { FIGHTERS } = await import(/* @vite-ignore */ new URL('fighters.js', dir).href);
    const catalog = new Map(Object.entries(FIGHTERS).map(([id, card]) => [id, { ...(card as object), id }]));
    type Lineup = { team: string[] };
    const engine: TurnEngine<any, string, Lineup> = {
      validateLineup: (l) => duel.validTeam((l as Lineup)?.team, catalog),
      validateMove: (m) => typeof m === 'string' && m.length < 40,
      setup: (lineups, { seed }) => {
        const size = Math.min(...lineups.map((l) => l.team.length));
        const stats = lineups.map((l) => l.team.slice(0, size).map((id) => duel.battleStats(catalog.get(id), true)));
        return duel.startBattle(stats, duel.opener(stats, parseInt(seed.slice(0, 2), 16) % 2));
      },
      turn: (s) => (s.winner === null ? s.turn : null),
      apply: (s, seat, move) => duel.applyMove(s, seat, move),
      result: (s) => (s.winner === null ? null : s.winner === 'draw' ? { winner: null, draw: true } : { winner: s.winner }),
    };
    const ids = [...catalog.keys()];
    const w = world();
    const a = new TurnMatch({ room: await w.join(), engine, role: 'host', clock: w.clock });
    const b = new TurnMatch({ room: await w.join(), engine, role: 'guest', clock: w.clock });
    await w.run(2000);
    expect(a.ready({ team: ids.slice(0, 3) })).toBe(true);
    expect(b.ready({ team: ids.slice(10, 13) })).toBe(true);
    await w.run(1000);
    expect(a.phase).toBe('playing');
    let moves = 0;
    for (; moves < 200 && a.phase === 'playing'; moves++) {
      const m = a.myTurn ? a : b;
      const legal = duel.legalMoves(m.state);
      // prefer attacks so the duel ends; deterministic choice
      const pick = legal.find((x: string) => x !== 'hit' && !x.startsWith('switch')) ?? legal[0];
      expect(m.move(pick)).toBe(true);
      await w.run(250);
    }
    await w.run(1000);
    expect(a.phase).toBe('finished');
    expect(b.state).toEqual(a.state);
    expect(b.result).toEqual(a.result);
    console.log(`locator duel: ${moves} moves, result ${JSON.stringify(a.result)}`);
  });
});
