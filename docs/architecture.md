# Architecture

```
 ui/          <hostless-lobby> <hostless-link> <hostless-sync> <hostless-netcheck>   (optional)
 sessions/    TurnMatch          Replica (op log)          HostAuthority
 room/        Room: identity, signed hello, peers, liveness, versions, channels
 link/        Link: seq / ack / SACK / RTO / congestion window / fragmentation / deflate
 paths/       direct (Trystero WebRTC) · nostr · mqtt · broadcast (tabs) · memory (tests)
 crypto/      sha256 · HKDF · PBKDF2 · AES-GCM · BIP-340 Schnorr · x-only ECDH · deflate
 storage/     seats (identity + journal, Web Locks) · safe key-value store
 mailbox · sync (DeviceSync + crdt) · stats (PublicStats) · diag (checkNetwork, netlog)
```

Every layer takes its collaborators as options (WebSocket factory, clock, storage, locks, random
bytes), so everything above the browser APIs runs in Node on a manual clock in the tests.

## From a room code to a delivered move

1. **Secrets.** `PBKDF2-SHA256(code, "hostless/1/room/" + appId, 60 000)` → master; HKDF gives the
   public `topic`, the `roomKey` (hellos, mailbox), the Trystero password and the pair salt. Only the
   topic (a slow-KDF output) is ever visible to third parties.
2. **Paths start.** Each path is a datagram bus into the room:
   - `direct`: Trystero joins signaling room `topic` on public Nostr relays and opens WebRTC data
     channels to the other browsers;
   - `nostr`: sockets to up to 8 relays (more on standby), subscribed to the room topic and our own
     peer topic; frames go out as signed ephemeral events (kind 25050) on 2 relays in rotation;
   - `mqtt`: three public brokers, the same topic scheme;
   - `broadcast`: a BroadcastChannel for tabs of one browser.
3. **Hello.** Every path carries a HELLO: `{from, sid, at, app, protocol, meta, hints}` encrypted with
   the room key and Schnorr-signed by the participant identity. A verified hello creates a **Link**
   to that peer session (or resets it when the session id changed and the hello is newer).
4. **Data.** A message is JSON → deflated above 1 KB → cut into segments that fit the smallest frame
   of any path (Nostr: 2 400 B) → numbered. Each segment is sealed in a DATA frame with the pairwise
   key (ECDH of the two identities), so a frame that opens is authenticated.
5. **Path choice.** The direct path alone while it is healthy (heard within 5 s, not suspected);
   otherwise every reachable relay at once. Unacknowledged segments are resent after one RTO on
   *all* paths; a path that comes up carries everything still in flight.
6. **Sessions** ride on named channels of the room: `tm` (TurnMatch), `rp` (Replica), `ha`
   (HostAuthority), or your own.

## Reliability in numbers

| | direct | relays |
|---|---|---|
| ack delay | 20 ms | 200 ms (acks batch) |
| RTO floor / cap | 250 ms / 4 s | 700 ms / 4 s |
| ping | every 2 s | 4 s while carrying traffic, 30 s idle |
| window | up to 256 segments | up to 24 segments |
| congestion | on timeout: window → 2, ssthresh = half; slow start, then +1 per RTT | same |
| holes | reported (SACK, up to 32) once older than 150 ms | same |

Peers are `away` after 12 s of silence and gone after 60 s (or a goodbye). Sessions decide what
"gone" means: a TurnMatch waits indefinitely for a seat, the room just stops linking it.

## Connection hopping (Nostr, against DPI)

Some networks let a TLS connection to foreign hosting carry only ~10–16 KB and then freeze it
silently. Every EVENT is answered by an OK, so an overdue OK (1.5 s) means a frozen socket: a fresh
socket replaces it and carries the newest unconfirmed events (at most half of the bytes the relay
allowed before). The smallest byte budget a socket of each relay carried before freezing is
remembered, and later sockets are replaced *before* they freeze, at 70 % of it. Relays whose sockets
never froze are preferred. Relays that refuse (`blocked`, `auth-required`, `restricted`, ...), keep
rate-limiting, close the subscription or never answer are dropped and a standby relay takes over.

## Where each idea came from

| idea | origin |
|---|---|
| all paths at once, seq/ack/SACK/RTO, direct suspicion, kick on path recovery | influence-web `multipath.ts` |
| connection hopping, budgets, refusal handling, fanout rotation, relay masks | influence-web `nostrRelay.ts` |
| MQTT relay | influence-web `mqttRelay.ts` (re-done as a ~250-line client) |
| signed per-seat identity, Web-Lock journal, write-ahead commit | RU-Fast-Food-Locator `duel-journal.js`, `duel-room.js` |
| turn match: revisioned lobby, signature of the setup, history replay, version stop, liveness | RU-Fast-Food-Locator `duel-room.js` |
| final journal on relays with NIP-40 | RU-Fast-Food-Locator `duel-mailbox.js` |
| device sync, CRDT ledger, clock-ahead handling, unreadable/outdated guards | RU-Fast-Food-Locator `sync.js`, `sync-merge.js` |
| public statistics | RU-Fast-Food-Locator `site-stats.js` |
| op log with version vectors, injected dependencies, shared crypto module | hexceed-web `coop.ts`, `room.ts`, `nostr.ts` |
| host-authoritative room with hash check and snapshots | influence-web `battleRoom.ts` |
| congestion window, pairwise keys, signed ops, fragmentation, standby relays | new in hostless |
