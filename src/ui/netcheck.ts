/**
 * `<hostless-netcheck>`: a "Check connection" button that runs checkNetwork() and shows a compact
 * report (each relay/broker, WebRTC availability, NAT type, verdict).
 *
 *   attributes  lang="en|ru"
 *   properties  options: CheckOptions (passed to checkNetwork)
 *               check: (options) => Promise<NetworkReport>  (replaces checkNetwork, e.g. in tests)
 *   method      run(): Promise<NetworkReport | null>
 *   event       hostless-netcheck  { report }  (bubbles, composed) after each finished check
 */
import { checkNetwork, type CheckOptions, type EndpointResult, type NetworkReport } from '../diag/check.js';
import { HostlessElement, el, report } from './base.js';
import { TABLE_CSS } from './styles.js';

export class HostlessNetcheck extends HostlessElement {
  options: CheckOptions | null = null;
  check: ((options: CheckOptions) => Promise<NetworkReport>) | null = null;
  private running = false;
  private result: NetworkReport | null = null;
  private failure: string | null = null;

  constructor() {
    super();
    this.css = TABLE_CSS;
  }

  get report(): NetworkReport | null {
    return this.result;
  }

  /** Run the check (as the button does). Resolves with the report, or null when it failed. */
  async run(): Promise<NetworkReport | null> {
    if (this.running) return null;
    this.running = true;
    this.failure = null;
    this.refresh();
    try {
      const fn = typeof this.check === 'function' ? this.check : checkNetwork;
      const result = await fn(this.options ?? {});
      this.result = result;
      try {
        this.dispatchEvent(new CustomEvent('hostless-netcheck', { detail: { report: result }, bubbles: true, composed: true }));
      } catch (error) {
        report(error);
      }
      return result;
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      return null;
    } finally {
      this.running = false;
      this.refresh();
    }
  }

  private ms(value: number | null | undefined): string {
    return typeof value === 'number' && Number.isFinite(value) ? this.t('ms', { n: Math.round(value) }) : '—';
  }

  private row(kind: string, r: EndpointResult): HTMLTableRowElement {
    return el(
      'tr',
      { attrs: { 'data-endpoint': r.url, 'data-ok': String(!!r.ok) } },
      el('td', { class: 'url mono', attrs: { title: kind } }, String(r.url ?? '')),
      el('td', { class: r.ok ? 'is-ok' : 'is-bad', text: this.t(r.ok ? 'ok' : 'fail') }),
      el('td', { class: 'num', text: this.ms(r.connectMs) }),
      el('td', { class: 'num', text: this.ms(r.echoMs) }),
      el('td', { class: 'err', text: r.error ? String(r.error) : '' }),
    );
  }

  private reportView(r: NetworkReport): HTMLElement[] {
    const rows = [
      ...(Array.isArray(r.nostr) ? r.nostr.map((e) => this.row('nostr', e)) : []),
      ...(Array.isArray(r.mqtt) ? r.mqtt.map((e) => this.row('mqtt', e)) : []),
    ];
    const table = el(
      'div',
      { class: 'scroll' },
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            ...(['endpoint', 'result', 'connectMs', 'echoMs', 'error'] as const).map((k) => el('th', { text: this.t(k), attrs: { scope: 'col' } })),
          ),
        ),
        el('tbody', {}, ...rows),
      ),
    );
    const webrtc = r.webrtc ?? { available: false, nat: 'unknown', candidates: [] };
    const summary = r.summary ?? { relays: 0, direct: 'unknown', ok: false };
    const direct = summary.direct === 'likely' || summary.direct === 'unlikely' ? summary.direct : 'unknown';
    const facts = el(
      'dl',
      {},
      el('dt', { text: this.t('webrtc') }),
      el('dd', { class: webrtc.available ? 'is-ok' : 'is-bad', text: this.t(webrtc.available ? 'available' : 'unavailable'), attrs: { 'data-webrtc': String(!!webrtc.available) } }),
      el('dt', { text: this.t('nat') }),
      el('dd', { text: String(webrtc.nat ?? 'unknown'), attrs: { 'data-nat': String(webrtc.nat ?? 'unknown') } }),
      el('dt', { text: this.t('relaysReachable') }),
      el('dd', { text: String(summary.relays ?? 0) }),
      el('dt', { text: this.t('directLinks') }),
      el('dd', { text: this.t(`direct_${direct}`) }),
    );
    const verdict = el('p', {
      class: `verdict ${summary.ok ? 'is-ok' : 'is-bad'}`,
      text: this.t(summary.ok ? 'verdictOk' : 'verdictBad'),
      attrs: { 'data-verdict': summary.ok ? 'ok' : 'bad' },
    });
    return [verdict, table, facts];
  }

  protected render(): void {
    const button = el('button', {
      class: 'primary',
      text: this.t(this.running ? 'checking' : 'check'),
      attrs: { type: 'button', 'data-action': 'check', 'data-focus': 'check', disabled: this.running, 'aria-busy': this.running ? 'true' : null },
      on: { click: () => this.run() },
    });
    const live = el(
      'div',
      { class: 'stack', attrs: { 'aria-live': 'polite', 'data-report': '' } },
      this.failure ? el('p', { class: 'error', text: this.t('checkFailed', { error: this.failure }), attrs: { role: 'alert' } }) : null,
      ...(this.result && !this.running ? this.reportView(this.result) : []),
    );
    this.mount(el('div', { class: 'card', attrs: { part: 'card' } }, el('div', { class: 'row' }, button), live));
  }
}
