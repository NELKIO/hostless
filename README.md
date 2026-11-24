# hostless

**Multiplayer for static sites that refuses to disconnect.**
No game server, no accounts, no backend bill: a page on GitHub Pages gets rooms, turn-based and
real-time multiplayer, saved matches, cross-device progress and global statistics.

```
 browser A ──── WebRTC data channel (direct, preferred) ──── browser B
     │                                                           │
     ├──── public Nostr relays (many, independent) ──────────────┤   every path at once,
     └──── public MQTT brokers ──────────────────────────────────┘   one reliable link per peer
```

- **Works where WebRTC doesn't.** Symmetric NAT, VPN, corporate Wi‑Fi, mobile carriers: traffic moves
  to public relays within one timeout and the *same match* goes on. No TURN server needed.
- **Survives bad networks.** Every message is numbered, acknowledged and retransmitted over all
  paths; sockets that a DPI box silently freezes after a few KB are detected and replaced.
- **Survives the tab.** Moves are signed and written to disk *before* they are sent. Reload, crash,
  close the laptop: the seat comes back with the same identity and history. A player who returns
  days later gets the verified final result from a relay mailbox even if everyone else has left.
- **Progress follows the player** across devices through an encrypted CRDT document — no sign-up,
  just a key in a link.
- **Private by construction.** Rooms are derived from the code with a slow KDF; relays see random
  topics and ciphertext. Data between two players is encrypted with their pairwise key; hellos,
  moves and ops are Schnorr-signed.

It is the networking layer of three browser games, extracted, merged and hardened:
[influence-web](https://github.com/NELKIO/influence-web),
[RU-Fast-Food-Locator-Game](https://github.com/NELKIO/RU-Fast-Food-Locator-Game) (played across
countries over VPNs and mobile networks) and [hexceed-web](https://github.com/NELKIO/hexceed-web).

**[Live demos](https://nelkio.github.io/hostless/)** — tic-tac-toe, a co-op canvas, a synced clicker
and a connection check, all static pages.

## Install

```sh
npm i hostless
```

or without a build step:

```html
<script type="module">
  import { createTurnMatch } from 'https://cdn.jsdelivr.net/npm/hostless/dist/browser/hostless.js';
</script>
```

## A complete turn-based game

```js
import { createTurnMatch, newRoomCode, parseRoomCode, inviteLink } from 'hostless';

// 1. Your rules: five pure functions. hostless runs them on every device and verifies each move.
const ticTacToe = {
  setup: (lineups, { seed }) => ({ board: Array(9).fill(null), next: parseInt(seed[0], 16) % 2 }),
  turn: (s) => (s.winner != null || s.board.every(Boolean) ? null : s.next),
  apply: (s, seat, cell) => {
    if (s.board[cell] !== null) return null; // illegal → rejected everywhere
    const board = s.board.with(cell, seat);
    const won = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]].some((l) => l.every((i) => board[i] === seat));
    return { board, next: 1 - seat, winner: won ? seat : null };
  },
  result: (s) => (s.winner != null ? { winner: s.winner } : s.board.every((c) => c !== null) ? { winner: null, draw: true } : null),
};

// 2. A room: the creator hosts, the link joins.
const joining = parseRoomCode(location.href);
const code = joining ?? newRoomCode();
if (!joining) console.log('Invite:', inviteLink(code));

const match = await createTurnMatch({
  app: { id: 'my-tic-tac-toe', protocol: 1 },
  code,
  role: joining ? 'guest' : 'host',
  engine: ticTacToe,
});
match.ready({ name: 'Ann' });

// 3. Play.
match.on('change', () => render(match.state, match.myTurn));
match.on('result', (r) => alert(r.draw ? 'Draw' : r.winner === match.mySeat ? 'You won' : 'You lost'));
board.onclick = (e) => match.move(Number(e.target.dataset.cell)); // false if not your turn / illegal
```

That is the whole network code. Reload the page mid-game and it resumes.

## What happens when…

| situation | what hostless does |
|---|---|
| both players are on friendly networks | WebRTC data channel, ~20–80 ms; relays only carry rare pings |
| WebRTC cannot connect (symmetric NAT, VPN, blocked UDP) | the same messages flow over Nostr relays and MQTT brokers, typically 150–600 ms |
| the direct channel dies silently mid-match | unacknowledged messages are re-sent on every path after one timeout (≈0.3–1 s); the match continues |
| a relay freezes the socket after ~12 KB (DPI) | the missing OK is noticed in 1.5 s, a fresh socket takes over, later sockets are replaced before they freeze |
| a relay refuses or rate-limits | it is dropped for the session, the others carry on |
| a message is lost, duplicated or reordered | sequence numbers, cumulative + selective acks: exactly once, in order |
| the player reloads or the tab crashes | the seat (identity + journal) is restored; the match resyncs from the verified history |
| two tabs open the same game | Web Locks give the seat to one tab; the other is told the seat is busy |
| storage stops accepting writes | moves that cannot be stored are not sent (no replaying a turn after reload) |
| the opponent closed the game for good | after a timeout the seat is "waiting"; if they finished the match, the final history is fetched from the relay mailbox and verified |
| someone else has the code | they can join (codes are invitations), but cannot forge another player's moves, ops or identity; invite links can name the host (`inviteLink(code, { host })`) so guests ignore anyone else starting a match |
| the other player runs an older build | protocol versions never link; different game rules are detected at the start (`stop: 'version'`) |

## Pieces

| | |
|---|---|
| `joinRoom()` | a room over every path, with peers, presence, liveness, channels |
| `TurnMatch` | 2–N seats, turn-based, deterministic; signed moves, write-ahead journal, restore, mailbox |
| `Replica` | co-op / shared state: a signed op log with causal delivery, anti-entropy and a shared total order |
| `HostAuthority` | the host validates every action (hidden information, many players); guests verify by hash |
| `openSeat()` | identity + journal per room and role, exclusive per tab, pruning policies |
| `DeviceSync` | one encrypted CRDT document per player on Nostr; link devices with a key |
| `crdt` | `ledger` (per-device counters), `lww`, `union`, `max`, `object(schema)`… property-tested |
| `PublicStats` | every browser publishes its numbers; anyone sums them up |
| `checkNetwork()` | what this network reaches, with an echo per relay, NAT type via STUN |
| `hostless/ui` | optional framework-free elements: `<hostless-lobby>`, `<hostless-link>`, `<hostless-sync>`, `<hostless-netcheck>` |
| `hostless/testing` | in-memory networks, fake relays and brokers, a manual clock — test your game offline |

Read more: [architecture](docs/architecture.md) · [sessions](docs/sessions.md) ·
[sync & stats](docs/sync.md) · [security model](docs/security.md) · [testing your game](docs/testing.md) ·
[endpoints](docs/endpoints.md) · [for AI agents](AGENTS.md)

## Real-time and co-op

```js
import { createReplica } from 'hostless';

const canvas = await createReplica({ app: { id: 'paint', protocol: 1 }, code });
canvas.on('op', ({ op }) => drawPixel(op));       // everyone paints at once
canvas.push({ x: 3, y: 7, color: 'red' });         // signed, stored, broadcast
const picture = canvas.fold(applyPixel, blank);    // same total order on every screen
```

## Progress on every device

```js
import { createDeviceSync, DeviceSync, ledger, deviceId } from 'hostless';

const me = deviceId('my-game');
const sync = createDeviceSync({
  app: 'my-game',
  store: { read: () => save, write: (next) => persist(next) },
  merge: (local, remotes) => ({ xp: remotes.reduce((l, r) => ledger.merge(l, r.xp), local.xp) }),
});
await sync.link(DeviceSync.newKey());            // on the first device; share `#sync=KEY` with the next
save = { xp: ledger.record(save.xp, me, { xp: 120 }) };   // offline progress on two devices adds up
```

## Limits (honest)

- Public relays are run by volunteers and companies you have no contract with. hostless spreads
  traffic over many and survives losing most of them, but **for a commercial game, run or rent your
  own relay** (any NIP-01 relay, any MQTT broker) and list it first.
- Relay latency is fine for turn-based and casual real-time games, not for twitch shooters.
- Room codes are invitations: whoever has the code can join (up to `maxPeers`). They cannot cheat
  in a `TurnMatch` (moves are verified), but `PublicStats` totals can be inflated by anyone.
- No host migration in `HostAuthority`: if the host's page is gone, the room waits for it.

## Development

```sh
npm test               # 190 unit/integration tests (fake networks, fuzzed schedules, property tests)
npm run test:browser   # Chromium × 2 profiles, real WebRTC, local relays: 8 end-to-end scenarios
npm run test:live      # the same through public relays and brokers
npm run scan           # re-check the default public endpoints
npm run demo           # build and serve the demos on http://127.0.0.1:4321
```

MIT licensed.
