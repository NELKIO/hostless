# hostless — implementation plan

**Goal:** implement the library specified in `2026-11-24-hostless-design.md` (the spec), with tests
at every layer, a demo site and docs.

**Architecture:** layered (crypto → paths → link → room → sessions; storage/mailbox/sync/stats/diag
beside them; optional ui). Every layer is injected-dependency and testable in Node.

**Tech stack:** TypeScript 5.8 (strict), ESM, Node ≥ 22 for tests, vitest 3, fast-check, Playwright
(core) for browser tests, esbuild for bundles, `@noble/curves` + `@noble/hashes`, `trystero` 0.27.

**Execution:** inline in one session, task by task, TDD inside each task (tests first for every
behaviour listed under "Tests"), `npm test` green before each commit. A red test is debugged to its
root cause before moving on.

## Global constraints

- Node ≥ 22; browsers: evergreen (ES2022, WebCrypto, CompressionStream optional with fallback).
- Runtime deps only: `@noble/curves`, `@noble/hashes`, `@noble/ciphers`, `fflate`, `trystero` (dynamic import).
- No `window`/`document` access at module top level; every timer/clock/socket/storage injectable.
- Protocol constants: room code alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, code length 10,
  PBKDF2 60 000, hello window 120 s, away 12 s, leave 60 s, Nostr kind 25050 / 30078, frame
  2 400 B on Nostr, 8 KB MQTT, segment budget derived from the smallest frame.
- Commit messages without any co-author / assistant attribution.

## File map

```
src/
  index.ts                     public API barrel
  util/      emitter.ts  timers.ts  stable-json.ts  bytes.ts  log.ts  backoff.ts
  crypto/    hash.ts (sha256, hkdf, pbkdf2)  aes.ts  schnorr.ts (sign/verify/ecdh/keys)
             compress.ts  index.ts
  code.ts                      room codes, sync keys, invite links
  identity.ts                  Identity (secret → peerId, sign, verify, ecdh)
  room/      secrets.ts (roomSecrets)  frames.ts (HELLO/DATA codec)  hello.ts
             link.ts (reliability)  room.ts (Room, joinRoom)  types.ts
  paths/     types.ts  memory.ts  broadcast.ts  nostr.ts  mqtt-client.ts  mqtt.ts  direct.ts
             defaults.ts (endpoint lists)
  nostr/     event.ts (sign/verify NIP-01)  pool.ts (one-shot publish/query: talk/queryRelays)
  storage/   kv.ts  locks.ts  seats.ts
  sessions/  turn-match.ts  replica.ts  host-authority.ts  common.ts
  mailbox.ts
  sync/      crdt.ts  device-sync.ts
  stats.ts
  diag/      check.ts  netlog.ts
  testing/   index.ts  memory-network.ts  fake-nostr-relay.ts  fake-mqtt-broker.ts  chaos.ts
  ui/        index.ts  styles.ts  i18n.ts  lobby.ts  link-badge.ts  sync-panel.ts  netcheck.ts
tests/       unit/*.test.ts  integration/*.test.ts  browser/*.mjs  live/*.mjs
demo/        index.html  tictactoe.html  canvas.html  clicker.html  netcheck.html  *.ts
scripts/     scan-endpoints.mjs  build.mjs
```

## Tasks

### T1 — scaffold + util + crypto + codes + identity
Files: package.json, tsconfig, vitest config, `src/util/*`, `src/crypto/*`, `src/code.ts`,
`src/identity.ts`. Produces: `sha256(bytes|string)`, `hkdf(ikm, salt, info, len)`, `pbkdf2`,
`aesSeal(key, plain, aad?)`, `aesOpen`, `schnorrSign/Verify`, `ecdhX(secret, pub)`, `deflate/inflate`
(capped), `stableJson`, `toHex/fromHex/toB64/fromB64`, `newRoomCode(len?)`, `parseRoomCode(text,
{param, length})`, `newSyncKey`, `parseSyncKey`, `formatKey`, `inviteLink(base, param, code)`,
`Identity.generate()/fromSecret(hex)`, `.peerId .sign(msg) .pairSecret(peerId)`, `verify(peerId, msg, sig)`.
Tests: sha/hkdf/pbkdf2 known vectors (RFC 5869, RFC 6070-style), AES round-trip + tamper + AAD
mismatch, schnorr BIP-340 vector, ECDH symmetry, inflate cap rejects bombs, stableJson key order,
code parse from link/dashes/lowercase, rejects bad alphabet/length.

### T2 — frames + hello + room secrets
Files: `src/room/secrets.ts`, `frames.ts`, `hello.ts`. Produces: `roomSecrets(appId, code) →
{topic, roomKey, rtcPassword, secret}` (cached), `encodeHello/decodeHello`, `encodeData/decodeData`,
`PairKeys` cache. Tests: hello signed/verified, forged sig rejected, stale `at` rejected, wrong room
key rejected, data frame decrypts only for the pair, AAD binds from/to, size of hello ≤ 1 KB.

### T3 — memory network + Link (reliability)
Files: `src/paths/types.ts`, `src/paths/memory.ts`, `src/testing/memory-network.ts`,
`src/room/link.ts`. Produces: `Path` interface, `MemoryNetwork` (`path(kind, peer)`, latency,
loss, dup, reorder, partition, freeze), `Link` with `send(value, {reliable})`, `receive(path, seg)`,
`pathUp/pathDown`, `tick(now)`, events `message`, `overflow`. Tests: in-order exactly-once delivery
under 30% loss + dup + reorder (fast-check), direct preferred when healthy, direct silently dead →
traffic moves to relays within one RTO, path flap mid-transfer, 300 KB message fragmented over a
2 400-B path, unreliable latest-only, restart (new sid) resets state.

### T4 — Room
Files: `src/room/room.ts`, `types.ts`, `src/index.ts`. Produces: `joinRoom(opts) → Room` per spec §7.
Tests (memory paths): two and five peers join/leave, away/back/leave timing (fake clock),
incompatible protocol event, replayed old hello does not reset, restart detected, capacity `full`,
broadcast, channels, bye on leave, peer reachable only over relay, link survives direct loss.

### T5 — Nostr: event utils, one-shot pool, NostrPath, fake relay
Files: `src/nostr/event.ts`, `src/nostr/pool.ts`, `src/paths/nostr.ts`,
`src/testing/fake-nostr-relay.ts`, `src/paths/defaults.ts`. Produces: `signEvent`, `verifyEvent`,
`publishEvent(event, {relays, Socket, timeoutMs}) → count`, `queryRelays(filter, opts) → {events,
reachable}`, `NostrPath`. Fake relay: NIP-01 REQ/EVENT/CLOSE/EOSE/OK, ephemeral + replaceable +
NIP-40, options `freezeAfterBytes`, `refuse`, `rateLimit`, `dropOk`. Tests: two Rooms over a fake
relay; hopping after freeze carries the match through; refusing relay dropped; rate-limited relay
dropped after 3; reconnection with backoff; fanout rotation; peer mask preference.

### T6 — MQTT: client, path, fake broker
Files: `src/paths/mqtt-client.ts`, `src/paths/mqtt.ts`, `src/testing/fake-mqtt-broker.ts`.
Tests: packet encode/decode (remaining length varint), connect/subscribe/publish against the fake
broker, two Rooms over MQTT only, broker restart reconnect, frame size limit.

### T7 — direct path (Trystero) + broadcast path
Files: `src/paths/direct.ts`, `src/paths/broadcast.ts`. Tests: broadcast path between two Rooms in
Node (BroadcastChannel exists in Node); direct path unit-tested with a fake `joinRoom` (binding,
unbinding on leave, never up without RTCPeerConnection); real WebRTC covered in browser tests (T13).

### T8 — storage: kv, locks, seats
Files: `src/storage/*`. Produces: `openSeat({app, room, role, storage?, locks?}) → Seat |
null` with `identity`, `record`, `save(rec)`, `commit(rec)` (durable or false), `release()`,
`persistent`; `listSeats(app)`, `removeSeat`, `pruneSeats(app, policy, now)`. Tests: second tab
cannot open a held seat, volatile fallback when storage throws, denied locks → never reuse durable
signer, commit refuses when durable storage starts failing, prune policy table.

### T9 — sessions: TurnMatch + mailbox
Files: `src/sessions/common.ts`, `turn-match.ts`, `src/mailbox.ts`. Tests (memory room, tic-tac-toe
engine in tests): full game, illegal move rejected, out-of-turn rejected, forged move signature
rejected, version mismatch stop, reload mid-match restore → continue, move not sent when commit
fails, peer leaves before start closes, during match pauses then resumes, mailbox final fetched by
returning peer while host is gone, result emitted once, 3-seat game.

### T10 — sessions: Replica + HostAuthority
Files: `src/sessions/replica.ts`, `host-authority.ts`. Tests: replica convergence under chaos
(fast-check over op schedules), spoofed author rejected, reload keeps seq, ordered()/fold
recompute; host authority: actions validated, rejection, hash mismatch → snapshot, late joiner gets
snapshot, returning guest keeps seat, capacity.

### T11 — sync: crdt + DeviceSync; stats
Files: `src/sync/crdt.ts`, `device-sync.ts`, `src/stats.ts`. Tests: crdt laws (fast-check),
ledger ownEntry, DeviceSync against fake relays (two devices converge, offline device merges later,
unreadable doc blocks publish, newer version → outdated, clock ahead, single-flight, link/unlink),
stats totals newest-per-author, invalid signatures ignored, debounce.

### T12 — diag + netlog + ui widgets
Files: `src/diag/*`, `src/ui/*`. Tests: checkNetwork against fake relay/broker, NAT classifier from
candidate lists; ui widgets rendered in happy-dom (lobby create/join flow, badge states, sync panel
actions).

### T13 — build, demo, browser e2e, live tests
Files: `scripts/build.mjs`, `demo/*`, `tests/browser/*.mjs`, `tests/live/*.mjs`,
`scripts/scan-endpoints.mjs`. Browser scenarios per spec §11; live run through public endpoints;
endpoint scan updates `defaults.ts`.

### T14 — docs
README (pitch, 30-line example, how it works, failure table, API overview, limits, security
model), `docs/` pages per module, CHANGELOG, LICENSE (MIT), CONTRIBUTING, AGENTS.md for AI agents.
