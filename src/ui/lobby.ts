/**
 * `<hostless-lobby>`: create a room (fresh code + invite link) or join one (code or link), then,
 * once the page sets `.room`, a live player list.
 *
 *   attributes  param="room"  code-length="10"  lang="en|ru"
 *   property    room: Room | null
 *   event       hostless-room  { code, role: 'host' | 'guest', link }  (bubbles, composed)
 */
import { formatCode, inviteLink, newRoomCode, parseRoomCode, ROOM_CODE_LENGTH } from '../code.js';
import type { PeerInfo } from '../room/room.js';
import type { Unsubscribe } from '../util/emitter.js';
import {
  HostlessElement,
  ROOM_EVENTS,
  canShare,
  copyText,
  el,
  pageBase,
  pageHref,
  peerName,
  peersOf,
  report,
  routeBadge,
  subscribeRoom,
  type RoomLike,
} from './base.js';

export interface HostlessRoomDetail {
  code: string;
  role: 'host' | 'guest';
  link: string;
}

type Mode = 'create' | 'join';

let counter = 0;

export class HostlessLobby extends HostlessElement {
  static override get observedAttributes(): string[] {
    return ['lang', 'param', 'code-length'];
  }

  private mode: Mode = 'create';
  private created: string | null = null;
  private joinError = '';
  private notice = '';
  private started = false;
  private _room: RoomLike | null = null;
  private offRoom: Unsubscribe | null = null;
  private readonly uid = `hl-lobby-${++counter}`;
  private joinInput: HTMLInputElement | null = null;
  private peersBox: HTMLElement | null = null;

  /** the link parameter that carries the code (`#room=CODE`) */
  get param(): string {
    return (this.getAttribute('param') ?? '').trim() || 'room';
  }

  get codeLength(): number {
    const n = Number.parseInt(this.getAttribute('code-length') ?? '', 10);
    return Number.isFinite(n) && n >= 4 && n <= 64 ? n : ROOM_CODE_LENGTH;
  }

  get room(): RoomLike | null {
    return this._room;
  }

  set room(room: RoomLike | null | undefined) {
    const next = room ?? null;
    if (next === this._room) return;
    this.unsubscribe();
    this._room = next;
    if (this.connected) this.subscribe();
    this.refresh();
  }

  /** the code this lobby created, if any */
  get code(): string | null {
    return this.created;
  }

  protected override attached(): void {
    if (!this.started) {
      this.started = true;
      const href = pageHref();
      const fromLink = href ? parseRoomCode(href, { param: this.param, length: this.codeLength }) : null;
      if (fromLink) {
        this.mode = 'join';
        this.input().value = formatCode(fromLink);
      }
    }
    this.subscribe();
  }

  protected override detached(): void {
    this.unsubscribe();
  }

  private subscribe(): void {
    if (!this._room || this.offRoom) return;
    this.offRoom = subscribeRoom(this._room, ROOM_EVENTS, () => this.renderPeers());
  }

  private unsubscribe(): void {
    const off = this.offRoom;
    this.offRoom = null;
    off?.();
  }

  private input(): HTMLInputElement {
    if (!this.joinInput) {
      this.joinInput = el('input', {
        attrs: {
          id: `${this.uid}-input`,
          type: 'text',
          autocomplete: 'off',
          autocapitalize: 'characters',
          spellcheck: 'false',
          enterkeyhint: 'go',
          'data-focus': 'join-input',
        },
        on: {
          input: () => {
            if (!this.joinError) return;
            this.joinError = '';
            this.refresh();
          },
        },
      });
    }
    return this.joinInput;
  }

  private link(code: string): string {
    return inviteLink(code, { param: this.param, base: pageBase() });
  }

  private emit(detail: HostlessRoomDetail): void {
    try {
      this.dispatchEvent(new CustomEvent<HostlessRoomDetail>('hostless-room', { detail, bubbles: true, composed: true }));
    } catch (error) {
      report(error);
    }
  }

  /** Create a room now (as the "Create room" button does) and return its code. */
  create(): string {
    const code = newRoomCode(this.codeLength);
    this.created = code;
    this.notice = '';
    this.mode = 'create';
    this.refresh();
    this.emit({ code, role: 'host', link: this.link(code) });
    return code;
  }

  /** Join with a code or link (as the "Join" form does); null and an inline error when invalid. */
  join(value: string = this.input().value): string | null {
    const text = String(value ?? '').trim();
    const code = text ? parseRoomCode(text, { param: this.param, length: this.codeLength }) : null;
    if (!code) {
      this.joinError = this.t(text ? 'badCode' : 'emptyCode');
      this.mode = 'join';
      this.refresh();
      return null;
    }
    this.joinError = '';
    this.input().value = formatCode(code);
    this.refresh();
    this.emit({ code, role: 'guest', link: this.link(code) });
    return code;
  }

  private setMode(mode: Mode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.notice = '';
    this.refresh();
  }

  private async copy(link: string): Promise<void> {
    const ok = await copyText(link);
    this.notice = this.t(ok ? 'copied' : 'copyFailed');
    this.refresh();
  }

  private async share(link: string): Promise<void> {
    try {
      await globalThis.navigator?.share?.({ title: this.t('shareText'), text: this.t('shareText'), url: link });
    } catch {
      /* dismissed or refused */
    }
  }

  private inviteBlock(code: string): HTMLElement {
    const link = this.link(code);
    const field = el('input', {
      attrs: { type: 'text', readonly: true, value: link, 'aria-label': this.t('linkField'), class: 'mono', 'data-focus': 'invite' },
      on: { focus: (e) => (e.target as HTMLInputElement).select?.() },
    });
    field.value = link;
    return el(
      'div',
      { class: 'stack' },
      el('span', { class: 'muted', text: this.t('codeLabel') }),
      el('div', { class: 'code', text: formatCode(code), attrs: { 'data-code': code } }),
      el('p', { class: 'muted', text: this.t('inviteHint') }),
      field,
      el(
        'div',
        { class: 'row' },
        el('button', { class: 'primary', text: this.t('copyLink'), attrs: { type: 'button', 'data-action': 'copy', 'data-focus': 'copy' }, on: { click: () => this.copy(link) } }),
        canShare()
          ? el('button', { text: this.t('share'), attrs: { type: 'button', 'data-action': 'share', 'data-focus': 'share' }, on: { click: () => this.share(link) } })
          : null,
      ),
    );
  }

  private formView(): HTMLElement[] {
    const tabs = el(
      'div',
      { class: 'segmented', attrs: { role: 'group', 'aria-label': this.t('modes') } },
      el('button', {
        text: this.t('newRoom'),
        attrs: { type: 'button', 'aria-pressed': String(this.mode === 'create'), 'data-mode': 'create', 'data-focus': 'mode-create' },
        on: { click: () => this.setMode('create') },
      }),
      el('button', {
        text: this.t('join'),
        attrs: { type: 'button', 'aria-pressed': String(this.mode === 'join'), 'data-mode': 'join', 'data-focus': 'mode-join' },
        on: { click: () => this.setMode('join') },
      }),
    );
    let panel: HTMLElement;
    if (this.mode === 'create') {
      panel = this.created
        ? this.inviteBlock(this.created)
        : el('div', { class: 'row' }, el('button', { class: 'primary grow', text: this.t('create'), attrs: { type: 'button', 'data-action': 'create', 'data-focus': 'create' }, on: { click: () => this.create() } }));
    } else {
      const input = this.input();
      const errorId = `${this.uid}-error`;
      input.setAttribute('placeholder', this.t('inputPlaceholder'));
      input.setAttribute('aria-invalid', String(!!this.joinError));
      if (this.joinError) input.setAttribute('aria-describedby', errorId);
      else input.removeAttribute('aria-describedby');
      panel = el(
        'form',
        {
          class: 'stack',
          attrs: { novalidate: true, 'data-form': 'join' },
          on: {
            submit: (e) => {
              e.preventDefault();
              this.join();
            },
          },
        },
        el('label', { text: this.t('inputLabel'), attrs: { for: input.id } }),
        el('div', { class: 'row' }, el('div', { class: 'grow' }, input), el('button', { class: 'primary', text: this.t('joinRoom'), attrs: { type: 'submit', 'data-focus': 'join' } })),
        el('p', { class: 'error', text: this.joinError, attrs: { id: errorId, role: 'alert' } }),
      );
    }
    return [tabs, panel];
  }

  private peersSection(): HTMLElement {
    this.peersBox ??= el('div', { class: 'stack', attrs: { 'data-peers': '' } });
    this.renderPeers();
    return this.peersBox;
  }

  private renderPeers(): void {
    const box = this.peersBox;
    if (!box || !this.connected) return;
    try {
      const peers = peersOf(this._room);
      const items = peers.map((peer) => this.peerItem(peer));
      const nodes: Node[] = [
        el('h3', { text: this.t('players') }),
        el('p', { class: 'muted', text: peers.length ? this.t('playersCount', { n: peers.length }) : this.t('waiting'), attrs: { 'aria-live': 'polite', 'data-summary': '' } }),
      ];
      if (items.length) nodes.push(el('ul', { class: 'list' }, ...items));
      box.replaceChildren(...nodes);
    } catch (error) {
      report(error);
    }
  }

  private peerItem(peer: PeerInfo): HTMLLIElement {
    const away = peer.state === 'away';
    return el(
      'li',
      { class: 'peer', attrs: { 'data-peer': String(peer.id ?? '') } },
      el('span', { class: 'name', text: peerName(peer), attrs: { title: peerName(peer) } }),
      el('span', { class: away ? 'muted is-warn' : 'muted', text: this.t(away ? 'peerAway' : 'peerConnected'), attrs: { 'data-state': away ? 'away' : 'connected' } }),
      routeBadge((k, v) => this.t(k, v), peer),
    );
  }

  protected render(): void {
    const room = this._room;
    const roomCode = room ? (parseRoomCode(room.code ?? '', { param: this.param, length: this.codeLength }) ?? this.created) : null;
    const status = el('p', { class: 'muted', text: this.notice, attrs: { role: 'status', 'aria-live': 'polite', 'data-notice': '' } });
    const body: Array<HTMLElement | null> = room
      ? [roomCode ? this.inviteBlock(roomCode) : null, status, this.peersSection()]
      : [...this.formView(), status];
    this.mount(el('div', { class: 'card', attrs: { part: 'card' } }, ...body));
  }
}
