# hostless — design

Status: approved direction (2026-11-24). This document is the contract the implementation follows.

## 1. Goal

A TypeScript library that gives a **static website** (GitHub Pages, any CDN) working multiplayer and
cross-device persistence **without a server of its own**:

- players meet with a short room code or link;
- the match runs over a direct WebRTC channel when possible and **keeps running** over public
  relays (Nostr, MQTT) when WebRTC fails, drops, or is blocked (VPN, symmetric NAT, DPI);
- a closed tab, a reload or a long outage does not lose the match: it resumes from a verified log;
- the result of a match reaches a player who comes back days later (store-and-forward);
- one player's progress follows them across devices without accounts (CRDT over encrypted events);
- a site can show global statistics aggregated from every browser, still without a server.

It merges three battle-tested codebases:

| source | what is taken |
|---|---|
| influence-web | multipath reliability (seq/ack/SACK/RTO over all paths at once), Nostr bus with connection hopping against DPI freezes, MQTT relay, connectivity check, host-authoritative room |
| RU-Fast-Food-Locator-Game | signed per-seat identity, Web-Lock seat journal, persist-before-send, turn match with verified replay and version rejection, final-state mailbox (NIP-40), device sync controller, CRDT ledger, public stats |
| hexceed-web | shared crypto module, injected dependencies, op-log co-op replica with version vectors, adaptive batching, bfcache/pagehide handling |

and fixes the defects found in all three (see §10).

Non-goals: media streams, >16 players per room, host migration, anti-cheat beyond deterministic
verification, a hosted backend.

## 2. Layers

```
 ui/          <hostless-lobby> <hostless-link> <hostless-sync> <hostless-netcheck>   (optional)
 sessions/    TurnMatch        Replica (op log)        HostAuthority
 room/        Room: identity, signed hello, peers, liveness, versions, per-peer reliable links
 link/        Link: seq/ack/SACK/RTO, fragmentation, compression, path choice  (multipath)
 paths/       direct (Trystero WebRTC) · nostr · mqtt · broadcast (tabs) · memory (tests)
 crypto/      sha256, HKDF, PBKDF2, AES-GCM, schnorr, ECDH, base64, deflate, stable JSON
 storage/     seats (identity + journal + Web Locks), kv
 mailbox/     store-and-forward finals on Nostr (kind 30078 + NIP-40)
 sync/        DeviceSync + crdt toolkit
 stats/       PublicStats
 diag/        checkNetwork(), netlog
 testing/     memory network, fake Nostr relay, fake MQTT broker, lossy/chaos helpers
```

Every layer takes its collaborators as injected options (WebSocket constructor, clock, storage,
locks, random, timers) with browser defaults. Nothing reads `window`/`document` at import time.

## 3. Crypto and identifiers

- **Room code**: alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (32 symbols, 5 bits), default 10 symbols
  (50 bits). Parsed case-insensitively, `-`/spaces ignored, from a bare code or a link fragment
  `#<param>=CODE`. Length is configurable (≥ 6).
- **Room secret**: `PBKDF2-SHA256(code, salt = "hostless/1/room/" + appId, 60 000 it.) → 32 bytes`.
  From it, by HKDF-SHA256 with distinct `info` strings:
  - `topic` (16 bytes hex) — the only room-derived value that is public (relay tags/topics);
  - `roomKey` — AES-GCM key for HELLO frames and mailbox content;
  - `rtcPassword` — Trystero room password.
  Guessing a code costs one PBKDF2 per guess against a 2^50 space.
- **Identity**: a secp256k1 key pair. `peerId` = x-only public key, 64 hex chars. Sessions use a
  persistent identity per seat (storage/seats) or an ephemeral one.
- **Pair key**: `HKDF(x(ECDH(mySecret, theirPub)), salt = roomSecret, info = "hostless/1/pair/" + sorted ids)`
  → AES-GCM. Data frames between two peers are encrypted with it; a frame that decrypts is
  authenticated as coming from the other holder. No per-frame signatures.
- **Session id (`sid`)**: 8 random bytes per Room instance. A new sid = the peer page restarted.

## 4. Wire format (path payloads, bytes)

```
HELLO  = 0x01 | iv(12) | AES-GCM(roomKey, json(HelloBody))
DATA   = 0x02 | from(32) | to(32) | iv(12) | AES-GCM(pairKey(from,to), segment, aad = from|to)
```

`HelloBody = { v:1, from, sid, at, to|null, app, proto, meta, hints, sig }` where `sig` is a schnorr
signature of sha256(stableJson(body without sig)) by `from`.

Rules on receipt:
- `|now - at| ≤ 120 s`, signature valid, `from ≠ self`;
- a hello with a new sid for a known peer is accepted only if `at` is greater than the `at` of the
  hello that introduced the current sid (old hellos replayed by anyone with the code cannot reset a
  link — fixes influence `relayLink.ts:379`);
- `proto` different from ours → event `incompatible` (both versions), no link.

DATA segments (inside the pair encryption) are a compact JSON array:
```
[t, fromSid, toSid, ...]   t: 'd' data · 'a' ack · 'p' ping · 'q' pong · 'u' unreliable · 'b' bye
'd': [ 'd', fs, ts, seq, ack, flags, chunk ]       flags: 1 first, 2 last, 4 deflated
'a': [ 'a', fs, ts, ack, missing[] ]
'p': [ 'p', fs, ts, t0, path ]   'q': [ 'q', fs, ts, t0, path ]
'u': [ 'u', fs, ts, payload ]    'b': [ 'b', fs, ts ]
```
A segment whose `fromSid` is not the peer's current sid is dropped; a segment whose `toSid` is not
ours triggers an addressed HELLO (the peer still talks to our previous page).

## 5. Paths

Common interface:

```ts
interface Path {
  readonly kind: 'direct' | 'nostr' | 'mqtt' | 'broadcast' | 'memory';
  readonly maxFrame: number;               // bytes a single send may carry
  readonly up: boolean;                    // can send to the room at all
  reachable(peer: PeerId): boolean;        // can address this peer now
  send(to: PeerId | null, frame: Uint8Array): boolean;  // null = everyone in the room
  hint(): unknown;  setPeerHint(peer, hint): void;      // e.g. nostr relay mask
  bind(peer: PeerId, via: unknown): void;  // direct: map transport peer → identity
  on('frame' | 'up' | 'down' | 'via-gone', ...)
  close(): void;
}
```

- **direct** — Trystero 0.27 (`trystero` loaded lazily), Nostr signaling over configurable relays,
  `appId = "hostless/" + appId`, room id = topic, `password = rtcPassword`, optional `turnConfig`.
  A frame received from Trystero peer `X` that verifies as identity `P` binds `X → P`
  (`reachable(P)`); Trystero `onPeerLeave(X)` unbinds. Absent `RTCPeerConnection` → the path is
  simply never up.
- **nostr** — port of influence `NostrBus`: connects to N relays, subscribes to `#t=[roomTopic,
  myTopic]` with `limit:0`, publishes ephemeral kind 25050 events signed by a throwaway key on
  `fanout = 2` relays in rotation, prefers relays the peer listens on (bitmask hint), drops relays
  that refuse (`blocked|auth-required|…`, three `rate-limited` within 30 s, `CLOSED`), reconnects with
  jittered backoff, and **connection hopping**: each EVENT expects an OK within 1.5 s; a missing OK
  means a frozen socket → a fresh socket replaces it and unconfirmed events are resent; the byte
  budget a socket carried before freezing is remembered and later sockets are replaced in advance
  at 70% of it. Frames ≤ 2 400 bytes.
- **mqtt** — own minimal MQTT 3.1.1 client over WebSocket (CONNECT/SUBSCRIBE/PUBLISH QoS 0/PING),
  connects to all brokers, subscribes to `hostless/1/<topic>/all` and `…/<myTopic>`, publishes on
  up to 2 connected brokers. No mqtt.js dependency. Frames ≤ 8 KB.
- **broadcast** — `BroadcastChannel("hostless/" + topic)`: tabs of one browser (dev, tests).
- **memory** — in-process network for tests with latency, jitter, loss, duplication, reordering,
  partitions, per-path freezes.

Default endpoints are the union of lists verified in the three games, re-checked by
`scripts/scan-endpoints.mjs` (ephemeral forwarding, kind 30078 storage, NIP-40). Users override all.

## 6. Link (reliability, per remote peer)

Port of influence `MpPeer`, generalised to N peers and pluggable paths:

- `best()`: the direct path while healthy (traffic within 5 s and not suspected), otherwise every
  reachable relay at once; the receiver keeps the first copy.
- seq/cumulative ack, delayed acks (20 ms direct / 200 ms relay), SACK of holes older than 150 ms,
  RTO = srtt + max(srtt/2, 4·rttvar), floors 250 ms direct / 700 ms relay, cap 4 s, exponential
  backoff ×2^min(tries,3); every retransmit goes on **all** reachable paths; a path that becomes
  reachable immediately carries every unacked segment (seamless switch); a path that speaks again
  after a pause "kicks" pending retransmits.
- per-path ping/pong RTT (2 s direct, 15 s relay in use, 30 s relay idle).
- messages are JSON values; > 1 KB are deflated; split into segments that fit the smallest
  `maxFrame` of the paths that could carry them; reassembled in order.
- unreliable sends (`{reliable:false}`) go once on `best()`; latest-wins helpers for cursors.
- bounded queues (4 000 unacked/buffered); overflow raises `overflow` instead of silently evicting
  (fixes influence `multipath.ts:235`).
- one shared timer per Room (100 ms tick), not per link.

## 7. Room

```ts
const room = await joinRoom({
  app: { id: 'my-game', protocol: 3 },   // incompatible protocols never link
  code,                                  // from newRoomCode()/parseRoomCode()
  identity,                              // Identity | undefined (ephemeral)
  paths: ['direct', 'nostr', 'mqtt'],    // or Path instances / factories
  meta: { name: 'Ann' },                 // shown to peers in hello
  maxPeers: 8,
});
room.on('peer-join' | 'peer-leave' | 'peer-away' | 'peer-back' | 'peer-restart' |
        'message' | 'path' | 'incompatible' | 'status', ...)
room.send(peer, value, { reliable?, channel? });  room.broadcast(value, opts)
room.peers() → PeerInfo[] { id, meta, state, path: 'direct'|'relay'|null, rtt }
room.leave()   // sends bye, closes paths; also on pagehide
```

- HELLO broadcast on every path when it comes up, then every 2 s while a known peer is unconfirmed,
  otherwise every 20 s; addressed HELLO in reply to an unknown sid.
- liveness: `away` after 12 s of silence, `leave` after `leaveMs` (60 s, configurable) or BYE;
  `back` when traffic returns. Peer restarts (new sid, newer hello) emit `peer-restart`.
- capacity: peers beyond `maxPeers` (first come by hello `at`) are not linked and get `full`.
- `channel` lets several sessions share one room (`tm`, `rp`, `ha`, app's own).

## 8. Sessions

### 8.1 TurnMatch (2–N seats, alternating/ordered turns) — from locator `DuelRoom`
Engine supplied by the game:
```ts
interface TurnEngine<S, M, L> {
  validateLineup(lineup: unknown, seat: number): lineup is L;
  setup(lineups: L[], ctx: { matchId: string; seats: PeerId[] }): S;   // deterministic
  turn(state: S): number | null;            // seat to move, null when over
  apply(state: S, seat: number, move: M): S | null;   // null = illegal
  result(state: S): { winner: number | null; draw?: boolean } | null;
  signature?(state: S): string;             // default: sha256(stableJson(state))
}
```
- lobby: each seat sends `ready{rev, lineup|null, prefs}`; latest revision wins.
- the host (seat 0) starts when every seat has a lineup: random `matchId`, seats bound to peer
  ids, `signature` of the initial state; sends `state{matchId, seats, lineups, signature, base, moves}`.
  Others accept only if their own lineup is unchanged and `setup` reproduces the signature;
  otherwise `stop{reason:'version'}`.
- moves are **signed by their author** (`sig` over matchId|index|seat|stableJson(move)), so any seat
  can relay history; every received suffix is replayed through `apply` with author check.
- **persist before send**: the move is committed to the seat journal first; if storage that used to be
  durable refuses, the move is not sent (`move()` returns false).
- history packets carry the suffix the peer lacks; a periodic `head{len, hash}` repairs divergence.
- liveness from Room: `waiting` after 12 s silence, `pending` after 25 s; on return, both resend.
- `stop{reason: quit|left|timeout|version}`; leaving before the first move closes the room;
  during a match it only pauses.
- result emitted exactly once per matchId (idempotent across reloads via journal `settled` flag).
- final mailbox: on terminal state the final journal is offered to Nostr (kind 30078, NIP-40
  30 days); a returning peer that sees an unfinished match looks it up with backoff (10 s → 60 s).
- restore: `TurnMatch.restore(seatRecord)` replays and verifies the saved journal.

### 8.2 Replica (op log, co-op / shared state) — from hexceed `CoopLog`, fixed
- ops `{a: author, n: seq, l: lamport, op, sig}`; author signature verified (fixes spoofed `by`);
- per-author contiguous delivery, gaps buffered, duplicates dropped;
- own ops persisted (with the seq counter, in the same seat record as the identity) **before** send:
  losing storage loses the identity too, so a reused seq is impossible (fixes hexceed seq collision);
- anti-entropy: version vector piggybacks on a 4 s heartbeat; `want{vec}` → missing ops;
- views: `ops` events in causal order (for commutative apps) and `ordered()` = total order by
  (lamport, author, seq) + `fold(reducer, init)` with memoised recompute on out-of-order arrival;
- validation hook `validateOp(op, author)`.

### 8.3 HostAuthority (host-validated state, 2–16 seats) — from influence `battleRoom`
- host owns `state`; guests send `req{id, action}`; host runs `engine.apply(state, seat, action)`;
  success → `act{seq, seat, action, hash}` to all, failure → `rej{id, reason}`;
- guests keep a shadow state, apply `act`s in order and compare `hash(state)`; mismatch or gap →
  `want{seq}` → `snap{seq, state}`;
- seats: host assigns on `join` (identity-stable, so a returning guest keeps its seat), capacity,
  kick; host persists state after each act; guests resume with the same identity.

## 9. Storage, mailbox, sync, stats, diagnostics

- **seats**: `openSeat({ app, room, role })` takes an exclusive Web Lock (`ifAvailable`), falls back to
  volatile mode when locks or storage are unavailable (never shares a persistent signer between tabs).
  Seat record = identity secret + journal + flags. `listSeats`, `removeSeat`, `pruneSeats(policy)`
  (defaults from locator: settled results 1 day, untouched 7 days, empty seats 1 hour).
- **mailbox**: `sealFinal/openFinal/lookup` with `d = H(topic|matchId)`, author filter = peer id,
  content AES-GCM(roomKey), NIP-40 expiration.
- **DeviceSync** — locator `createSync` generalised: account key (32 symbols, 160 bits, link
  `#sync=`), derived signing key + AES key, compressed encrypted replaceable event (kind 30078,
  `d = "hostless:" + app`), merge supplied by the app (`merge(local, docs)`, `docOf(local)`),
  debounce 2.5 s, 90 s interval, on visibility, single-flight with follow-up, clock-ahead handling,
  "unreadable → never overwrite", "newer doc version → read but never write (outdated)",
  publish only when < 3 reachable relays already hold the merged doc.
- **crdt** toolkit: `ledger` (per-device grow-only counters over nested numeric maps, with
  `ownEntry`), `lww`, `max`, `min`, `union`, `firstWins`, `object(schema)`; laws verified by
  property tests (commutative, associative, idempotent).
- **PublicStats**: per-browser key (lock-protected), replaceable event per browser
  (`d = "hostless-stats:" + app`, tag `t = H(app)`), totals = sum of numeric fields of the newest valid
  event per author; device-sync-aware (`report` gets only this device's ledger entry).
- **diag**: `checkNetwork()` → per relay/broker reachability, latency, echo through it, STUN NAT type
  (symmetric detection), WebRTC availability; `netlog` ring buffer, enabled by `?netdebug=1`.

## 10. Defects fixed by design

| origin | defect | fix |
|---|---|---|
| hexceed coop | seq reuse after lost debounced save → permanent divergence | seq stored with identity, persisted before send |
| hexceed room | unsigned clientId / unchecked op author → impersonation | signed hello, pair-key frames, signed ops |
| hexceed room | protocol version never checked | `proto` in signed hello → `incompatible` |
| hexceed relay | 256 KB setup dropped on 60 KB relay limit | link-level fragmentation + deflate |
| hexceed sync-merge | `seen` capped in clean but not in merge → non-idempotent | crdt laws tested by property tests |
| influence crypto | 4-symbol codes brute-forced offline | 10-symbol codes + PBKDF2 |
| influence relayLink | replayed ciphertext resets a link | hello freshness + monotonic `at` |
| influence multipath | silent eviction over 4 000 | explicit `overflow` |
| influence | no tab lock | Web-Lock seats |
| influence mqtt | async rx reorders | link layer orders everything |
| locator relay | `new WebSocket` may throw | guarded everywhere |
| all | per-link 50 ms timers | one room timer |

## 11. Testing

- **unit** (vitest, Node 22+): crypto vectors, framing, link under the memory network with loss
  0–40%, duplication, reorder, partitions, path flaps (fuzzed with fast-check), room membership,
  every session (full games, restarts, reloads mid-move, archive), seats with fake locks/storage,
  sync scenarios (locator's chaos tests ported), crdt laws, stats aggregation.
- **integration** (Node): Room over a local fake Nostr relay (NIP-01, with freeze/DPI and refusal
  simulation) and a local fake MQTT broker.
- **browser e2e** (Playwright, two isolated contexts): demo pages over real WebRTC + local relays;
  scenarios: direct; WebRTC disabled → relay; direct dropped mid-match → relay continues;
  tab closed → reopened → resumed; opponent gone → final from mailbox.
- **live** (`npm run test:live`): two Chromium processes through public relays/brokers, forced
  direct, nostr-only, mqtt-only; plus `scripts/scan-endpoints.mjs`.

A failing test is investigated to its root cause; no skips without a written reason.

## 12. Packaging

- `hostless` (ESM, `.d.ts`), subpath exports `hostless/ui`, `hostless/testing`.
- `dist/hostless.js` single-file browser bundle (deps included, Trystero lazy chunk) for no-build
  sites; `dist/hostless-ui.js`.
- dependencies: `@noble/curves`, `@noble/hashes`, `@noble/ciphers` (synchronous AES-GCM), `fflate`
  (synchronous deflate), `trystero` (lazy). Synchronous crypto keeps frame coding deterministic and
  makes every layer testable on a manual clock. No other runtime deps.
- demo site (`demo/`, GitHub Pages): tic-tac-toe on TurnMatch, co-op pixel canvas on Replica,
  a clicker with DeviceSync + PublicStats, the net check page.
