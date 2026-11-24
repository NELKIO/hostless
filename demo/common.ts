// Shared demo plumbing: options from the URL (so tests can point the demos at local relays) and the
// "which seat do I hold for this code" logic.
import { listSeats, setNetDebug, type ConnectOptions, type PathSpec } from '../src/index.js';

const q = new URLSearchParams(location.search);

/** `?paths=nostr,mqtt&nostr=ws://…&mqtt=ws://…&signal=ws://…&netdebug=1` */
export function connectOptions(): Pick<ConnectOptions, 'paths' | 'nostr' | 'mqtt' | 'direct'> {
  if (q.get('netdebug') === '1') setNetDebug(true);
  const list = (k: string) => q.get(k)?.split(',').filter(Boolean);
  const paths = list('paths') as PathSpec[] | undefined;
  const nostr = list('nostr');
  const mqtt = list('mqtt');
  const signal = list('signal');
  return {
    ...(paths ? { paths } : {}),
    ...(nostr ? { nostr: { relays: nostr } } : {}),
    ...(mqtt ? { mqtt: { brokers: mqtt } } : {}),
    ...(signal ? { direct: { relays: signal } } : {}),
  };
}

export const storageRelays = (): string[] | undefined => q.get('storage')?.split(',').filter(Boolean);

/** The role this browser holds for `code` (a reload of the host stays the host). */
export function savedRole(app: string, code: string): 'host' | 'guest' | null {
  const seat = listSeats(app).find((s) => s.room === code && (s.role === 'host' || s.role === 'guest'));
  return (seat?.role as 'host' | 'guest' | undefined) ?? null;
}

export function $(sel: string): HTMLElement {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el as HTMLElement;
}

/** expose state to end-to-end tests */
export function expose(name: string, value: unknown): void {
  (window as unknown as Record<string, unknown>)[name] = value;
}

const PAGES: Array<[string, string]> = [
  ['tictactoe.html', 'Tic-tac-toe'],
  ['canvas.html', 'Co-op canvas'],
  ['clicker.html', 'Synced clicker'],
  ['netcheck.html', 'Connection check'],
];

const el = (tag: string, attrs: Record<string, string> = {}, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Top bar with navigation between the demos, and the footer. */
export function chrome(): void {
  const here = location.pathname.split('/').pop() || 'index.html';
  const bar = el('header', { class: 'topbar' });
  const inner = el('div', { class: 'in' });
  const brand = el('a', { class: 'brand', href: './' });
  brand.append(el('img', { src: 'logo.svg', alt: '' }), el('span', {}, 'hostless'));
  const nav = el('nav', { class: 'nav', 'aria-label': 'Demos' });
  for (const [href, label] of PAGES) nav.append(el('a', { href, ...(href === here ? { 'aria-current': 'page' } : {}) }, label));
  inner.append(brand, nav, el('a', { class: 'gh', href: 'https://github.com/NELKIO/hostless' }, 'GitHub ↗'));
  bar.append(inner);
  document.body.prepend(bar);
  const foot = el('footer', { class: 'foot' });
  const fin = el('div', { class: 'in' });
  fin.append(el('span', {}, 'Static pages · no server · MIT'), el('span', {}, 'npm i hostless'));
  foot.append(fin);
  document.body.append(foot);
}
