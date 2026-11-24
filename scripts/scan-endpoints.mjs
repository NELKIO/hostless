// Re-check public endpoints from this network: for every Nostr relay, whether it forwards anonymous
// ephemeral events (the live path) and stores a ~60 KB replaceable event with NIP-40 expiration
// (sync / mailbox / stats); for every MQTT broker, an echo. Writes docs/endpoints.json.
//   node scripts/scan-endpoints.mjs [extra relay or broker URLs...]
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { signEvent, generateSecretHex, checkMqttBroker } from './scan-lib.mjs';

const NOSTR = [
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.damus.io',
  'wss://nostr.mom',
  'wss://relay.nostr.net',
  'wss://nostr-01.yakihonne.com',
  'wss://relay.ditto.pub',
  'wss://bucket.coracle.social',
  'wss://relay.snort.social',
  'wss://relay.wavlake.com',
  'wss://fanfares.nostr1.com',
  'wss://relay.mleku.dev',
  'wss://nostr.21crypto.ch',
  'wss://relay.agora.social',
  'wss://offchain.pub',
  'wss://nostr.oxtr.dev',
  'wss://relay.nostr.band',
  'wss://nostr.wine',
  'wss://purplepag.es',
  'wss://relay.0xchat.com',
];
const MQTT = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt', 'wss://public.mqtthq.com:8084/mqtt', 'wss://mqtt.eclipseprojects.io:443/mqtt'];
for (const extra of process.argv.slice(2)) (extra.includes('mqtt') ? MQTT : NOSTR).push(extra);

const T = 9000;
const hex = (n) => randomBytes(n).toString('hex');

function open(url) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let ws;
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      resolve({ error: 'connect timeout' });
    }, T);
    try {
      ws = new WebSocket(url);
    } catch (e) {
      clearTimeout(timer);
      return resolve({ error: String(e) });
    }
    ws.onopen = () => {
      clearTimeout(timer);
      resolve({ ws, ms: Math.round(performance.now() - t0) });
    };
    ws.onerror = () => {};
    ws.onclose = (e) => {
      clearTimeout(timer);
      resolve({ error: `closed ${e.code}` });
    };
  });
}

function wait(ws, pred, ms = T) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', on);
      resolve(null);
    }, ms);
    const on = (ev) => {
      let m;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const r = pred(m);
      if (r !== undefined) {
        clearTimeout(timer);
        ws.removeEventListener('message', on);
        resolve(r);
      }
    };
    ws.addEventListener('message', on);
  });
}

async function scanRelay(url) {
  const out = { url, connectMs: null, ephemeral: false, ephemeralMs: null, storage: false, storageNote: null, error: null };
  const a = await open(url);
  if (!a.ws) return { ...out, error: a.error };
  out.connectMs = a.ms;
  const b = await open(url);
  if (!b.ws) {
    a.ws.close();
    return { ...out, error: `second socket: ${b.error}` };
  }
  try {
    // ephemeral forwarding
    const topic = hex(16);
    const sub = 'scan' + hex(4);
    a.ws.send(JSON.stringify(['REQ', sub, { kinds: [25050], '#t': [topic], limit: 0 }]));
    await new Promise((r) => setTimeout(r, 600));
    const sk = generateSecretHex();
    const ev = signEvent(sk, { kind: 25050, created_at: Math.floor(Date.now() / 1000), tags: [['t', topic]], content: hex(600) });
    const t0 = performance.now();
    const okP = wait(b.ws, (m) => (m[0] === 'OK' && m[1] === ev.id ? m : undefined));
    const gotP = wait(a.ws, (m) => (m[0] === 'EVENT' && m[1] === sub ? true : undefined));
    b.ws.send(JSON.stringify(['EVENT', ev]));
    const [ok, got] = await Promise.all([okP, gotP]);
    out.ephemeral = !!got;
    out.ephemeralMs = got ? Math.round(performance.now() - t0) : null;
    if (ok && ok[2] === false) out.error = `ephemeral refused: ${ok[3]}`;
    // storage: a 60 KB parameterized replaceable event with a 1 hour expiration
    const d = 'hostless-scan-' + hex(6);
    const big = signEvent(sk, { kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', d], ['expiration', String(Math.floor(Date.now() / 1000) + 3600)]], content: randomBytes(45_000).toString('base64') });
    const ok2P = wait(b.ws, (m) => (m[0] === 'OK' && m[1] === big.id ? m : undefined));
    b.ws.send(JSON.stringify(['EVENT', big]));
    const ok2 = await ok2P;
    if (!ok2) out.storageNote = 'no OK';
    else if (ok2[2] !== true) out.storageNote = `refused: ${ok2[3]}`;
    else {
      const c = await open(url);
      if (c.ws) {
        const s2 = 'scan' + hex(4);
        const found = wait(c.ws, (m) => (m[0] === 'EVENT' && m[1] === s2 ? m[2] : m[0] === 'EOSE' && m[1] === s2 ? null : undefined));
        c.ws.send(JSON.stringify(['REQ', s2, { kinds: [30078], authors: [big.pubkey], '#d': [d] }]));
        const e = await found;
        out.storage = !!e && e.content === big.content;
        if (!out.storage) out.storageNote = e ? 'content differs' : 'not returned';
        c.ws.close();
      }
    }
  } catch (e) {
    out.error = String(e);
  } finally {
    a.ws.close();
    b.ws.close();
  }
  return out;
}

const relays = await Promise.all(NOSTR.map(scanRelay));
const brokers = await Promise.all(MQTT.map((u) => checkMqttBroker(u, (url, p) => new WebSocket(url, p), T)));
const line = (cells) => cells.map((c, i) => String(c ?? '—').padEnd(i === 0 ? 42 : 12)).join('');
console.log(line(['nostr relay', 'connect', 'ephemeral', 'storage', 'note']));
for (const r of relays) console.log(line([r.url, r.connectMs ? `${r.connectMs} ms` : 'x', r.ephemeral ? `${r.ephemeralMs} ms` : 'no', r.storage ? 'yes' : 'no', r.error ?? r.storageNote ?? '']));
console.log('\n' + line(['mqtt broker', 'connect', 'echo', 'note']));
for (const b of brokers) console.log(line([b.url, b.connectMs ? `${b.connectMs} ms` : 'x', b.echoMs !== null ? `${b.echoMs} ms` : 'no', b.error ?? '']));
const at = new Date().toISOString();
writeFileSync(new URL('../docs/endpoints.json', import.meta.url), JSON.stringify({ at, relays, brokers }, null, 2) + '\n');
process.exit(0);
