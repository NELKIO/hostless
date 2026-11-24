# Notes for AI coding agents

Use hostless when a browser game or app must work **without a server of its own** (GitHub Pages,
any static hosting) and still offer multiplayer, resumable matches, cross-device progress or global
counters.

## Pick the right piece

| the app needs | use |
|---|---|
| players take turns, rules are deterministic | `createTurnMatch({ app, code, role, engine })` |
| everyone acts at once on a shared document / board | `createReplica({ app, code, validate })` |
| one player's page should decide (hidden info, many players, heavy rules) | `createHostAuthority({ app, code, role, engine })` |
| just messages between peers (chat, cursors, custom protocol) | `joinRoom({ app, code })` → `room.channel(name)` |
| progress on several devices | `createDeviceSync({ app, store, merge })` + `crdt` |
| global numbers (players, games played) | `createPublicStats({ app, report })` |
| room creation / invite UI | `hostless/ui`: `<hostless-lobby>` emits `hostless-room` {code, role} |

## Rules that avoid bugs

- Engines must be **pure and deterministic**: no `Math.random()`, no `Date.now()`; use `ctx.seed`.
  Return new objects; never mutate the state you get.
- Moves and ops are JSON. Send ids, not catalogue objects.
- `app.protocol` must change whenever the wire format or rules change: peers with different
  protocols never link, so users see "please refresh" instead of desyncs.
- The room creator is `role: 'host'`. On reload, recover the role from `listSeats(appId)` (see
  `demo/common.ts → savedRole`), or a reloading host would join as a guest.
- `match.move()` / `replica.push()` can return false/null (not your turn, illegal, storage failed):
  handle it.
- `merge` for DeviceSync must be a join; build it from `crdt` and test it with the law checks in
  `tests/unit/crdt.test.ts`.
- Don't block on peers: render from `change` / `state` events.
- In tests use `hostless/testing` (`ManualClock`, `MemoryNetwork`, fake relays); pass
  `leaveOnPageHide: false` outside browsers.

## Map of the code

`src/room` (secrets, frames, segments, link, room) · `src/paths` (direct, nostr, mqtt, broadcast,
defaults) · `src/sessions` · `src/storage` · `src/sync` · `src/stats.ts` · `src/mailbox.ts` ·
`src/diag` · `src/ui` · `src/testing` · `src/connect.ts` (one-call helpers) · design and plan in
`docs/design/`.
