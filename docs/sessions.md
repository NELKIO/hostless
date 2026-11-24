# Sessions

All three sessions run on a `Room`; use the `create*` helpers to get the seat, the room and the
mailbox in one call, or construct them yourself (`new TurnMatch({ room, engine, role, seat })`).

## TurnMatch — turn-based, 2..N seats

```ts
interface TurnEngine<S, M, L> {
  validateLineup?(lineup: unknown): boolean;   // team / deck / options a player brings
  validateMove?(move: unknown): boolean;
  setup(lineups: L[], ctx: { matchId; seats; seed }): S;   // deterministic; use ctx.seed for randomness
  turn(state: S): number | null;               // seat to move, null when over
  apply(state: S, seat: number, move: M): S | null;   // pure; null = illegal
  result(state: S): { winner: number | null; draw?: boolean } | null;
  signature?(state: S): string;                // default sha256 of stable JSON
}
```

Flow:
1. `match.ready(lineup)` in the lobby (call again to change it; `ready(null)` withdraws). The latest
   revision wins.
2. The host starts when every seat is ready; everyone else recomputes `setup` and checks the
   signature. Different rules → `stop` with reason `version` on both sides.
3. `match.move(m)` → `false` if not your turn, illegal, or the journal could not be stored.
4. Events: `change`, `lobby`, `start`, `move`, `result` (once per match; again after a reload until
   you call `settle()`), `stop`, `seat-status` (`online` / `away` / `waiting`), `incompatible`,
   `storage-error`.

`leave()` before the start closes the lobby for everyone; during a match it only pauses (others
wait; your seat can come back). `leave({ quit: true })` ends the match.

Mailbox: when a match ends while some seat has not confirmed the final history, the history is left
on relays for 30 days. A seat that finds itself alone in an unfinished match looks there (backoff
10 s → 60 s) and accepts the copy only if it verifies and *finishes* the match.

Tips:
- Put everything that affects the rules into the lineups or the engine; anything else is local.
- Keep moves small (cell index, card id); send ids, not objects, and rebuild from your catalogue.
- For "first player" fairness use `ctx.seed`; it is derived from the match id.

## Replica — co-op and shared state

```ts
const r = await createReplica<Op>({ app, code, validate: (op, author) => isOp(op) });
r.push(op);                      // signed, committed, broadcast (batched)
r.on('op', (op, { mine }) => …); // causal order per author; for commutative updates
r.ordered();                     // the same total order everywhere: (lamport, author, seq)
r.fold(reducer, init);           // cached fold over ordered(); recomputes only after out-of-order arrivals
r.vector();                      // version vector
```

Anti-entropy runs every 4 s and on every (re)join. A late joiner receives the whole log. An authentic
op that fails `validate` blocks the rest of its author's log (event `invalid`), never other authors.

## HostAuthority — the host decides

```ts
interface AuthorityEngine<S, A> {
  init(): S;
  join?(state: S, seat: number, meta): S;
  leave?(state: S, seat: number): S;
  apply(state: S, seat: number, action: A): S | null | string;   // string = rejection reason
  validateAction?(action: unknown): boolean;
  hash?(state: S): string;
}
```

Guests call `act(action)` (returns a request id), get `accepted` / `rejected`, and follow `state`
events. Every act carries the hash of the new state; a guest whose shadow copy disagrees gets a
snapshot (`desync` event). Seats are bound to identities: a guest that reloads with its seat gets its
seat back. The host persists after every act and resumes after a reload. `maxSeats` (default 16).
Use it for hidden information (the host can send per-player views over `room.send`) or rules too
expensive to run on every device.
