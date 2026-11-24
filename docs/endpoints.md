# Public endpoints

Defaults live in `src/paths/defaults.ts`; override them per path (`nostr: { relays }`, `mqtt: { brokers }`,
`direct: { relays, turn }`, `mailboxRelays`, `relays` for sync and stats). Re-check from your network:

```sh
npm run build && npm run scan    # writes docs/endpoints.json
```

The scan checks, for each Nostr relay, that an anonymous ephemeral event (kind 25050) published on one
socket arrives on another, and that a 60 KB replaceable event (kind 30078) with a NIP-40 expiration is
accepted and returned intact; for each MQTT broker, a publish/subscribe echo.

Result of 2026-11-24 (see `endpoints.json` for numbers):

| relay | live (25050) | storage (30078, 60 KB) |
|---|---|---|
| relay.primal.net, nos.lol, nostr.mom, relay.nostr.net, nostr-01.yakihonne.com, relay.ditto.pub, bucket.coracle.social, relay.snort.social, relay.wavlake.com, fanfares.nostr1.com, relay.mleku.dev, nostr.21crypto.ch | yes | yes |
| relay.damus.io | unreachable from the scanning network that day (worked earlier and in the source games) | — |
| offchain.pub | yes | refused (web of trust) |
| nostr.wine, purplepag.es, nostr.oxtr.dev | refused (paid / kind not allowed / disk full) | — |
| relay.agora.social, relay.nostr.band, relay.0xchat.com | unreachable | — |

| MQTT broker | echo |
|---|---|
| broker.emqx.io:8084, broker.hivemq.com:8884, test.mosquitto.org:8081 | 75–93 ms |
| public.mqtthq.com, mqtt.eclipseprojects.io | unreachable |

Notes from the field (influence-web, October 2026): from Russian home networks without a VPN, the
large Cloudflare/Hetzner-hosted relays freeze sockets after ~16–30 KB while wavlake, fanfares,
mleku and 21crypto carried long sessions — hence their place at the top of the live list. Connection
hopping (see [architecture](architecture.md)) keeps the others usable anyway.

For production, add a relay you control (any NIP-01 relay, e.g. strfry or nostr-rs-relay) and a
broker (Mosquitto with WebSockets) at the top of the lists; keep the public ones as fallbacks.
