// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ALPHABET, newSyncKey, parseRoomCode, parseSyncKey } from '../../src/code.js';
import type { NetworkReport } from '../../src/diag/check.js';
import type { PeerInfo, Room, RoomEvents, RoomStatus } from '../../src/room/room.js';
import type { DeviceSync, DeviceSyncEvents, SyncStatus } from '../../src/sync/device-sync.js';
import { Emitter } from '../../src/util/emitter.js';
import {
  HostlessLink,
  HostlessLobby,
  HostlessNetcheck,
  HostlessSync,
  defineHostlessElements,
  type HostlessRoomDetail,
  type RoomLike,
  type SyncLike,
} from '../../src/ui/index.js';

// the real classes fit the structural types the elements accept
const roomFits: RoomLike = null as unknown as Room;
const syncFits: SyncLike = null as unknown as DeviceSync<unknown>;
void roomFits;
void syncFits;

const CODE_RE = new RegExp(`^[${ALPHABET}]{10}$`);

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const flush = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

function q<T extends Element = HTMLElement>(host: Element, selector: string): T | null {
  return host.shadowRoot!.querySelector<T>(selector);
}
function qa(host: Element, selector: string): Element[] {
  return [...host.shadowRoot!.querySelectorAll(selector)];
}
function must<T extends Element = HTMLElement>(host: Element, selector: string): T {
  const found = q<T>(host, selector);
  if (!found) throw new Error(`no ${selector} in <${host.localName}>: ${host.shadowRoot!.textContent}`);
  return found;
}
const text = (host: Element) => host.shadowRoot!.textContent ?? '';

function peer(id: string, over: Partial<PeerInfo> = {}): PeerInfo {
  return {
    id,
    meta: {},
    app: { id: 'test', protocol: 1 },
    state: 'connected',
    route: 'direct',
    rtt: 20,
    paths: ['direct'],
    joinedAt: 0,
    ...over,
  } as PeerInfo;
}

class FakeRoom implements RoomLike {
  readonly events = new Emitter<RoomEvents>();
  readonly peers = new Map<string, PeerInfo>();
  status: RoomStatus = 'online';
  readonly peerId = 'me'.padEnd(64, '0');
  constructor(readonly code = 'ABCDEFGHJK') {}
  on(event: string, listener: (...args: any[]) => void) {
    return this.events.on(event, listener);
  }
  getPeers() {
    return [...this.peers.values()];
  }
  pathInfo() {
    return [
      { name: 'direct', kind: 'direct', direct: true, up: true },
      { name: 'nostr', kind: 'nostr', direct: false, up: true },
      { name: 'mqtt', kind: 'mqtt', direct: false, up: false },
    ];
  }
  add(p: PeerInfo) {
    this.peers.set(p.id, p);
    this.events.emit('peer-join', p);
  }
  remove(id: string) {
    const p = this.peers.get(id)!;
    this.peers.delete(id);
    this.events.emit('peer-leave', p, 'bye');
  }
  update(id: string, over: Partial<PeerInfo>, event = 'route') {
    const p = { ...this.peers.get(id)!, ...over };
    this.peers.set(id, p);
    this.events.emit(event, p);
  }
  listeners() {
    return ['peer-join', 'peer-leave', 'route', 'status'].reduce((n, e) => n + this.events.listenerCount(e), 0);
  }
}

class FakeSync implements SyncLike {
  readonly events = new Emitter<DeviceSyncEvents>();
  status: SyncStatus = { state: 'off', at: null, relays: 0, error: null };
  key: string | null = null;
  linked: string[] = [];
  syncNow = vi.fn(async () => {
    this.set({ state: 'syncing' });
    this.set({ state: 'ok', at: Date.now(), relays: 3 });
    return this.status;
  });
  unlink = vi.fn(() => {
    this.key = null;
    this.set({ state: 'off', at: null, relays: 0, error: null });
  });
  async link(keyText: string) {
    const key = parseSyncKey(keyText);
    if (!key) return { ok: false, reason: 'bad-key' };
    this.key = key;
    this.linked.push(key);
    await this.syncNow();
    return { ok: true, status: this.status };
  }
  private set(next: Partial<SyncStatus>) {
    this.status = { ...this.status, ...next };
    this.events.emit('status', this.status);
  }
}

function mount<T extends HTMLElement>(tag: string, attrs: Record<string, string> = {}): T {
  const node = document.createElement(tag) as T;
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  document.body.append(node);
  return node;
}

function events(): HostlessRoomDetail[] {
  const got: HostlessRoomDetail[] = [];
  document.addEventListener('hostless-room', (e) => got.push((e as CustomEvent<HostlessRoomDetail>).detail));
  return got;
}

function setInput(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function submit(host: Element, form: string) {
  must<HTMLFormElement>(host, `form[data-form="${form}"]`).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

let clipboard: string[] = [];

beforeAll(() => {
  defineHostlessElements();
});

afterEach(() => {
  document.body.replaceChildren();
  history.replaceState(null, '', '/');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mockClipboard() {
  clipboard = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (t: string) => void clipboard.push(t) },
  });
}

describe('defineHostlessElements', () => {
  it('registers the four elements and is idempotent', () => {
    expect(customElements.get('hostless-lobby')).toBe(HostlessLobby);
    expect(customElements.get('hostless-link')).toBe(HostlessLink);
    expect(customElements.get('hostless-sync')).toBe(HostlessSync);
    expect(customElements.get('hostless-netcheck')).toBe(HostlessNetcheck);
    const again = defineHostlessElements();
    expect(again).toEqual({ lobby: 'hostless-lobby', link: 'hostless-link', sync: 'hostless-sync', netcheck: 'hostless-netcheck' });
    expect(customElements.get('hostless-lobby')).toBe(HostlessLobby);
  });

  it('supports a second prefix (with subclasses) and skips it the next time', () => {
    const names = defineHostlessElements('game');
    expect(names.lobby).toBe('game-lobby');
    const ctor = customElements.get('game-lobby')!;
    expect(new ctor()).toBeInstanceOf(HostlessLobby);
    expect(() => defineHostlessElements('game')).not.toThrow();
    expect(customElements.get('game-lobby')).toBe(ctor);
  });
});

describe('<hostless-lobby>', () => {
  it('create: dispatches hostless-room with a fresh 10-symbol code, role host and an invite link', async () => {
    const got = events();
    const lobby = mount<HostlessLobby>('hostless-lobby');
    expect(must(lobby, '[data-mode="create"]').getAttribute('aria-pressed')).toBe('true');
    must(lobby, '[data-action="create"]').click();
    expect(got).toHaveLength(1);
    const { code, role, link } = got[0];
    expect(code).toMatch(CODE_RE);
    expect(parseRoomCode(code)).toBe(code);
    expect(role).toBe('host');
    expect(link.endsWith(`#room=${code}`)).toBe(true);
    expect(parseRoomCode(link)).toBe(code);
    // the code is shown grouped, with a Copy link button; no Share without navigator.share
    expect(must(lobby, '[data-code]').textContent).toBe(`${code.slice(0, 5)}-${code.slice(5)}`);
    expect(q(lobby, '[data-action="share"]')).toBeNull();
    mockClipboard();
    must(lobby, '[data-action="copy"]').click();
    await flush();
    expect(clipboard).toEqual([link]);
    expect(must(lobby, '[data-notice]').textContent).toBe('Link copied.');
  });

  it('create: respects code-length and param, and offers Share when navigator.share exists', () => {
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    try {
      const got = events();
      const lobby = mount<HostlessLobby>('hostless-lobby', { param: 'game', 'code-length': '8' });
      must(lobby, '[data-action="create"]').click();
      expect(got[0].code).toHaveLength(8);
      expect(got[0].link.endsWith(`#game=${got[0].code}`)).toBe(true);
      must(lobby, '[data-action="share"]').click();
      expect(share).toHaveBeenCalledWith(expect.objectContaining({ url: got[0].link }));
    } finally {
      delete (navigator as { share?: unknown }).share;
    }
  });

  it('join: rejects an invalid code inline and accepts a link with #room=CODE', () => {
    const got = events();
    const lobby = mount<HostlessLobby>('hostless-lobby');
    must(lobby, '[data-mode="join"]').click();
    const input = must<HTMLInputElement>(lobby, 'input');
    setInput(input, 'HELLO-WORLD');
    submit(lobby, 'join');
    expect(got).toHaveLength(0);
    expect(must(lobby, '.error').textContent).toBe('That doesn’t look like a room code.');
    expect(must(lobby, 'input').getAttribute('aria-invalid')).toBe('true');
    // typing clears the error
    setInput(must<HTMLInputElement>(lobby, 'input'), 'https://example.com/game/#room=abcde-fghjk');
    expect(must(lobby, '.error').textContent).toBe('');
    submit(lobby, 'join');
    expect(got).toEqual([{ code: 'ABCDEFGHJK', role: 'guest', link: expect.stringMatching(/#room=ABCDEFGHJK$/) }]);
    expect(must(lobby, 'input').getAttribute('aria-invalid')).toBe('false');
  });

  it('join: an empty input asks for a code', () => {
    const lobby = mount<HostlessLobby>('hostless-lobby');
    expect(lobby.join('')).toBeNull();
    expect(must(lobby, '.error').textContent).toBe('Enter a room code or link.');
  });

  it('pre-fills join mode from #room= in the page URL', () => {
    history.replaceState(null, '', '/play#room=MNPQR-STUVW');
    const got = events();
    const lobby = mount<HostlessLobby>('hostless-lobby');
    expect(must(lobby, '[data-mode="join"]').getAttribute('aria-pressed')).toBe('true');
    expect(must<HTMLInputElement>(lobby, 'input').value).toBe('MNPQR-STUVW');
    expect(got).toHaveLength(0);
    submit(lobby, 'join');
    expect(got[0]).toMatchObject({ code: 'MNPQRSTUVW', role: 'guest' });
  });

  it('renders players from a room and follows peer-join / peer-leave', () => {
    const room = new FakeRoom();
    const lobby = mount<HostlessLobby>('hostless-lobby');
    lobby.room = room;
    expect(must(lobby, '[data-summary]').textContent).toBe('Waiting for players…');
    expect(must(lobby, '[data-code]').textContent).toBe('ABCDE-FGHJK');
    room.add(peer('a'.repeat(64), { meta: { name: 'Ann' }, route: 'direct', rtt: 12.4 }));
    room.add(peer('b'.repeat(64), { route: 'relay', rtt: 140, state: 'away' }));
    const items = qa(lobby, '[data-peer]');
    expect(items).toHaveLength(2);
    expect(items[0].querySelector('.name')!.textContent).toBe('Ann');
    expect(items[0].querySelector('[data-route]')!.getAttribute('data-route')).toBe('direct');
    expect(items[0].textContent).toContain('12 ms');
    expect(items[1].querySelector('.name')!.textContent).toBe('bbbbbbbb');
    expect(items[1].querySelector('[data-state]')!.textContent).toBe('away');
    expect(items[1].querySelector('[data-route]')!.getAttribute('data-route')).toBe('relay');
    expect(must(lobby, '[data-summary]').textContent).toBe('Players: 2');
    room.remove('a'.repeat(64));
    expect(qa(lobby, '[data-peer]')).toHaveLength(1);
    room.remove('b'.repeat(64));
    expect(qa(lobby, '[data-peer]')).toHaveLength(0);
    expect(must(lobby, '[data-summary]').textContent).toBe('Waiting for players…');
  });

  it('renders peer names as text, never as markup', () => {
    const room = new FakeRoom();
    const lobby = mount<HostlessLobby>('hostless-lobby');
    lobby.room = room;
    const evil = '<img src=x onerror=alert(1)>';
    room.add(peer('c'.repeat(64), { meta: { name: evil } }));
    expect(q(lobby, 'img')).toBeNull();
    expect(must(lobby, '[data-peer] .name').textContent).toBe(evil);
    const link = mount<HostlessLink>('hostless-link');
    link.room = room;
    expect(q(link, 'img')).toBeNull();
  });

  it('unsubscribes when the room changes and when removed', () => {
    const a = new FakeRoom();
    const b = new FakeRoom('MNPQRSTUVW');
    const lobby = mount<HostlessLobby>('hostless-lobby');
    lobby.room = a;
    expect(a.listeners()).toBeGreaterThan(0);
    lobby.room = b;
    expect(a.listeners()).toBe(0);
    expect(b.listeners()).toBeGreaterThan(0);
    a.add(peer('d'.repeat(64)));
    expect(qa(lobby, '[data-peer]')).toHaveLength(0);
    lobby.remove();
    expect(b.listeners()).toBe(0);
    // re-attached: listening again
    document.body.append(lobby);
    expect(b.listeners()).toBeGreaterThan(0);
    b.add(peer('e'.repeat(64)));
    expect(qa(lobby, '[data-peer]')).toHaveLength(1);
  });

  it('a room whose getPeers throws does not break the element', () => {
    const room = new FakeRoom();
    room.getPeers = () => {
      throw new Error('boom');
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const lobby = mount<HostlessLobby>('hostless-lobby');
    expect(() => {
      lobby.room = room;
      room.events.emit('peer-join', peer('f'.repeat(64)));
    }).not.toThrow();
    expect(must(lobby, '[data-summary]').textContent).toBe('Waiting for players…');
  });

  it('speaks Russian with lang="ru"', () => {
    const lobby = mount<HostlessLobby>('hostless-lobby', { lang: 'ru' });
    expect(must(lobby, '[data-action="create"]').textContent).toBe('Создать комнату');
    lobby.setAttribute('lang', 'en');
    expect(must(lobby, '[data-action="create"]').textContent).toBe('Create room');
  });
});

describe('<hostless-link>', () => {
  it('shows status, relay vs direct per peer, rtt and the paths tooltip', () => {
    const room = new FakeRoom();
    room.peers.set('a'.repeat(64), peer('a'.repeat(64), { route: 'direct', rtt: 18 }));
    const link = mount<HostlessLink>('hostless-link');
    link.room = room;
    expect(must(link, '.pill').getAttribute('data-status')).toBe('online');
    expect(must(link, '.state').textContent).toBe('online');
    expect(qa(link, '[data-route="direct"]')).toHaveLength(1);
    expect(text(link)).toContain('18 ms');
    expect(link.title).toContain('nostr (relay): up');
    expect(link.title).toContain('mqtt (relay): down');
    expect(link.title).toContain('direct (direct): up');

    room.update('a'.repeat(64), { route: 'relay', rtt: 95 });
    expect(qa(link, '[data-route="direct"]')).toHaveLength(0);
    expect(must(link, '[data-route="relay"]').className).toContain('route-relay');
    expect(text(link)).toContain('95 ms');

    room.add(peer('b'.repeat(64), { route: null, rtt: null }));
    expect(qa(link, '[data-route="none"]')).toHaveLength(1);

    room.status = 'offline';
    room.events.emit('status', 'offline');
    expect(must(link, '.state').className).toContain('status-offline');
  });

  it('refreshes every 2 s and stops the timer when disconnected', () => {
    vi.useFakeTimers();
    const room = new FakeRoom();
    room.peers.set('a'.repeat(64), peer('a'.repeat(64), { rtt: 30 }));
    const link = mount<HostlessLink>('hostless-link');
    link.room = room;
    expect(text(link)).toContain('30 ms');
    room.peers.set('a'.repeat(64), peer('a'.repeat(64), { rtt: 44 })); // no event
    vi.advanceTimersByTime(2000);
    expect(text(link)).toContain('44 ms');
    link.remove();
    expect(vi.getTimerCount()).toBe(0);
    expect(room.listeners()).toBe(0);
  });
});

describe('<hostless-sync>', () => {
  it('link devices → linked view → copy, sync now, unlink with an in-panel confirm', async () => {
    mockClipboard();
    const sync = new FakeSync();
    const panel = mount<HostlessSync>('hostless-sync');
    panel.sync = sync;
    expect(must(panel, '[data-state]').textContent).toBe('Sync is off');
    must(panel, '[data-action="link-new"]').click();
    await flush();
    expect(sync.linked).toHaveLength(1);
    const key = sync.key!;
    expect(parseSyncKey(key)).toBe(key);
    expect(must(panel, '[data-key]').getAttribute('data-key')).toBe(key);
    expect(must(panel, '[data-key]').textContent).toBe(key.match(/.{4}/g)!.join('-'));
    expect(must(panel, '[data-state]').getAttribute('data-state')).toBe('ok');
    expect(must(panel, '[data-state]').textContent).toMatch(/^Synced/);

    must(panel, '[data-action="copy"]').click();
    await flush();
    expect(clipboard).toHaveLength(1);
    expect(clipboard[0].endsWith(`#sync=${key}`)).toBe(true);
    expect(clipboard[0].split('#')).toHaveLength(2);

    sync.syncNow.mockClear();
    must(panel, '[data-action="sync-now"]').click();
    await flush();
    expect(sync.syncNow).toHaveBeenCalledTimes(1);

    const confirmSpy = vi.fn(() => true);
    (globalThis as { confirm?: unknown }).confirm = confirmSpy;
    must(panel, '[data-action="unlink"]').click();
    expect(q(panel, '[data-confirm]')).not.toBeNull();
    expect(sync.unlink).not.toHaveBeenCalled();
    must(panel, '[data-action="cancel-unlink"]').click();
    expect(q(panel, '[data-confirm]')).toBeNull();
    expect(sync.key).toBe(key);
    must(panel, '[data-action="unlink"]').click();
    must(panel, '[data-action="confirm-unlink"]').click();
    expect(sync.unlink).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(sync.key).toBeNull();
    expect(q(panel, '[data-action="link-new"]')).not.toBeNull();
    expect(must(panel, '[data-state]').textContent).toBe('Sync is off');
  });

  it('enter key: rejects a bad key, accepts a #sync= link', async () => {
    const sync = new FakeSync();
    const panel = mount<HostlessSync>('hostless-sync');
    panel.sync = sync;
    must(panel, '[data-action="enter-key"]').click();
    setInput(must<HTMLInputElement>(panel, 'input'), 'not-a-key');
    submit(panel, 'key');
    await flush();
    expect(must(panel, '.error').textContent).toBe('That key isn’t valid.');
    expect(sync.linked).toHaveLength(0);
    const key = newSyncKey();
    setInput(must<HTMLInputElement>(panel, 'input'), `https://example.com/clicker/#sync=${key}`);
    submit(panel, 'key');
    await flush();
    expect(sync.linked).toEqual([key]);
    expect(must(panel, '[data-key]').getAttribute('data-key')).toBe(key);
  });

  it('shows a text for every sync state', () => {
    const sync = new FakeSync();
    const panel = mount<HostlessSync>('hostless-sync', { lang: 'ru' });
    panel.sync = sync;
    const seen = new Set<string>();
    for (const state of ['off', 'syncing', 'ok', 'offline', 'unreadable', 'outdated', 'error', 'paused'] as const) {
      sync.status = { state, at: null, relays: 0, error: null };
      sync.events.emit('status', sync.status);
      const shown = must(panel, '[data-state]');
      expect(shown.getAttribute('data-state')).toBe(state);
      expect(shown.textContent).not.toMatch(/sync_/);
      seen.add(shown.textContent!);
    }
    expect(seen.size).toBe(8);
  });
});

describe('<hostless-netcheck>', () => {
  const report: NetworkReport = {
    nostr: [
      { url: 'wss://relay.one', ok: true, connectMs: 41.2, echoMs: 88, error: null },
      { url: 'wss://relay.two', ok: false, connectMs: null, echoMs: null, error: 'timeout' },
    ],
    mqtt: [{ url: 'wss://broker.example/mqtt', ok: true, connectMs: 60, echoMs: 120, error: null }],
    webrtc: { available: true, nat: 'cone', candidates: [] },
    summary: { relays: 2, direct: 'likely', ok: true },
  };

  it('renders the report from an injected check function', async () => {
    const check = vi.fn(async () => report);
    const el = mount<HostlessNetcheck>('hostless-netcheck');
    el.options = { timeoutMs: 1234 };
    el.check = check;
    must(el, '[data-action="check"]').click();
    expect(must(el, '[data-action="check"]').textContent).toBe('Checking…');
    await flush();
    expect(check).toHaveBeenCalledWith({ timeoutMs: 1234 });
    const rows = qa(el, 'tbody tr');
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('wss://relay.one');
    expect(rows[0].textContent).toContain('ok');
    expect(rows[0].textContent).toContain('41 ms');
    expect(rows[0].textContent).toContain('88 ms');
    expect(rows[1].getAttribute('data-ok')).toBe('false');
    expect(rows[1].textContent).toContain('fail');
    expect(rows[1].textContent).toContain('timeout');
    expect(must(el, '[data-webrtc]').textContent).toBe('available');
    expect(must(el, '[data-nat]').textContent).toBe('cone');
    expect(must(el, '[data-verdict]').getAttribute('data-verdict')).toBe('ok');
    expect(must(el, '[data-action="check"]').textContent).toBe('Check connection');
  });

  it('shows a failed check instead of throwing', async () => {
    const el = mount<HostlessNetcheck>('hostless-netcheck');
    el.check = async () => {
      throw new Error('no network');
    };
    await expect(el.run()).resolves.toBeNull();
    expect(must(el, '.error').textContent).toBe('Check failed: no network');
  });
});
