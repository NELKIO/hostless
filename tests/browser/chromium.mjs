// Find a Chromium for playwright-core: $CHROME_PATH, the revision playwright-core expects, or the
// newest one in the Playwright cache.
import { existsSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

export function chromiumPath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch {
    /* not installed */
  }
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? (platform() === 'darwin' ? join(homedir(), 'Library/Caches/ms-playwright') : join(homedir(), '.cache/ms-playwright'));
  const dirs = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])) : [];
  for (const d of dirs) {
    for (const rel of [
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-linux64/chrome',
      'chrome-linux/chrome',
      'chrome-win64/chrome.exe',
    ]) {
      const p = join(cache, d, rel);
      if (existsSync(p)) return p;
    }
  }
  throw new Error('No Chromium found: set CHROME_PATH or run `npx playwright install chromium`');
}

export function launch(options = {}) {
  return chromium.launch({ executablePath: chromiumPath(), headless: true, args: ['--use-fake-ui-for-media-stream', '--allow-loopback-in-peer-connection'], ...options });
}
