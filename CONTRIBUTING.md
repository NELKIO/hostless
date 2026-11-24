# Contributing

- `npm ci && npm test` must pass; add a test for every behaviour you change (fake networks make
  network bugs reproducible: see docs/testing.md).
- A failing test is investigated to its root cause; don't skip or loosen it without a written reason.
- `npm run typecheck`, and `npm run test:browser` for anything touching paths, rooms or sessions.
- Keep layers injectable (clock, sockets, storage): no `window`/`document` at module top level.
- Bump `TURN_PROTOCOL` / `REPLICA_PROTOCOL` / `AUTHORITY_PROTOCOL` or the frame version on any wire change.
