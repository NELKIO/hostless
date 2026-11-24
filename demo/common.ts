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
