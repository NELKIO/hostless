/**
 * Network debug log: a ring buffer of recent events, off by default. Enable with `?netdebug=1` in
 * the page URL, `localStorage['hostless:netdebug'] = '1'`, or `setNetDebug(true)`.
 * Entries are also mirrored to `globalThis.__hostlessLog` so a tester can copy them from devtools.
 */
export interface NetLogEntry {
  t: number;
  event: string;
  data?: Record<string, unknown>;
}

const MAX = 2000;
let enabled: boolean | null = null;
let entries: NetLogEntry[] = [];
let mirror: ((entry: NetLogEntry) => void) | null = null;

function detect(): boolean {
  try {
    if (/[?&#]netdebug=1\b/.test(globalThis.location?.href ?? '')) return true;
  } catch {
    /* no location */
  }
  try {
    return globalThis.localStorage?.getItem('hostless:netdebug') === '1';
  } catch {
    return false;
  }
}

export function netDebugEnabled(): boolean {
  if (enabled === null) enabled = detect();
  return enabled;
}

export function setNetDebug(on: boolean, onEntry?: (entry: NetLogEntry) => void): void {
  enabled = on;
  mirror = onEntry ?? null;
}

export function netlog(event: string, data?: Record<string, unknown>): void {
  if (!netDebugEnabled()) return;
  const entry: NetLogEntry = { t: Date.now(), event, data };
  entries.push(entry);
  if (entries.length > MAX) entries = entries.slice(-MAX);
  try {
    (globalThis as { __hostlessLog?: NetLogEntry[] }).__hostlessLog = entries;
  } catch {
    /* frozen global */
  }
  mirror?.(entry);
}

export function getNetLog(): NetLogEntry[] {
  return entries.slice();
}

export function clearNetLog(): void {
  entries = [];
}
