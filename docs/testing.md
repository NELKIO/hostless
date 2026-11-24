# Testing your game

`hostless/testing` simulates everything in one process, deterministically:

```ts
import { joinRoomWith, TurnMatch } from 'hostless';
import { ManualClock, MemoryNetwork } from 'hostless/testing';

const clock = new ManualClock();
const net = new MemoryNetwork(clock, /* seed */ 7)
  .medium('direct', { direct: true, latency: 15 })
  .medium('relay', { latency: 150, jitter: 200, loss: 0.2, duplicate: 0.1 });

const join = () => joinRoomWith({ app, code: 'ABCDEFGHJK', clock, paths: [net.path('direct'), net.path('relay')], leaveOnPageHide: false });
const [a, b] = [await join(), await join()];
const host = new TurnMatch({ room: a, engine, role: 'host', clock });
const guest = new TurnMatch({ room: b, engine, role: 'guest', clock });
await clock.advanceAsync(3000, 50);   // time moves only when you say so

net.freeze('direct', b.peerId);       // the direct channel dies silently
net.partition('relay', a.peerId, b.peerId);
net.setUp('relay', false);            // the whole medium goes down
```

Also available: `FakeNostrNetwork` (NIP-01/NIP-40 relays that can refuse, rate-limit, close
subscriptions, be down or freeze sockets after N bytes), `FakeMqttNetwork`, `FakeTrystero`,
`MemoryStorage` (can fail writes / hit a quota) and `MemoryLocks`. Pass their `ws` factory to the
paths: `nostrPath({ relays, ws: fake.ws })`.

## This repository's own tests

| command | what |
|---|---|
| `npm test` | unit + integration (Node): crypto vectors, codecs, link fuzzing under loss, rooms, every session, seats, sync scenarios, CRDT laws, fake relays and brokers |
| `npm run test:browser` | builds, then two isolated Chromium profiles with real WebRTC and local relay/broker servers: direct, Nostr-only, MQTT-only, WebRTC killed mid-match, reload mid-match, mailbox result, co-op canvas, device sync |
| `npm run test:live` | the same scenarios through public relays, brokers and signaling |
| `FUZZ_RUNS=400 npm test` | longer fuzzing |
