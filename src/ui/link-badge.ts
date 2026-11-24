/**
 * `<hostless-link>`: a small pill with the room status and, per peer, the route (direct = green,
 * relay = amber, none = grey) and rtt. The tooltip lists the room's paths.
 *
 *   attributes  lang="en|ru"
 *   property    room: Room | null
 */
import type { Unsubscribe } from '../util/emitter.js';
import { HostlessElement, ROOM_EVENTS, el, peerName, peersOf, report, routeBadge, routeKind, rttText, statusOf, subscribeRoom, type RoomLike } from './base.js';
import { LINK_CSS } from './styles.js';

const REFRESH_MS = 2000;

export class HostlessLink extends HostlessElement {
  private _room: RoomLike | null = null;
  private offRoom: Unsubscribe | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private signature = '';
  /** persistent screen-reader region: announces status changes only, not rtt ticks */
  private live: HTMLSpanElement | null = null;

  constructor() {
    super();
    this.css = LINK_CSS;
  }

  get room(): RoomLike | null {
    return this._room;
  }

  set room(room: RoomLike | null | undefined) {
    const next = room ?? null;
    if (next === this._room) return;
    this.offRoom?.();
    this.offRoom = null;
    this._room = next;
    if (this.connected) this.subscribe();
    this.refresh();
  }

  protected override attached(): void {
    this.subscribe();
    if (!this.timer) this.timer = setInterval(() => this.refresh(), REFRESH_MS);
  }

  protected override detached(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.offRoom?.();
    this.offRoom = null;
  }

  private subscribe(): void {
    if (!this._room || this.offRoom) return;
    this.offRoom = subscribeRoom(this._room, ROOM_EVENTS, () => this.refresh());
  }

  private tooltip(): string {
    const room = this._room;
    if (!room) return '';
    let paths: ReturnType<NonNullable<RoomLike['pathInfo']>> = [];
    try {
      paths = typeof room.pathInfo === 'function' ? (room.pathInfo() ?? []) : [];
    } catch (error) {
      report(error);
    }
    const lines = paths.map((p) => `${p.name} (${p.direct ? this.t('direct') : this.t('relay')}): ${this.t(p.up ? 'pathUp' : 'pathDown')}`);
    return `${this.t('paths')}:\n${lines.length ? lines.join('\n') : this.t('noPaths')}`;
  }

  protected render(): void {
    const room = this._room;
    const status = statusOf(room);
    const statusText = room ? this.t(`status_${status}`) : this.t('status_offline');
    const peers = peersOf(room);
    const t = this.t.bind(this);
    const label = [
      `${this.t('connection')}: ${statusText}`,
      ...peers.map((p) => {
        const kind = routeKind(p);
        const rtt = rttText(t, p);
        return `${peerName(p)}: ${this.t(kind === 'direct' ? 'direct' : kind === 'relay' ? 'relay' : 'noRoute')}${rtt ? ` ${rtt}` : ''}`;
      }),
    ].join(', ');
    const title = this.tooltip();
    const signature = JSON.stringify([this.locale, label, title, peers.map((p) => routeKind(p))]);
    if (signature === this.signature && this.root.childNodes.length) return;
    this.signature = signature;
    if (title) this.setAttribute('title', title);
    else this.removeAttribute('title');
    this.live ??= el('span', { class: 'sr-only', attrs: { role: 'status', 'aria-live': 'polite' } });
    if (this.live.textContent !== `${this.t('connection')}: ${statusText}`) this.live.textContent = `${this.t('connection')}: ${statusText}`;
    this.mount(
      this.live,
      el(
        'span',
        { class: 'pill', attrs: { part: 'pill', role: 'img', 'aria-label': label, title: title || null, 'data-status': room ? status : 'none' } },
        el('span', { class: `state status-${room ? status : 'offline'}` }, el('span', { class: 'dot', attrs: { 'aria-hidden': 'true' } }), statusText),
        peers.length
          ? el(
              'span',
              { class: 'peers', attrs: { 'aria-hidden': 'true' } },
              ...peers.map((p) => {
                const badge = routeBadge(t, p);
                badge.setAttribute('title', peerName(p));
                badge.setAttribute('data-peer', String(p.id ?? ''));
                return badge;
              }),
            )
          : null,
      ),
    );
  }
}
