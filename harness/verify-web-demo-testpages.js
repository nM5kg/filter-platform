// Supplementary web-demo check: drive the remaining test pages (02 CSS
// backgrounds, 04 SVG, 05 WebGL, 07 live streams, 08 dynamic content)
// through the live demo shell and record status-line counts + overlays.
// Usage: node verify-web-demo-testpages.js
// Results: harness/verify-web-demo-testpages-results.json
const { chromium } = require('playwright');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const OUT = path.join(__dirname, 'verify-web-demo-testpages-results.json');
const CHROME = '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome';
const SHELL = 'https://filter-platform-dashboard.pages.dev/browser.html';
const PROXY_HOST = 'filter-platform-web-browser.gavhah-copy.workers.dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await pred()) return true; } catch (e) { /* keep waiting */ }
    await sleep(1000);
  }
  console.log('TIMEOUT waiting for:', label);
  return false;
}
function waitForRelay(port, timeoutMs) {
  return new Promise(async (resolve) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await new Promise((res) => {
        const s = net.connect(port, '127.0.0.1');
        s.on('connect', () => { s.destroy(); res(true); });
        s.on('error', () => res(false));
      });
      if (ok) return resolve(true);
      await sleep(300);
    }
    resolve(false);
  });
}

async function main() {
  const results = { ranAt: new Date().toISOString(), shell: SHELL, pages: [] };
  const relay = spawn('node', [path.join(__dirname, 'egress-relay.js')], {
    env: { ...process.env, RELAY_PORT: '18080' }, stdio: 'ignore',
  });
  if (!await waitForRelay(18080, 15000)) { console.log('relay did not come up'); process.exit(1); }
  const profile = path.join('/tmp', 'fp-webdemo-tp-' + Date.now());
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, timeout: 60000, executablePath: CHROME,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
      '--proxy-server=http://127.0.0.1:18080', '--proxy-bypass-list=localhost;127.0.0.1',
      '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await context.newPage();
  const shellStatus = () => page.evaluate(() => ({
    covered: document.getElementById('stCovered').textContent,
    allowed: document.getElementById('stAllowed').textContent,
    blocked: document.getElementById('stBlocked').textContent,
    scanned: document.getElementById('stScanned').textContent,
    detector: document.getElementById('stDetector').textContent,
  }));
  const proxyFrame = () => page.frames().find((f) => f.url().includes(PROXY_HOST));
  const frameEval = async (fn) => {
    const fr = proxyFrame();
    if (!fr) return null;
    try { return await fr.evaluate(fn); } catch (e) { return { error: String(e.message).slice(0, 200) }; }
  };
  try {
    await page.goto(SHELL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    // Warm the detector once on page 01 so the other pages measure the
    // filter, not the one-time model download.
    await page.evaluate(() => {
      [...document.querySelectorAll('#testList a')].find((a) => a.textContent.includes('01 —')).click();
    });
    await waitFor(async () => (await shellStatus()).detector.includes('גרייט'), 180000, 'detector warmup');
    console.log('detector warm');

    const checks = [
      { n: '02', label: '02-css-backgrounds', extra: () => frameEval(() => ({
        overlays: document.querySelectorAll('[data-fp-overlay]').length,
        note: 'text over stripped backgrounds must stay readable; covered count covers bg boxes',
      })) },
      { n: '04', label: '04-svg', extra: () => frameEval(() => ({
        overlays: document.querySelectorAll('[data-fp-overlay]').length,
      })) },
      { n: '05', label: '05-webgl', extra: () => frameEval(() => ({
        overlays: document.querySelectorAll('[data-fp-overlay]').length,
        canvases: [...document.querySelectorAll('canvas')].map((c) => getComputedStyle(c).visibility),
      })) },
      { n: '07', label: '07-live-streams', extra: () => frameEval(() => ({
        overlays: document.querySelectorAll('[data-fp-overlay]').length,
        videos: [...document.querySelectorAll('video')].map((v) => ({ paused: v.paused, visibility: getComputedStyle(v).visibility })),
      })) },
      { n: '08', label: '08-dynamic-content', extra: async () => {
        await sleep(5000); // let the 2 s delayed image + carousel swaps happen
        return frameEval(() => ({
          overlays: document.querySelectorAll('[data-fp-overlay]').length,
          imgs: document.querySelectorAll('img').length,
        }));
      } },
    ];
    for (const c of checks) {
      console.log('\n===== ' + c.label + ' =====');
      const rec = { page: c.label };
      await page.evaluate((num) => {
        [...document.querySelectorAll('#testList a')].find((a) => a.textContent.includes(num + ' —')).click();
      }, c.n);
      rec.countsArrived = await waitFor(async () => Number((await shellStatus()).scanned) > 0, 120000, c.label + ' counts');
      rec.status = await shellStatus();
      rec.frame = await c.extra();
      // Dynamic page keeps adding content; re-read the status after the wait.
      if (c.n === '08') rec.statusAfter5s = await shellStatus();
      rec.ok = rec.countsArrived && rec.frame && rec.frame.overlays > 0;
      results.pages.push(rec);
      console.log(JSON.stringify(rec, null, 2));
    }
    results.summary = {
      passed: results.pages.filter((p) => p.ok).length,
      total: results.pages.length,
    };
  } catch (e) {
    console.log('HARNESS ERROR:', e);
    results.harnessError = String(e && e.stack ? e.stack : e).slice(0, 1000);
  } finally {
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    console.log('\nSUMMARY:', JSON.stringify(results.summary));
    console.log('wrote', OUT);
    await context.close().catch(() => {});
    relay.kill();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
