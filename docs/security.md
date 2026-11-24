# Security model

## What third parties see

Relays, brokers and signaling servers see:
- a 128-bit topic per room (output of PBKDF2 with 60 000 iterations over the code and app id) and
  topics derived from it per peer;
- ciphertext of fixed-shape frames and their sizes and timing;
- throwaway Nostr keys (live traffic) and, for stored items (mailbox, sync, stats), a per-room seat
  key, a per-sync-account key or a per-browser key.

They never see the room code, the app's messages, moves or documents.

## Who can do what

| actor | can | cannot |
|---|---|---|
| a relay or broker | drop, delay, reorder, duplicate frames; refuse to store | read, alter or forge them (AES-GCM + signatures) |
| an eavesdropper on the relays | count rooms and traffic | brute-force a 10-symbol code offline cheaply: each guess costs a 60 000-round PBKDF2, 2^50 guesses |
| someone with the room code | join while there is room (`maxPeers`), read hellos (name, meta) | read data between two other peers (pairwise keys), forge their moves or ops (signatures), impersonate their identity, reset their links by replaying old hellos (monotonic `at`) |
| a player in a TurnMatch | resign, stall, leave | move out of turn, make an illegal move, rewrite history (every device replays and verifies), change rules (setup signature) |
| a player in a Replica | spam valid ops | forge ops of others; one invalid op of theirs blocks only their own later ops |
| a guest in HostAuthority | send requests | change state the host did not accept (guests verify by hash) |
| the host in HostAuthority | anything (it is the authority) | — choose TurnMatch if that matters |
| anyone | publish fake PublicStats reports | — treat totals as indicative |

## Identities

A participant key is a secp256k1 secret. Seats (`openSeat`) keep one per (app, room, role) in
localStorage, guarded by an exclusive Web Lock; without a lock nothing is persisted, so two tabs can
never sign with the same persistent key. `commit()` refuses to act on a move or op that could not be
stored where the key is stored.

## Limits

- Room codes are invitations; share them like a link to a private document.
- A long, public room (a link posted on a forum) is joinable by anyone until `maxPeers`.
- Timing and size of frames leak activity (turn rhythm). Pad your messages if that matters.
- The sync key is the account. Losing it loses access; leaking it gives full access to that document.
- Public relays are third-party services; availability is not guaranteed.
