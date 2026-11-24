import { createDeviceSync, createPublicStats, deviceId, ledger, type Ledger } from '../src/index.js';
import { defineHostlessElements } from '../src/ui/index.js';
import { $, chrome, expose, storageRelays } from './common.js';

chrome();
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

$('#click').addEventListener('click', (e) => {
  const tap = e.currentTarget as HTMLElement;
  const plus = document.createElement('span');
  plus.className = 'plus';
  plus.textContent = '+1';
  plus.style.left = `${(e as MouseEvent).offsetX || 75}px`;
  plus.style.top = `${(e as MouseEvent).offsetY || 40}px`;
  tap.append(plus);
  setTimeout(() => plus.remove(), 700);
  // this device's totals grew by one: the ledger keeps the part beyond the other devices
  write({ ledger: ledger.record(save.ledger, device, { clicks: clicks() + 1 }) });
  for (const f of listeners) f();
  stats.schedule();
});

async function world() {
  try {
    const t = await stats.totals();
    $('#world-total').textContent = (t.sums.clicks ?? 0).toLocaleString();
    $('#world').textContent = `clicks by ${t.players} browser${t.players === 1 ? '' : 's'}, summed from public relays`;
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
