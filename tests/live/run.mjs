// The browser scenarios through PUBLIC infrastructure (Nostr relays, MQTT brokers, Trystero
// signaling over public relays). Needs internet; slower and occasionally flaky by nature.
process.env.HOSTLESS_LIVE = '1';
await import('../browser/run.mjs');
