/**
 * Default public endpoints. Every list is the union of what the three source games verified in
 * production, re-checked with `npm run scan` (see scripts/scan-endpoints.mjs and docs/endpoints.md).
 * Override them per call for anything serious: public relays come and go.
 */

/**
 * Relays that forward anonymous ephemeral events (live path). The first four carried long sessions
 * from Russia without a VPN (influence-web, October 2026), where big Cloudflare-hosted relays freeze
 * sockets after a few KB; all of them passed `npm run scan` on 2026-11-24.
 */
export const DEFAULT_NOSTR_RELAYS: readonly string[] = Object.freeze([
  'wss://relay.wavlake.com',
  'wss://fanfares.nostr1.com',
  'wss://relay.mleku.dev',
  'wss://nostr.21crypto.ch',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://relay.nostr.net',
  'wss://nostr-01.yakihonne.com',
  'wss://relay.ditto.pub',
  'wss://relay.snort.social',
  'wss://bucket.coracle.social',
  'wss://relay.damus.io',
]);

/** Relays that keep replaceable app data (kind 30078) of up to ~60 KB with NIP-40 (sync, mailbox, stats). */
export const DEFAULT_STORAGE_RELAYS: readonly string[] = Object.freeze([
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://nostr.mom',
  'wss://relay.nostr.net',
  'wss://nostr-01.yakihonne.com',
  'wss://relay.ditto.pub',
  'wss://relay.snort.social',
  'wss://bucket.coracle.social',
  'wss://relay.damus.io',
]);

/** Relays used by Trystero for WebRTC signaling. */
export const DEFAULT_SIGNALING_RELAYS: readonly string[] = Object.freeze([
  'wss://relay.primal.net',
  'wss://bucket.coracle.social',
  'wss://nostr-01.yakihonne.com',
  'wss://relay.ditto.pub',
  'wss://relay.nostr.net',
]);

/** MQTT over secure WebSocket brokers that accept anonymous clients. */
export const DEFAULT_MQTT_BROKERS: readonly string[] = Object.freeze([
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
]);

export const DEFAULT_STUN: readonly string[] = Object.freeze([
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
]);
