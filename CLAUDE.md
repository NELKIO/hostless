# CLAUDE.md

Guidance for Claude Code working **in this repository** (the hostless library). If you are building an
app *with* hostless, read [AGENTS.md](AGENTS.md) instead.

## What this is

A TypeScript library: serverless multiplayer for static sites. Layers, bottom up:
`src/crypto` → `src/paths` (direct/Trystero, nostr, mqtt, broadcast) → `src/room/link.ts` (reliability)
→ `src/room/room.ts` → `src/sessions` (TurnMatch, Replica, HostAuthority). Beside them: `src/storage`
(seats, Web Locks), `src/mailbox.ts`, `src/sync` (DeviceSync, crdt), `src/stats.ts`, `src/diag`,
`src/ui` (custom elements), `src/testing` (fakes), `src/connect.ts` (one-call helpers), `src/index.ts`
(public API). Design and plan: `docs/design/`. How it works: `docs/architecture.md`.

## Commands

```sh
npm test                 # vitest: unit + integration (fast, offline)
npm run typecheck        # tsc --noEmit over src, tests, demo
npm run build            # dist/ (tsc) + dist/browser/ (esbuild bundles)
npm run test:browser     # builds demo-dist, then 2 Chromium profiles with real WebRTC + local relays
npm run test:live        # same scenarios through public relays/brokers (needs internet)
FUZZ_RUNS=400 npm test   # longer fuzzing of link and replica
npx vitest run tests/unit/link.test.ts -t "dies silently"   # one test
```

Run `npm run typecheck && npm test` before every commit; run `npm run test:browser` when touching
paths, link, room, sessions or demos.

## Rules

- **Root causes only.** A failing test is debugged until the cause is understood (instrument the
  scenario, see the history of `tests/unit/hardening.test.ts`). Never skip, loosen or retry a test to
  make it green without a written reason.
- **Every bug fix gets a regression test**, ideally proven to fail without the fix.
- **Determinism:** every layer takes `clock`, sockets (`ws` factory), storage, locks and random bytes
  as options. No `window`/`document` access at module top level. Tests use `ManualClock` +
  `MemoryNetwork` / `FakeNostrNetwork` / `FakeMqttNetwork` / `FakeTrystero`; drive time with
  `await w.run(ms)` (see `tests/helpers.ts`).
- In fast-check properties use block bodies (`(x) => { expect(...); }`): returning vitest's assertion
  result makes fast-check report a false failure.
- **Wire compatibility:** any change to frames, segments or session messages bumps the matching
  protocol constant (`TURN_PROTOCOL`, `REPLICA_PROTOCOL`, `AUTHORITY_PROTOCOL`) and goes into
  CHANGELOG.md.
- **Security invariants** (see `docs/security.md`): verify signatures before acting on content;
  liveness only from fresh evidence; nothing unbounded that a peer holding the room code can grow;
  unknown senders cost no key agreement.
- Keep README.md and README.ru.md in sync when changing user-facing behaviour.
- Commit messages: plain descriptive sentences. **Never add Co-authored-by trailers or any Claude /
  AI attribution.**
- Don't push, tag or `npm publish` without the maintainer asking.

## Gotchas

- Web Locks release asynchronously: `seat.release()` returns a promise; await it before reopening.
- SVG gradients on horizontal/vertical lines need `gradientUnits="userSpaceOnUse"`.
- `MemoryNetwork.freeze()` works by peer id: two rooms with the same identity are frozen together —
  use `crash(room)` from `tests/helpers.ts` to simulate a dead tab.
- Node ≥ 22 provides WebSocket, BroadcastChannel and CompressionStream; tests rely on them.
