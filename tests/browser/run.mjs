// End-to-end scenarios in two isolated Chromium profiles, with real WebRTC between them and local
// Nostr / MQTT endpoints. Run after `npm run build -- --demo` (npm run test:browser does both).
//   node tests/browser/run.mjs [filter]
import assert from 'node:assert/strict';
import { serve } from '../../scripts/serve.mjs';
import { launch } from './chromium.mjs';
import { startMqttBroker, startNostrRelay } from './servers.mjs';

const filter = process.argv[2] ?? '';
// HOSTLESS_LIVE=1: no local endpoints, the demos use the default public relays, brokers and signaling
const LIVE = process.env.HOSTLESS_LIVE === '1';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 10 }, () => CODE_ALPHABET[Math.floor(Math.random() * 32)]).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, timeout = 30_000, every = 100) {
  if (LIVE) timeout *= 3;
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
}

const server = await serve(new URL('../../demo-dist', import.meta.url).pathname, 0);
const base = `http://127.0.0.1:${server.address().port}`;
const relay = await startNostrRelay();
const signal = await startNostrRelay();
const broker = await startMqttBroker();
const browser = await launch();

// Track peer connections so a scenario can kill WebRTC mid-match.
const TRACK = `(() => {
  const Orig = window.RTCPeerConnection;
  if (!Orig) return;
  window.__pcs = [];
  window.__blockRtc = false;
  window.RTCPeerConnection = function (...a) {
    if (window.__blockRtc) throw new Error('blocked by test');
    const pc = new Orig(...a);
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = Orig.prototype;
})();`;

async function profile() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(TRACK);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  return { ctx, page };
}

const q = (extra = '') =>
  LIVE ? `live=1${extra}` : `signal=${encodeURIComponent(signal.url)}&nostr=${encodeURIComponent(relay.url)}&mqtt=${encodeURIComponent(broker.url)}&storage=${encodeURIComponent(relay.url)}${extra}`;
const tttState = (page) => page.evaluate(() => window.__ttt ?? null);

async function playTtt(a, b, { stopBefore = 0, onMove } = {}) {
  for (let i = 0; i < 12; i++) {
    const [sa, sb] = [await tttState(a), await tttState(b)];
    if (!sa?.state || !sb?.state) {
      await sleep(200);
      continue;
    }
    if (sa.phase === 'finished' && sb.phase === 'finished') return;
    if (sa.history !== sb.history) {
      await sleep(150);
      continue;
    }
    const free = sa.state.board.map((c, k) => (c === null ? k : -1)).filter((k) => k >= 0);
    if (stopBefore && free.length <= stopBefore) return;
    const mover = sa.state.next === sa.mySeat ? a : b;
    await mover.click(`#board button[data-cell="${free[0]}"]`);
    await onMove?.(i);
    await until('the move to arrive', async () => {
      const [x, y] = [await tttState(a), await tttState(b)];
      return x.history === y.history && x.history > sa.history;
    });
  }
}

async function tttPair(extra = '') {
  const code = newCode();
  const A = await profile();
  const B = await profile();
  await A.page.goto(`${base}/tictactoe.html?role=host&${q(extra)}#room=${code}`);
  await B.page.goto(`${base}/tictactoe.html?autojoin=1&${q(extra)}#room=${code}`);
  await until('both players in the match', async () => (await tttState(A.page))?.phase === 'playing' && (await tttState(B.page))?.phase === 'playing');
  return { code, A, B };
}

const scenarios = {
  async 'current demo pages do not load stale assets from a previous design'() {
    const { ctx, page } = await profile();
    await page.setViewportSize({ width: 900, height: 700 });
    try {
      // Simulate a cache that still serves the previous deployment at its unversioned URLs.
      await page.route(`${base}/style.css`, (route) => route.fulfill({ contentType: 'text/css', body: 'body, main { margin: 0; }' }));
      await page.route(/\/(tictactoe|canvas|clicker|netcheck)\.js$/, (route) => route.fulfill({
        contentType: 'text/javascript',
        body: `document.body.insertAdjacentHTML('afterbegin', '<header class="topbar"><img src="logo.svg" alt=""><nav>Old demo navigation</nav></header>');
               document.body.insertAdjacentHTML('beforeend', '<footer class="foot">Static pages · no server · MIT</footer>');`,
      }));
      for (const [path, widget] of [
        ['tictactoe.html', 'hostless-lobby'], ['canvas.html', 'hostless-lobby'],
        ['clicker.html', 'hostless-sync'], ['netcheck.html', 'hostless-netcheck'], ['index.html', null],
      ]) {
        await page.goto(`${base}/${path}?${q()}`);
        assert.equal(await page.locator('.topbar, .foot').count(), 0, `${path}: old navigation or footer was loaded`);
        const maxWidth = await page.locator('main').evaluate((el) => getComputedStyle(el).maxWidth);
        assert.equal(maxWidth, '560px', `${path}: current centering stylesheet was not loaded`);
        if (widget) assert.ok(await page.locator(`${widget}:defined`).count(), `${path}: current entry script did not run`);
      }
    } finally {
      await ctx.close();
    }
  },

  async 'tic-tac-toe over a direct WebRTC channel'() {
    const { A, B } = await tttPair();
    await until('a direct route', async () => (await tttState(A.page)).route === 'direct' && (await tttState(B.page)).route === 'direct', 30_000);
    await playTtt(A.page, B.page);
    const [a, b] = [await tttState(A.page), await tttState(B.page)];
    assert.equal(a.phase, 'finished');
    assert.deepEqual(a.state, b.state);
    await A.ctx.close();
    await B.ctx.close();
  },

  async 'tic-tac-toe over Nostr relays only'() {
    const { A, B } = await tttPair('&paths=nostr');
    assert.equal((await tttState(A.page)).route, 'relay');
    await playTtt(A.page, B.page);
    assert.deepEqual((await tttState(A.page)).state, (await tttState(B.page)).state);
    await A.ctx.close();
    await B.ctx.close();
  },

  async 'tic-tac-toe over MQTT only'() {
    const { A, B } = await tttPair('&paths=mqtt');
    await playTtt(A.page, B.page);
    assert.equal((await tttState(A.page)).phase, 'finished');
    assert.deepEqual((await tttState(A.page)).state, (await tttState(B.page)).state);
    await A.ctx.close();
    await B.ctx.close();
  },

  async 'WebRTC dies mid-match: the same match continues over the relays'() {
    const { A, B } = await tttPair('&paths=direct,nostr');
    await until('a direct route', async () => (await tttState(A.page)).route === 'direct', 30_000);
    await playTtt(A.page, B.page, {
      onMove: async (i) => {
        if (i !== 1) return;
        for (const p of [A.page, B.page])
          await p.evaluate(() => {
            window.__blockRtc = true;
            for (const pc of window.__pcs) pc.close();
          });
        await until('the relay route', async () => (await tttState(A.page)).route === 'relay', 20_000);
      },
    });
    const [a, b] = [await tttState(A.page), await tttState(B.page)];
    assert.equal(a.phase, 'finished');
    assert.equal(a.route, 'relay');
    assert.deepEqual(a.state, b.state);
    await A.ctx.close();
    await B.ctx.close();
  },

  async 'a reload mid-match resumes the same match'() {
    const { code, A, B } = await tttPair('&paths=nostr');
    await playTtt(A.page, B.page, { stopBefore: 6 });
    const before = await tttState(B.page);
    await B.page.reload();
    await until('the guest back in its match', async () => {
      const s = await tttState(B.page);
      return s?.matchId === before.matchId && s.history === before.history && s.phase === 'playing';
    });
    await A.page.reload();
    await until('the host back in its match', async () => (await tttState(A.page))?.matchId === before.matchId);
    await playTtt(A.page, B.page);
    assert.deepEqual((await tttState(A.page)).state, (await tttState(B.page)).state);
    assert.equal((await tttState(A.page)).phase, 'finished');
    void code;
    await A.ctx.close();
    await B.ctx.close();
  },

  async 'a player who comes back after the winner left gets the result from the mailbox'() {
    const { code, A, B } = await tttPair('&paths=nostr');
    // first-free play: the opener wins with its 4th mark (cell 6) — stop one move before that
    await playTtt(A.page, B.page, { stopBefore: 3 });
    const s = await tttState(A.page);
    assert.equal(s.phase, 'playing');
    const [winner, leaver, leaverUrl] = s.state.next === s.mySeat ? [A, B, `?${q('&paths=nostr')}`] : [B, A, `?role=host&${q('&paths=nostr')}`];
    // the other player closes the game; the winner makes the last move, then leaves too
    await leaver.page.close();
    await winner.page.click('#board button[data-cell="6"]');
    await until('the winner finished', async () => (await tttState(winner.page)).phase === 'finished');
    if (!LIVE) await until('the final stored', async () => relay.relay.stored.some((e) => e.kind === 30078), 30_000);
    else await sleep(15_000);
    await winner.ctx.close();
    // the other player comes back: nobody is online, the result comes from the relays
    const page = await leaver.ctx.newPage();
    await page.goto(`${base}/tictactoe.html${leaverUrl}#room=${code}`);
    await until('the result from the mailbox', async () => (await tttState(page))?.phase === 'finished', 90_000, 500);
    assert.equal((await tttState(page)).history, 7);
    await leaver.ctx.close();
  },

  async 'co-op canvas converges for concurrent painters'() {
    const code = newCode();
    const A = await profile();
    const B = await profile();
    for (const P of [A, B]) await P.page.goto(`${base}/canvas.html?autojoin=1&${q('&paths=direct,nostr')}#room=${code}`);
    await until('painters see each other', async () => (await A.page.evaluate(() => window.__canvas?.peers)) === 1 && (await B.page.evaluate(() => window.__canvas?.peers)) === 1);
    await Promise.all([
      A.page.evaluate(() => {
        for (let i = 0; i < 40; i++) window.__paint(i % 32, 3, i % 7);
      }),
      B.page.evaluate(() => {
        for (let i = 0; i < 40; i++) window.__paint(i % 32, 3, (i + 3) % 7);
      }),
    ]);
    await until('both canvases hold 80 strokes', async () => (await A.page.evaluate(() => window.__canvas.size)) === 80 && (await B.page.evaluate(() => window.__canvas.size)) === 80);
    assert.deepEqual(await A.page.evaluate(() => window.__canvas.pixels), await B.page.evaluate(() => window.__canvas.pixels));
    await A.ctx.close();
    await B.ctx.close();
  },

  async 'clicker progress syncs between two devices'() {
    const A = await profile();
    const B = await profile();
    const url = `${base}/clicker.html?${q()}`;
    await A.page.goto(url);
    await B.page.goto(url);
    for (let i = 0; i < 3; i++) await A.page.click('#click');
    for (let i = 0; i < 2; i++) await B.page.click('#click');
    const key = await A.page.evaluate(async () => {
      const el = document.querySelector('#sync');
      const k = el.sync.constructor.newKey();
      await el.sync.link(k);
      return k;
    });
    await B.page.evaluate(async (k) => {
      await document.querySelector('#sync').sync.link(k);
    }, key);
    await A.page.evaluate(() => document.querySelector('#sync').sync.syncNow());
    await until('both show 5', async () => (await A.page.evaluate(() => window.__clicker.clicks)) === 5 && (await B.page.evaluate(() => window.__clicker.clicks)) === 5);
    await A.ctx.close();
    await B.ctx.close();
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(scenarios)) {
  if (filter && !name.includes(filter)) continue;
  const t0 = Date.now();
  try {
    await fn();
    console.log(`✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}\n  ${e.stack ?? e}`);
  }
}
await browser.close();
await Promise.all([relay.close(), signal.close(), broker.close()]);
server.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
