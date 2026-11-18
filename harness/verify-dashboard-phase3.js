// Dashboard Phase 3 verification — Playwright, live dashboard + live API.
// Usage: node verify-dashboard-phase3.js
// Reads the API token from ../api_token.txt (never printed).
// Loads https://filter-platform-dashboard.pages.dev through the egress relay
// (127.0.0.1:18080), seeds sessionStorage fp_token before page scripts run,
// waits for the admin view to populate, and asserts the new Phase 3 sections
// render REAL data from the live API (ads list, SafeSearch rules, scan
// stats, device live status + last seen). Results: dashboard-phase3-results.json
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TOKEN = fs.readFileSync(path.join(ROOT, 'api_token.txt'), 'utf8').trim();
const DASH = 'https://filter-platform-dashboard.pages.dev/';
const CHROME = '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const result = { ranAt: new Date().toISOString(), url: DASH, checks: {}, ok: false };
  const browser = await chromium.launch({
    headless: true, executablePath: CHROME,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--proxy-server=http://127.0.0.1:18080', '--proxy-bypass-list=localhost;127.0.0.1'],
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('pageerror:', String(e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error') console.log('console error:', m.text().slice(0, 300)); });
    await page.addInitScript((token) => { sessionStorage.setItem('fp_token', token); }, TOKEN);
    const resp = await page.goto(DASH, { waitUntil: 'load', timeout: 60000 });
    result.httpStatus = resp.status();
    console.log('dashboard HTTP:', resp.status());

    // Wait for the async loadAll() to populate the stats grid.
    await page.waitForFunction(() => {
      const s = document.getElementById('stats');
      return s && s.querySelectorAll('.stat').length >= 8;
    }, { timeout: 60000 });
    await sleep(1500); // device-status fan-out finishes just after

    const c = await page.evaluate(() => {
      const txt = (sel) => { const el = document.querySelector(sel); return el ? el.innerText : null; };
      const rows = (sel) => document.querySelectorAll(sel + ' tr').length - 1; // minus header
      return {
        status: txt('#status'),
        health: txt('#health'),
        statTiles: Array.from(document.querySelectorAll('#stats .stat')).map(e => e.innerText.replace(/\n/g, ': ')),
        adsCountLabel: txt('#adsCount'),
        adsRows: rows('#ads table'),
        adsFirstDomains: Array.from(document.querySelectorAll('#ads table td')).filter((_, i) => i % 3 === 0).slice(0, 3).map(e => e.innerText),
        safesearchText: txt('#safesearch'),
        safesearchRows: rows('#safesearch table'),
        analysisStats: Array.from(document.querySelectorAll('#analysis .stat')).map(e => e.innerText.replace(/\n/g, ': ')),
        analysisRows: rows('#analysis table'),
        analysisFirstTarget: (() => { const t = document.querySelector('#analysis table td'); return t ? t.innerText : null; })(),
        deviceRows: rows('#devices table'),
        deviceHeaders: Array.from(document.querySelectorAll('#devices table th')).map(e => e.innerText),
        deviceCellsSample: Array.from(document.querySelectorAll('#devices table tr')).slice(1, 3).map(r => r.innerText.replace(/\n/g, ' | ').slice(0, 160)),
        policyText: txt('#policies'),
        ssDeviceOptions: document.getElementById('ssDevice') ? document.getElementById('ssDevice').options.length : 0,
      };
    });
    result.checks = c;
    console.log(JSON.stringify(c, null, 2));

    // Category filter: click "טראַקינג" and count rows (live API: 11 tracking of 26).
    await page.evaluate(() => { [...document.querySelectorAll('#view-admin button')].find(b => b.textContent.trim() === 'טראַקינג').click(); });
    await sleep(2000);
    const tracking = await page.evaluate(() => ({
      label: document.getElementById('adsCount').innerText,
      rows: document.querySelectorAll('#ads table tr').length - 1,
      cats: [...new Set(Array.from(document.querySelectorAll('#ads table td:nth-child(2)')).map(e => e.innerText))],
    }));
    result.checks.adsTrackingFilter = tracking;
    console.log('tracking filter:', JSON.stringify(tracking));

    // SafeSearch per-device: pick the first real device, reload the section.
    await page.evaluate(() => {
      const sel = document.getElementById('ssDevice');
      if (sel.options.length > 1) { sel.selectedIndex = 1; sel.dispatchEvent(new Event('change')); }
    });
    await sleep(2000);
    const ssDev = await page.evaluate(() => document.getElementById('safesearch').innerText.slice(0, 200));
    result.checks.safesearchPerDevice = ssDev;
    console.log('safesearch per-device:', JSON.stringify(ssDev));

    result.ok = result.httpStatus === 200
      && c.adsRows === 26 && c.safesearchRows === 7 && c.analysisRows === 4
      && c.deviceRows === 5 && tracking.rows === 11
      && (c.status || '').includes('פֿאַרבונדן');
    await page.screenshot({ path: path.join(__dirname, 'dashboard-phase3.png'), fullPage: true });
    console.log('screenshot: dashboard-phase3.png');
  } catch (e) {
    result.error = String(e && e.stack ? e.stack : e).slice(0, 2000);
    console.log('RUN ERROR:', result.error);
  } finally {
    await browser.close().catch(() => {});
  }
  const outPath = path.join(__dirname, 'dashboard-phase3-results.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log('ok:', result.ok, '| results:', outPath);
})().catch(e => { console.error(e); process.exit(1); });
