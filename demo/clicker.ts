import { createDeviceSync, createPublicStats, deviceId, ledger, type Ledger } from '../src/index.js';
import { defineHostlessElements } from '../src/ui/index.js';
import { $, expose, storageRelays } from './common.js';

defineHostlessElements();

const APP = 'hostless-demo-clicker';
const KEY = `${APP}:save`;
const device = deviceId(APP);
interface Save {
  ledger: Ledger;
}

const read = (): Save => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '') as Save;
  } catch {
    return { ledger: {} };
  }
};
const listeners = new Set<() => void>();
let save = read();
const write = (next: Save) => {
  save = next;
  localStorage.setItem(KEY, JSON.stringify(next));
  render();
};
const clicks = () => Number(ledger.total(save.ledger).clicks ?? 0);

const relays = storageRelays();
const sync = createDeviceSync<Save>({
  app: APP,
  store: { read: () => save, write, subscribe: (f) => (listeners.add(f), () => listeners.delete(f)) },
  // a join: the per-device maximum of every counter
  merge: (local, remotes) => ({ ledger: remotes.reduce((l, r) => ledger.merge(l, r.ledger), local.ledger) }),
  ...(relays ? { relays } : {}),
});
const stats = createPublicStats({ app: APP, report: () => ({ clicks: Number(ledger.of(save.ledger, [device]).clicks ?? 0) }), ...(relays ? { relays } : {}) });

function render() {
  $('#count').textContent = clicks().toLocaleString();
  expose('__clicker', { clicks: clicks(), sync: sync.status, key: sync.key });
}

$('#click').addEventListener('click', () => {
  // this device's totals grew by one: the ledger keeps the part beyond the other devices
  write({ ledger: ledger.record(save.ledger, device, { clicks: clicks() + 1 }) });
  for (const f of listeners) f();
  stats.schedule();
});

async function world() {
  try {
    const t = await stats.totals();
    $('#world').textContent = `${t.players} browser${t.players === 1 ? '' : 's'} clicked ${(t.sums.clicks ?? 0).toLocaleString()} times in total.`;
  } catch {
    $('#world').textContent = 'The relays could not be reached.';
  }
}
$('#refresh').addEventListener('click', () => void world());

($('#sync') as HTMLElement & { sync: unknown }).sync = sync;
sync.events.on('status', render);
sync.events.on('merged', render);
void sync.start();
render();
void world();
