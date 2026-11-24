# Changelog

## 0.1.0 — 2026-11-24

First release: the multiplayer layers of influence-web, RU-Fast-Food-Locator-Game and hexceed-web,
merged into one library.

- Rooms over direct WebRTC (Trystero), Nostr relays, MQTT brokers and BroadcastChannel at once, with
  one reliable link per peer (seq/ack/SACK/RTO, congestion window, fragmentation, compression).
- Signed hellos, pairwise-encrypted data frames, slow-KDF room topics.
- Nostr connection hopping against DPI freezes; standby relays; refusal and rate-limit handling.
- Sessions: TurnMatch (signed moves, write-ahead journal, restore, version stop, mailbox),
  Replica (signed op log, anti-entropy, total order, cached fold), HostAuthority.
- Seats with Web Locks; DeviceSync with CRDT toolkit; PublicStats; checkNetwork.
- Optional custom elements; test doubles (memory network, fake relays/brokers/Trystero, manual clock).
- Fixes relative to the source games: seq reuse after reload (hexceed), unsigned identities and op
  authors (hexceed), unchecked protocol versions (hexceed), relay size limit for large messages
  (hexceed), non-idempotent merge (hexceed), 4-symbol codes (influence), replayed-hello link resets
  (influence), silent queue eviction (influence), missing tab lock (influence), retransmission bursts
  that re-froze relay sockets (new), throwing `new WebSocket` (locator).
- Hardened after an independent review: replay-proof liveness (replayed relay frames no longer keep a
  vanished peer alive), no ghost peers after a goodbye, no key agreement or cache growth for unknown
  senders, segment size limits, no lobby livelock when a lineup changes while the host starts (the
  host replaces the match), no version-reply loops, optional host pinning via invite links, host
  answers persisted with the state (no double-applied requests after a host reload), bounded Lamport
  clocks and pending buffers in Replica, bounded Replica journals, seats that recover from a failed
  write, a timeout for Nostr replacement sockets, correct publishing from devices whose clock is behind.
