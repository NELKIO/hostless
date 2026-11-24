import type { TurnEngine } from '../src/sessions/turn-match.js';

export interface TttState {
  board: (number | null)[];
  next: number;
  winner: number | null;
  draw: boolean;
  names: string[];
  rules: string;
}

const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

/** Tic-tac-toe; the lineup is just a display name; the seed decides who starts. */
export const ticTacToe = (variant = 'standard'): TurnEngine<TttState, number, { name: string }> => ({
  validateLineup: (l) => typeof (l as { name?: unknown })?.name === 'string' && (l as { name: string }).name.length <= 20,
  validateMove: (m) => Number.isInteger(m) && (m as number) >= 0 && (m as number) < 9,
  setup: (lineups, ctx) => ({
    board: Array(9).fill(null),
    next: parseInt(ctx.seed.slice(0, 2), 16) % 2,
    winner: null,
    draw: false,
    names: lineups.map((l) => l.name),
    rules: variant,
  }),
  turn: (s) => (s.winner !== null || s.draw ? null : s.next),
  apply: (s, seat, cell) => {
    if (s.board[cell] !== null || seat !== s.next) return null;
    const board = s.board.slice();
    board[cell] = seat;
    const winner = LINES.some((l) => l.every((i) => board[i] === seat)) ? seat : null;
    const draw = winner === null && board.every((c) => c !== null);
    return { ...s, board, next: 1 - seat, winner, draw };
  },
  result: (s) => (s.winner !== null ? { winner: s.winner } : s.draw ? { winner: null, draw: true } : null),
});

export interface RaceState {
  total: number;
  next: number;
  seats: number;
  winner: number | null;
}

/** N players add 1..3 in turn; whoever reaches `goal` wins. */
export const raceTo = (goal: number, seats: number): TurnEngine<RaceState, number, { ok: true }> => ({
  setup: () => ({ total: 0, next: 0, seats, winner: null }),
  turn: (s) => (s.winner === null ? s.next : null),
  apply: (s, seat, n) => {
    if (seat !== s.next || ![1, 2, 3].includes(n)) return null;
    const total = s.total + n;
    return { ...s, total, next: (s.next + 1) % s.seats, winner: total >= goal ? seat : null };
  },
  result: (s) => (s.winner === null ? null : { winner: s.winner }),
});

/** first free cell, for scripted play */
export const firstFree = (s: TttState) => s.board.findIndex((c) => c === null);
