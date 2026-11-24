/**
 * Shared plumbing for the hostless custom elements: a base class that is safe to import outside a
 * browser, DOM helpers that only ever set text (never HTML), and the structural types the elements
 * accept (a real Room / DeviceSync or any look-alike).
 */
import type { PeerInfo, RoomStatus } from '../room/room.js';
import type { SyncStatus } from '../sync/device-sync.js';
import type { Unsubscribe } from '../util/emitter.js';
import { BASE_CSS } from './styles.js';
import { resolveLang, translate, type Lang, type StringKey } from './i18n.js';

type AnyListener = (...args: any[]) => void;

/** What the UI needs from a Room. */
export interface RoomLike {
  readonly code?: string;
  readonly peerId?: string;
  readonly status: RoomStatus;
  getPeers(): PeerInfo[];
  pathInfo?(): Array<{ name: string; kind: string; direct: boolean; up: boolean; status?: Record<string, unknown> }>;
  on?(event: string, listener: AnyListener): Unsubscribe;
  readonly events?: { on(event: string, listener: AnyListener): Unsubscribe };
}

/** What the UI needs from a DeviceSync. */
export interface SyncLike {
  readonly status: SyncStatus;
  readonly key: string | null;
  link(keyText: string): Promise<{ ok: boolean; reason?: string }>;
  unlink(): void;
  syncNow(): Promise<unknown>;
  readonly events?: { on(event: 'status', listener: (status: SyncStatus) => void): Unsubscribe };
}

export const ROOM_EVENTS = ['peer-join', 'peer-leave', 'peer-away', 'peer-back', 'peer-update', 'route', 'status', 'path'] as const;

/** Report an error without letting it escape a callback. */
export function report(error: unknown): void {
  try {
    // eslint-disable-next-line no-console
    console.error('[hostless/ui]', error);
  } catch {
    /* no console */
  }
}

/** Wrap a callback so it never throws (sync errors and rejected promises are reported). */
export function safe<A extends unknown[]>(fn: (...args: A) => unknown): (...args: A) => void {
  return (...args: A) => {
    try {
      const result = fn(...args);
      if (result && typeof (result as Promise<unknown>).then === 'function') (result as Promise<unknown>).then(undefined, report);
    } catch (error) {
      report(error);
    }
  };
}

/** Subscribe to the given room events; returns one function that removes them all. */
export function subscribeRoom(room: RoomLike, events: readonly string[], listener: AnyListener): Unsubscribe {
  const offs: Unsubscribe[] = [];
  const handler = safe(listener);
  for (const event of events) {
    try {
      const off = typeof room.on === 'function' ? room.on(event, handler) : room.events?.on(event, handler);
      if (typeof off === 'function') offs.push(off);
    } catch (error) {
      report(error);
    }
  }
  return () => {
    for (const off of offs.splice(0)) {
      try {
        off();
      } catch (error) {
        report(error);
      }
    }
  };
}

export function peersOf(room: RoomLike | null): PeerInfo[] {
  if (!room) return [];
  try {
    const peers = room.getPeers();
    return Array.isArray(peers) ? peers : [];
  } catch (error) {
    report(error);
    return [];
  }
}

export function statusOf(room: RoomLike | null): RoomStatus {
  try {
    const s = room?.status;
    return s === 'online' || s === 'connecting' || s === 'offline' || s === 'closed' ? s : 'connecting';
  } catch {
    return 'connecting';
  }
}

/** A display name for a peer: `meta.name` if it is a non-empty string, else the start of its id. */
export function peerName(peer: PeerInfo): string {
  const name = peer?.meta && typeof peer.meta.name === 'string' ? peer.meta.name.trim() : '';
  if (name) return name.length > 40 ? name.slice(0, 39) + '…' : name;
  return String(peer?.id ?? '?').slice(0, 8);
}

type Child = Node | string | null | undefined | false;
type Props = {
  class?: string;
  text?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  on?: Record<string, (event: Event) => unknown>;
};

/** Create an element; strings become text nodes, never markup. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const [type, fn] of Object.entries(props.on ?? {})) node.addEventListener(type, safe(fn));
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** Copy text: the async clipboard API, else a hidden textarea + execCommand. */
export async function copyText(text: string): Promise<boolean> {
  try {
    const clip = globalThis.navigator?.clipboard;
    if (clip && typeof clip.writeText === 'function') {
      await clip.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const doc = globalThis.document;
    if (!doc?.body) return false;
    const area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    area.style.left = '-9999px';
    doc.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = typeof doc.execCommand === 'function' && doc.execCommand('copy');
    } finally {
      area.remove();
    }
    return ok;
  } catch {
    return false;
  }
}

export function canShare(): boolean {
  try {
    return typeof globalThis.navigator?.share === 'function';
  } catch {
    return false;
  }
}

/** The page URL without its fragment ('' outside a browser). */
export function pageBase(): string {
  try {
    return String(globalThis.location?.href ?? '').split('#')[0];
  } catch {
    return '';
  }
}

export function pageHref(): string {
  try {
    return String(globalThis.location?.href ?? '');
  } catch {
    return '';
  }
}

/** HTMLElement in a browser, an inert class elsewhere, so importing this module never throws. */
const Base: typeof HTMLElement =
  typeof globalThis.HTMLElement === 'function' ? globalThis.HTMLElement : (class {} as unknown as typeof HTMLElement);

export abstract class HostlessElement extends Base {
  protected readonly root: ShadowRoot;
  protected connected = false;
  /** extra CSS for this element, appended after the shared styles */
  protected css = '';

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
  }

  static get observedAttributes(): string[] {
    return ['lang'];
  }

  protected get locale(): Lang {
    return resolveLang(this.getAttribute('lang'));
  }

  protected t(key: StringKey, vars?: Record<string, string | number>): string {
    return translate(this.locale, key, vars);
  }

  connectedCallback(): void {
    this.connected = true;
    this.attached();
    this.refresh();
  }

  disconnectedCallback(): void {
    this.connected = false;
    try {
      this.detached();
    } catch (error) {
      report(error);
    }
  }

  attributeChangedCallback(_name: string, oldValue: string | null, newValue: string | null): void {
    if (this.connected && oldValue !== newValue) this.refresh();
  }

  /** Re-render now; errors are reported, never thrown. */
  protected refresh(): void {
    if (!this.connected) return;
    try {
      this.render();
    } catch (error) {
      report(error);
    }
  }

  /** Replace the shadow content, keeping focus (and caret) on an element that is mounted again. */
  protected mount(...nodes: Child[]): void {
    const active = this.root.activeElement as HTMLElement | null;
    const key = active?.dataset?.focus;
    const input = active instanceof HTMLInputElement ? active : null;
    const selection = input ? [input.selectionStart, input.selectionEnd] : null;
    const style = document.createElement('style');
    style.textContent = BASE_CSS + this.css;
    this.root.replaceChildren(style, ...nodes.filter((n): n is Node | string => n !== null && n !== undefined && n !== false));
    if (!key) return;
    const target = this.root.querySelector<HTMLElement>(`[data-focus="${key}"]`);
    if (!target) return;
    try {
      target.focus();
      if (selection && target instanceof HTMLInputElement && selection[0] !== null) target.setSelectionRange(selection[0], selection[1]);
    } catch {
      /* some inputs refuse selection */
    }
  }

  protected attached(): void {}
  protected detached(): void {}
  protected abstract render(): void;
}

export type Translate = (key: StringKey, vars?: Record<string, string | number>) => string;

/** `direct` / `relay` / `none` for a peer's route. */
export function routeKind(peer: PeerInfo): 'direct' | 'relay' | 'none' {
  return peer?.route === 'direct' ? 'direct' : peer?.route === 'relay' ? 'relay' : 'none';
}

export function rttText(t: Translate, peer: PeerInfo): string | null {
  const rtt = peer?.rtt;
  return typeof rtt === 'number' && Number.isFinite(rtt) ? t('ms', { n: Math.max(0, Math.round(rtt)) }) : null;
}

/** A colored route pill: dot + direct/relay/no route (+ rtt). */
export function routeBadge(t: Translate, peer: PeerInfo, withRtt = true): HTMLSpanElement {
  const kind = routeKind(peer);
  const label = t(kind === 'direct' ? 'direct' : kind === 'relay' ? 'relay' : 'noRoute');
  const rtt = withRtt ? rttText(t, peer) : null;
  return el(
    'span',
    { class: `badge route-${kind}`, attrs: { 'data-route': kind } },
    el('span', { class: 'dot', attrs: { 'aria-hidden': 'true' } }),
    rtt ? `${label} · ${rtt}` : label,
  );
}
