/**
 * `<hostless-sync>`: link devices without an account. Shows the sync status; when unlinked offers
 * "Link devices" (a fresh key) and "Enter key"; when linked shows the key, a copyable `#sync=` link,
 * "Sync now" and "Unlink" (with an in-panel confirm step).
 *
 *   attributes  lang="en|ru"
 *   property    sync: DeviceSync | null
 */
import { formatSyncKey, inviteLink, newSyncKey, parseSyncKey } from '../code.js';
import type { SyncState, SyncStatus } from '../sync/device-sync.js';
import type { Unsubscribe } from '../util/emitter.js';
import type { StringKey } from './i18n.js';
import { HostlessElement, copyText, el, pageBase, pageHref, report, safe, type SyncLike } from './base.js';

const STATES: readonly SyncState[] = ['off', 'syncing', 'ok', 'offline', 'unreadable', 'outdated', 'error', 'paused'];

let counter = 0;

export class HostlessSync extends HostlessElement {
  private _sync: SyncLike | null = null;
  private offSync: Unsubscribe | null = null;
  private entering = false;
  private confirming = false;
  private busy = false;
  private keyError = '';
  private notice = '';
  private started = false;
  private keyInput: HTMLInputElement | null = null;
  private readonly uid = `hl-sync-${++counter}`;

  get sync(): SyncLike | null {
    return this._sync;
  }

  set sync(sync: SyncLike | null | undefined) {
    const next = sync ?? null;
    if (next === this._sync) return;
    this.offSync?.();
    this.offSync = null;
    this._sync = next;
    this.confirming = false;
    this.keyError = '';
    this.notice = '';
    if (this.connected) this.subscribe();
    this.refresh();
  }

  protected override attached(): void {
    if (!this.started) {
      this.started = true;
      // a `#sync=KEY` link opened on this device pre-fills the key form
      const fromLink = parseSyncKey(pageHref());
      if (fromLink) {
        this.entering = true;
        this.input().value = formatSyncKey(fromLink);
      }
    }
    this.subscribe();
  }

  protected override detached(): void {
    this.offSync?.();
    this.offSync = null;
  }

  private subscribe(): void {
    const sync = this._sync;
    if (!sync || this.offSync) return;
    try {
      const off = sync.events?.on('status', safe(() => this.refresh()));
      this.offSync = typeof off === 'function' ? off : null;
    } catch (error) {
      report(error);
    }
  }

  private currentKey(): string | null {
    try {
      const key = this._sync?.key ?? null;
      return key && parseSyncKey(key) ? key : null;
    } catch {
      return null;
    }
  }

  private currentStatus(): SyncStatus {
    try {
      const s = this._sync?.status;
      if (s && STATES.includes(s.state)) return s;
    } catch {
      /* fall through */
    }
    return { state: 'off', at: null, relays: 0, error: null };
  }

  private input(): HTMLInputElement {
    this.keyInput ??= el('input', {
      attrs: { id: `${this.uid}-key`, type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'data-focus': 'key-input' },
      on: {
        input: () => {
          if (!this.keyError) return;
          this.keyError = '';
          this.refresh();
        },
      },
    });
    return this.keyInput;
  }

  private statusText(status: SyncStatus): string {
    if (status.state === 'ok' && typeof status.at === 'number' && status.at > 0) {
      try {
        const time = new Date(status.at).toLocaleTimeString(this.locale, { hour: '2-digit', minute: '2-digit' });
        return this.t('sync_okAt', { time });
      } catch {
        /* no Intl */
      }
    }
    return this.t(`sync_${status.state}` as StringKey);
  }

  /** Link with a fresh key (the "Link devices" button). */
  async linkNew(): Promise<boolean> {
    return this.linkWith(newSyncKey());
  }

  /** Link with a key or `#sync=` link typed by the user (the "Enter key" form). */
  async linkWith(text: string = this.input().value): Promise<boolean> {
    const sync = this._sync;
    if (!sync || this.busy) return false;
    const raw = String(text ?? '').trim();
    const key = raw ? parseSyncKey(raw) : null;
    if (!key) {
      this.keyError = this.t(raw ? 'badKey' : 'emptyKey');
      this.refresh();
      return false;
    }
    this.busy = true;
    this.keyError = '';
    this.refresh();
    let ok = false;
    try {
      const result = await sync.link(key);
      ok = !!result?.ok;
      if (!ok) this.keyError = this.t(result?.reason === 'bad-key' ? 'badKey' : result?.reason === 'storage' ? 'storageFail' : 'linkFailed');
    } catch (error) {
      report(error);
      this.keyError = this.t('linkFailed');
    } finally {
      this.busy = false;
    }
    if (ok) {
      this.entering = false;
      this.input().value = '';
    }
    this.refresh();
    return ok;
  }

  /** Unlink this device right away (the confirmed "Unlink" button). */
  unlink(): void {
    this.confirming = false;
    this.notice = '';
    try {
      this._sync?.unlink();
    } catch (error) {
      report(error);
    }
    this.refresh();
  }

  private syncNow(): void {
    const sync = this._sync;
    if (!sync) return;
    try {
      void Promise.resolve(sync.syncNow()).then(undefined, report).finally(() => this.refresh());
    } catch (error) {
      report(error);
    }
    this.refresh();
  }

  private async copy(link: string): Promise<void> {
    const ok = await copyText(link);
    this.notice = this.t(ok ? 'copied' : 'copyFailed');
    this.refresh();
  }

  private button(key: StringKey, action: string, onClick: () => unknown, cls = '', disabled = false): HTMLButtonElement {
    return el('button', { class: cls, text: this.t(key), attrs: { type: 'button', 'data-action': action, 'data-focus': action, disabled }, on: { click: onClick } });
  }

  private unlinkedView(): HTMLElement[] {
    const parts: HTMLElement[] = [el('p', { class: 'muted', text: this.t('syncIntro') })];
    if (!this.entering) {
      parts.push(
        el(
          'div',
          { class: 'row' },
          this.button('linkDevices', 'link-new', () => this.linkNew(), 'primary', this.busy || !this._sync),
          this.button('enterKey', 'enter-key', () => {
            this.entering = true;
            this.refresh();
            this.input().focus();
          }, '', !this._sync),
        ),
      );
      if (this.keyError) parts.push(el('p', { class: 'error', text: this.keyError, attrs: { role: 'alert' } }));
      return parts;
    }
    const input = this.input();
    const errorId = `${this.uid}-error`;
    input.setAttribute('placeholder', this.t('keyPlaceholder'));
    input.setAttribute('aria-invalid', String(!!this.keyError));
    if (this.keyError) input.setAttribute('aria-describedby', errorId);
    else input.removeAttribute('aria-describedby');
    parts.push(
      el(
        'form',
        {
          class: 'stack',
          attrs: { novalidate: true, 'data-form': 'key' },
          on: {
            submit: (e) => {
              e.preventDefault();
              return this.linkWith();
            },
          },
        },
        el('label', { text: this.t('keyLabel'), attrs: { for: input.id } }),
        input,
        el(
          'div',
          { class: 'row' },
          el('button', { class: 'primary', text: this.t('submitKey'), attrs: { type: 'submit', 'data-action': 'submit-key', 'data-focus': 'submit-key', disabled: this.busy || !this._sync } }),
          this.button('cancel', 'cancel-key', () => {
            this.entering = false;
            this.keyError = '';
            this.refresh();
          }),
        ),
        el('p', { class: 'error', text: this.keyError, attrs: { id: errorId, role: 'alert' } }),
      ),
    );
    return parts;
  }

  private linkedView(key: string, status: SyncStatus): HTMLElement[] {
    const link = inviteLink(key, { param: 'sync', base: pageBase() });
    const parts: HTMLElement[] = [
      el(
        'div',
        { class: 'stack' },
        el('span', { class: 'muted', text: this.t('yourKey') }),
        el('div', { class: 'code', text: formatSyncKey(key), attrs: { 'data-key': key } }),
        el('p', { class: 'muted', text: this.t('keyHint') }),
      ),
    ];
    if (this.confirming) {
      parts.push(
        el(
          'div',
          { class: 'stack', attrs: { role: 'group', 'data-confirm': '' } },
          el('p', { text: this.t('unlinkConfirm') }),
          el('div', { class: 'row' }, this.button('unlink', 'confirm-unlink', () => this.unlink(), 'danger'), this.button('cancel', 'cancel-unlink', () => {
            this.confirming = false;
            this.refresh();
          })),
        ),
      );
    } else {
      parts.push(
        el(
          'div',
          { class: 'row' },
          this.button('copyLink', 'copy', () => this.copy(link), 'primary'),
          this.button('syncNow', 'sync-now', () => this.syncNow(), '', status.state === 'syncing'),
          this.button('unlink', 'unlink', () => {
            this.confirming = true;
            this.refresh();
          }),
        ),
      );
    }
    return parts;
  }

  protected render(): void {
    const status = this.currentStatus();
    const key = this.currentKey();
    if (!key) this.confirming = false;
    const cls = status.state === 'ok' ? 'is-ok' : status.state === 'syncing' || status.state === 'paused' ? 'is-warn' : status.state === 'off' ? 'muted' : 'is-bad';
    const head = el(
      'p',
      { attrs: { role: 'status', 'aria-live': 'polite', 'data-state': status.state } },
      el('span', { class: `badge ${cls}` }, el('span', { class: 'dot', attrs: { 'aria-hidden': 'true' } }), this.statusText(status)),
    );
    const body = key ? this.linkedView(key, status) : this.unlinkedView();
    const notice = el('p', { class: 'muted', text: this.notice, attrs: { 'aria-live': 'polite', 'data-notice': '' } });
    this.mount(el('div', { class: 'card', attrs: { part: 'card' } }, head, ...body, notice));
  }
}
