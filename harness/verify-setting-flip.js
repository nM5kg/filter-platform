// Focused proof for the paint/block setting flip (case f of
// verify-review-live.js, isolated after a transient first-stage
// detector failure on a reload made the full harness's flip case
// inconclusive): the SAME image (d1-crowd-funeral.jpg) must BLOCK whole
// in block mode and PAINT in paint mode.
//
// Fresh profile: flip to block FIRST, review img-crowd -> block; then
// flip back to paint, clear the local cache, reload, review again ->
// allow_painted (which also restores the Neon row to allow_painted,
// the state the main harness left it in).
// Results: harness/verify-setting-flip-results.json
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const net = require('net');
const { spawn } = require('child_process');

const OUT = path.join(__dirname, 'verify-setting-flip-results.json');
const CHROME = '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome';
const SHELL = 'https://filter-platform-dashboard.pages.dev/browser.html';
const PAGES = 'https://filter-platform-dashboard.pages.dev';
const PROXY = 'https://filter-platform-web-browser.gavhah-copy.workers.dev';
const API = 'https://filter-platform-api.gavhah-copy.workers.dev';
const TEST01 = PAGES + '/test-pages/01-html-images.html';
const D1_URL = PAGES + '/test-pages/assets/d1-crowd-funeral.jpg';
const TOKEN = fs.readFileSync(path.join(__dirname, '..', 'api_token.txt'), 'utf8').trim();
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uKey = (url) => 'u:' + crypto.createHash('sha256').update(url).digest('hex');

async function waitFor(pred, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await pred()) return true; } catch (e) { /* keep waiting */ }
    await sleep(2000);
  }
  console.log('TIMEOUT waiting for:', label);
  return false;
}
async function apiGet(key) {
  const r = await fetch(PROXY + '/review-decision?image_key=' + encodeURIComponent(key),
    { headers: { 'User-Agent': UA } });
  const j = await r.json().catch(() => null);
  return { status: r.status, decision: j && j.data ? j.data.decision : null,
    mode: j && j.data ? j.data.human_image_mode : null,
    firstDetector: j && j.data ? j.data.first_detector : null };
}

(async () => {
  const results = { startedAt: new Date().toISOString(), cases: {} };
  const relay = spawn('node', [path.join(__dirname, 'egress-relay.js')], {
    env: { ...process.env, RELAY_PORT: '18080' }, stdio: 'ignore',
  });
  const relayUp = await new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const s = net.connect(18080, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => { if (Date.now() - start > 15000) resolve(false); else setTimeout(tick, 300); });
    };
    tick();
  });
  if (!relayUp) { console.log('relay did not come up'); relay.kill(); process.exit(1); }
  const profile = path.join('/tmp', 'fp-flip-' + Date.now());
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, timeout: 60000, executablePath: CHROME,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
      '--proxy-server=http://127.0.0.1:18080', '--proxy-bypass-list=localhost;127.0.0.1',
      '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await context.newPage();
  page.on('dialog', (d) => { d.accept().catch(() => {}); });

  const shellStatus = () => page.evaluate(() => ({
    covered: document.getElementById('stCovered').textContent,
    allowed: document.getElementById('stAllowed').textContent,
    blocked: document.getElementById('stBlocked').textContent,
    painted: document.getElementById('stPainted').textContent,
    scanned: document.getElementById('stScanned').textContent,
    unscanned: document.getElementById('stUnscanned').textContent,
    addr: document.getElementById('addr').value,
  }));
  const proxyFrame = async () => {
    const el = await page.$('#frame');
    if (!el) return null;
    try { return await el.contentFrame(); } catch (e) { return null; }
  };
  const frameEval = async (fn, arg) => {
    const fr = await proxyFrame();
    if (!fr) return null;
    try { return await fr.evaluate(fn, arg); } catch (e) { return { error: String(e.message).slice(0, 200) }; }
  };
  const frameClick = (sel, idx) => frameEval(([s, i]) => {
    const els = [...document.querySelectorAll(s)];
    if (i < 0 || i >= els.length) return false;
    els[i].click();
    return true;
  }, [sel, idx]);
  const reviewBtnIndexFor = (imgId) => frameEval((id) => {
    const img = document.getElementById(id);
    if (!img) return -1;
    const r = img.getBoundingClientRect();
    const btns = [...document.querySelectorAll('[data-fp-review-btn]')];
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i].getBoundingClientRect();
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      if (cx >= r.left - 5 && cx <= r.right + 5 && cy >= r.top - 5 && cy <= r.bottom + 5) return i;
    }
    return -1;
  }, imgId);
  const openMenu = async (act) => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click('#menuBtn');
    await sleep(500);
    await page.click('#menuDropdown [data-act="' + act + '"]');
    await sleep(800);
  };
  const shellLs = (key) => page.evaluate((k) => {
    try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return 'parse-error'; }
  }, key);
  const setMode = async (mode) => {
    await openMenu('settings');
    await page.click('input[name="fp-human-image-mode"][value="' + mode + '"]');
    await sleep(800);
    const s = await shellLs('fp_settings_v1');
    await page.click('#panelBack');
    await sleep(800);
    return s;
  };
  // Wait for a settled scan; if the scan comes back all-unscanned
  // (first-stage detector failed on this load), reload once and retry.
  const waitSettled = async (label) => {
    let ok = await waitFor(async () => {
      const s = await shellStatus();
      return Number(s.covered) >= 2 && Number(s.allowed) >= 1;
    }, 120000, label);
    if (!ok) {
      const s = await shellStatus();
      if (Number(s.scanned) > 0 && Number(s.unscanned) === Number(s.scanned) && Number(s.covered) === 0) {
        console.log('all-unscanned scan detected — reloading once and retrying');
        await page.click('#reloadBtn');
        await sleep(2000);
        ok = await waitFor(async () => {
          const s2 = await shellStatus();
          return Number(s2.covered) >= 2 && Number(s2.allowed) >= 1;
        }, 120000, label + ' (after reload)');
      }
    }
    return ok;
  };

  try {
    await page.goto(SHELL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    await page.fill('#addr', TEST01);
    await page.click('#goBtn');
    await sleep(1500);
    await waitFor(async () => (await shellStatus()).covered !== undefined, 60000, 'status');
    const settled = await waitSettled('initial counts settled');
    console.log('initial settled:', settled, JSON.stringify(await shellStatus()));

    // ---- block mode first ----
    const cB = { case: 'block-mode' };
    cB.settings = await setMode('block');
    const bi = await reviewBtnIndexFor('img-crowd');
    cB.reviewBtnIndex = bi;
    const t0 = Date.now();
    cB.clicked = bi >= 0 ? await frameClick('[data-fp-review-btn]', bi) : false;
    cB.blocked = await waitFor(async () => frameEval(() => {
      const img = document.getElementById('img-crowd');
      return img ? getComputedStyle(img).display === 'none' : false;
    }), 360000, 'img-crowd display:none (blocked whole, first model load)');
    cB.wallMsClickToBlocked = Date.now() - t0;
    cB.statusAfter = await shellStatus();
    cB.paintDivs = await frameEval(() => document.querySelectorAll('[data-fp-paint]').length);
    await sleep(4000);
    cB.api = await apiGet(uKey(D1_URL));
    cB.ok = cB.settings && cB.settings.humanImageMode === 'block' && cB.blocked === true &&
      Number(cB.statusAfter.blocked) >= 1 && cB.paintDivs === 0 &&
      cB.api.status === 200 && cB.api.decision === 'block' && cB.api.mode === 'block' &&
      cB.api.firstDetector && typeof cB.api.firstDetector === 'object';
    results.cases.blockMode = cB;
    console.log(JSON.stringify(cB, null, 2));

    // ---- flip back to paint, re-review -> allow_painted (restores row) ----
    const cP = { case: 'paint-mode-restore' };
    cP.settings = await setMode('paint');
    await frameEval(() => { try { localStorage.removeItem('fp_review_decisions_v1'); } catch (e) {} return true; });
    await page.click('#reloadBtn');
    await sleep(2000);
    cP.settled = await waitSettled('counts settled after flip-back reload');
    const pi = await reviewBtnIndexFor('img-crowd');
    cP.reviewBtnIndex = pi;
    const t1 = Date.now();
    cP.clicked = pi >= 0 ? await frameClick('[data-fp-review-btn]', pi) : false;
    cP.painted = await waitFor(async () => frameEval(() =>
      document.querySelectorAll('[data-fp-paint]').length >= 1), 180000, 'paint overlays reappear');
    cP.wallMsClickToPainted = Date.now() - t1;
    cP.statusAfter = await shellStatus();
    await sleep(4000);
    cP.api = await apiGet(uKey(D1_URL));
    cP.ok = cP.settings && cP.settings.humanImageMode === 'paint' && cP.painted === true &&
      Number(cP.statusAfter.painted) >= 1 &&
      cP.api.status === 200 && cP.api.decision === 'allow_painted' && cP.api.mode === 'paint';
    results.cases.paintMode = cP;
    console.log(JSON.stringify(cP, null, 2));
  } catch (e) {
    results.fatal = String(e && e.stack ? e.stack : e).slice(0, 2000);
    console.error('FATAL:', results.fatal);
  } finally {
    results.finishedAt = new Date().toISOString();
    results.overallOk = !!(results.cases.blockMode && results.cases.blockMode.ok &&
      results.cases.paintMode && results.cases.paintMode.ok);
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    console.log('\nOVERALL:', results.overallOk ? 'PASS' : 'FAIL');
    await context.close();
    relay.kill();
  }
  process.exit(results.overallOk ? 0 : 1);
})().catch((e) => { console.error('harness FAILED:', e); process.exit(2); });
