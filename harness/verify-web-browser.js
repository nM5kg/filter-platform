// New-browser verification harness — Playwright + headless Chromium.
// Usage: node verify-web-browser.js
// Spawns the egress relay (harness/egress-relay.js, 127.0.0.1:18080) itself,
// like verify-web-demo.js. Tests the LIVE multi-tab browser shell.
// Results: harness/verify-web-browser-results.json
//
// Cases:
//   a. Shell loads: tab strip, NTP on first tab, active iframe id="frame".
//   b. Omnibox: "wikipedia.org" -> https://wikipedia.org; phrase -> DDG
//      search URL; suggestions dropdown appears while typing.
//   c. Tabs: "+" creates tab 2 (NTP); different site in it; switch back to
//      tab 1 (page still there); close tab 2; reload page -> non-private
//      tab restores, private tab does not.
//   d. Navigation: index -> 01 -> back -> forward -> reload; stack works.
//   e. Filter still wired: page 01 person covered / landscape allowed,
//      counts arrive, detector ready; Wikipedia counts arrive.
//   f. History: two sites listed; search filters; clear empties.
//   g. Bookmarks: star a page, listed in view, open from there, delete.
//   h. Downloads policy: ALLOWED image has a Download button -> click ->
//      real browser download + Downloads view records completed; COVERED
//      person image has NO button; forced download-request for it ->
//      Downloads view records BLOCKED (verdict-cover), no download starts.
//   i. Find in page: present word -> found; nonsense word -> not found.
//   j. Desktop-site toggle: httpbin user-agent shows Windows desktop UA
//      when on; default UA returns when off / in a new tab.
//   k. Settings: search engine -> Google -> google.com/search; back to
//      DDG; clear browsing data empties history; About shows version.
//   l. SafeSearch + block page: Google search gains safe=active;
//      facebook.com shows the Yiddish block page.
const { chromium } = require('playwright');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'verify-web-browser-results.json');
const CHROME = '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome';
const SHELL = 'https://filter-platform-dashboard.pages.dev/browser.html';
const PAGES = 'https://filter-platform-dashboard.pages.dev';
const PROXY_HOST = 'filter-platform-web-browser.gavhah-copy.workers.dev';
const TEST01 = PAGES + '/test-pages/01-html-images';
const TEST01_INDEX = PAGES + '/test-pages/index.html';
const PERSON_IMG = PAGES + '/test-pages/assets/p1-huang-portrait.jpg';
const LANDSCAPE_IMG = PAGES + '/test-pages/assets/l1-glacier-lake.jpg';

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
  const results = { ranAt: new Date().toISOString(), shell: SHELL, cases: [] };
  const relay = spawn('node', [path.join(__dirname, 'egress-relay.js')], {
    env: { ...process.env, RELAY_PORT: '18080' }, stdio: 'ignore',
  });
  if (!await waitForRelay(18080, 15000)) {
    console.log('relay did not come up'); process.exit(1);
  }
  console.log('relay up on 127.0.0.1:18080');

  const profile = path.join('/tmp', 'fp-webbrowser-' + Date.now());
  const dlDir = path.join('/tmp', 'fp-browser-downloads-' + Date.now());
  fs.mkdirSync(dlDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    timeout: 60000,
    executablePath: CHROME,
    acceptDownloads: true,
    downloadsPath: dlDir,
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
      '--proxy-server=http://127.0.0.1:18080',
      '--proxy-bypass-list=localhost;127.0.0.1',
      '--ignore-certificate-errors',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await context.newPage();
  const consoleLines = [];
  const downloads = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('[fp') || t.includes('fp-detector')) consoleLines.push(t.slice(0, 300));
  });
  page.on('pageerror', (e) => consoleLines.push('PAGEERROR: ' + String(e.message).slice(0, 300)));
  page.on('download', (dl) => {
    downloads.push({ filename: dl.suggestedFilename(), at: new Date().toISOString() });
    console.log('DOWNLOAD EVENT:', dl.suggestedFilename());
  });
  // Settings "clear data" buttons use confirm(); accept every dialog.
  page.on('dialog', (d) => { console.log('DIALOG:', d.type(), d.message().slice(0, 120)); d.accept().catch(() => {}); });

  const shellStatus = () => page.evaluate(() => ({
    covered: document.getElementById('stCovered').textContent,
    allowed: document.getElementById('stAllowed').textContent,
    blocked: document.getElementById('stBlocked').textContent,
    scanned: document.getElementById('stScanned').textContent,
    detector: document.getElementById('stDetector').textContent,
    api: document.getElementById('stApi').textContent,
    addr: document.getElementById('addr').value,
  }));
  // The ACTIVE tab's iframe carries id="frame"; every tab has its own
  // iframe, so page.frames().find(...) can return an INACTIVE tab's frame.
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
  // DOM clicks for the tab strip: at 1280x720 the strip collapses under
  // the header (see case m), so coordinate clicks hit the header instead.
  const clickTabPart = (index, part) => page.evaluate(([i, p]) => {
    const chip = document.querySelectorAll('#tabStrip .tab')[i];
    if (!chip) return 'no-chip-' + i;
    const el = p === 'x' ? chip.querySelector('.x') : chip.querySelector('.t');
    if (!el) return 'no-part';
    el.click();
    return 'clicked';
  }, [index, part]);
  const clickNewTab = () => page.evaluate(() => {
    const b = document.getElementById('newTabBtn');
    if (!b) return 'missing';
    b.click();
    return 'clicked';
  });
  const navigateViaShell = async (target) => {
    await scrollTop();
    await page.fill('#addr', target);
    await page.click('#goBtn');
    await sleep(1500);
  };
  const waitAddr = (substr, timeoutMs) => waitFor(async () => {
    const s = await shellStatus();
    return s.addr.includes(substr);
  }, timeoutMs || 60000, 'addr contains ' + substr);
  const waitScanned = (timeoutMs) => waitFor(async () => {
    const s = await shellStatus();
    return Number(s.scanned) > 0;
  }, timeoutMs || 120000, 'scanned > 0');
  const waitDetectorReady = (timeoutMs) => waitFor(async () => {
    const s = await shellStatus();
    return s.detector.includes('גרייט');
  }, timeoutMs || 180000, 'detector ready');
  const waitCountsSettled = (timeoutMs) => waitFor(async () => {
    const s = await shellStatus();
    return Number(s.covered) >= 2 && Number(s.allowed) >= 1;
  }, timeoutMs || 120000, 'counts settled covered>=2 allowed>=1');
  const ls = (key) => page.evaluate((k) => {
    try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return 'parse-error'; }
  }, key);
  const tabCount = () => page.evaluate(() => document.querySelectorAll('#tabStrip .tab').length);
  const scrollTop = () => page.evaluate(() => window.scrollTo(0, 0));
  const openMenu = async (act) => {
    await scrollTop();
    await page.click('#menuBtn');
    await sleep(500);
    await page.click('#menuDropdown [data-act="' + act + '"]');
    await sleep(800);
  };
  const panelRows = () => page.evaluate(() =>
    [...document.querySelectorAll('#panelBody .row')].map((r) => r.innerText.replace(/\n+/g, ' | ').slice(0, 200)));
  const panelText = () => page.evaluate(() => document.getElementById('panelBody').innerText.slice(0, 2000));
  const backToBrowser = async () => { await scrollTop(); await page.click('#panelBack'); await sleep(800); };

  try {
    // ---- a. Shell loads ----
    console.log('\n===== a. shell loads =====');
    const caseA = { case: 'a-shell-loads' };
    await page.goto(SHELL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    caseA.shellUrl = page.url();
    caseA.tabChips = await tabCount();
    caseA.ntpVisible = await page.evaluate(() => {
      const n = document.getElementById('ntp');
      return n && getComputedStyle(n).display !== 'none';
    });
    caseA.ntpText = await page.evaluate(() => document.getElementById('ntp').innerText.slice(0, 200));
    caseA.frameEl = await page.evaluate(() => {
      const f = document.getElementById('frame');
      return f ? { src: f.src, visible: getComputedStyle(f).display !== 'none' } : null;
    });
    caseA.framePresent = !!(await proxyFrame());
    caseA.frameTarget = await frameEval(() => (window.__fpProxy || {}).target || location.href);
    caseA.addr = (await shellStatus()).addr;
    caseA.ok = caseA.tabChips >= 1 && caseA.ntpVisible && !!caseA.frameEl && caseA.framePresent;
    results.cases.push(caseA);
    console.log(JSON.stringify(caseA, null, 2));

    // ---- m. Tab-strip layout (is the strip actually visible/clickable?) ----
    console.log('\n===== m. tabstrip layout =====');
    const caseM = { case: 'm-tabstrip-layout' };
    caseM.viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    caseM.geometry = await page.evaluate(() => {
      const strip = document.getElementById('tabStrip').getBoundingClientRect();
      const chip = document.querySelector('#tabStrip .tab');
      if (!chip) return { chips: 0 };
      const r = chip.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const x = chip.querySelector('.x').getBoundingClientRect();
      const xel = document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2);
      return {
        stripHeight: Math.round(strip.height),
        chipTop: Math.round(r.top), chipBottom: Math.round(r.bottom),
        hitAtChipCenter: el ? el.tagName + '.' + (el.className || '') : null,
        hitAtCloseCenter: xel ? xel.tagName + '.' + (xel.className || '') : null,
      };
    });
    caseM.stripVisible = caseM.geometry.stripHeight >= 30;
    caseM.chipClickable = ['SPAN', 'DIV', 'BUTTON'].some((p) => (caseM.geometry.hitAtChipCenter || '').startsWith(p));
    caseM.closeClickable = ['SPAN', 'DIV', 'BUTTON'].some((p) => (caseM.geometry.hitAtCloseCenter || '').startsWith(p));
    // REAL mouse clicks (not DOM clicks): open a 2nd tab, click tab 1's
    // chip to switch back to it, then close tab 2 with a real click on
    // its x — restoring the single-tab state case c expects.
    caseM.realClickNewTab = await page.click('#newTabBtn').then(() => 'clicked').catch((e) => 'error: ' + String(e.message).slice(0, 100));
    await sleep(1000);
    caseM.tabsAfterRealPlus = await tabCount();
    caseM.realClickTab1 = await page.click('#tabStrip .tab:first-child .t').then(() => 'clicked').catch((e) => 'error: ' + String(e.message).slice(0, 100));
    await sleep(1000);
    caseM.activeAfterRealSwitch = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('#tabStrip .tab')];
      return tabs.findIndex((t) => t.classList.contains('active'));
    });
    caseM.ntpAfterRealSwitch = await page.evaluate(() => {
      const n = document.getElementById('ntp');
      return n && getComputedStyle(n).display !== 'none';
    });
    caseM.realClickCloseTab2 = await page.click('#tabStrip .tab:nth-child(2) .x').then(() => 'clicked').catch((e) => 'error: ' + String(e.message).slice(0, 100));
    await sleep(1000);
    caseM.tabsAfterRealClose = await tabCount();
    caseM.realSwitchOk = caseM.tabsAfterRealPlus === 2 && caseM.activeAfterRealSwitch === 0
      && caseM.ntpAfterRealSwitch && caseM.tabsAfterRealClose === 1;
    caseM.ok = caseM.stripVisible && caseM.chipClickable && caseM.closeClickable && caseM.realSwitchOk;
    results.cases.push(caseM);
    console.log(JSON.stringify(caseM, null, 2));

    // ---- b. Omnibox ----
    console.log('\n===== b. omnibox =====');
    const caseB = { case: 'b-omnibox' };
    await navigateViaShell('wikipedia.org');
    caseB.wikiAddrOk = await waitAddr('wikipedia.org', 60000);
    caseB.wikiAddr = (await shellStatus()).addr;
    caseB.wikiFrameTarget = await frameEval(() => (window.__fpProxy || {}).target || location.href);
    await waitScanned(60000);
    // Suggestions: type a fragment that matches history.
    await page.click('#addr');
    await page.fill('#addr', 'wiki');
    await sleep(1500);
    caseB.suggestOpen = await page.evaluate(() => document.getElementById('suggestBox').classList.contains('open'));
    caseB.suggestRows = await page.evaluate(() =>
      [...document.querySelectorAll('#suggestBox .row')].map((r) => r.innerText.replace(/\n+/g, ' | ').slice(0, 160)));
    // Search phrase -> DuckDuckGo search URL.
    await navigateViaShell('how to bake bread');
    caseB.searchAddrOk = await waitFor(async () => {
      const s = await shellStatus();
      return s.addr.includes('duckduckgo.com/?q=how%20to%20bake%20bread');
    }, 60000, 'addr is DDG search');
    caseB.searchAddr = (await shellStatus()).addr;
    caseB.searchFrameTarget = await frameEval(() => (window.__fpProxy || {}).target || location.href);
    caseB.ok = caseB.wikiAddrOk && caseB.suggestOpen && caseB.suggestRows.length > 0 && caseB.searchAddrOk;
    results.cases.push(caseB);
    console.log(JSON.stringify(caseB, null, 2));

    // ---- c. Tabs ----
    console.log('\n===== c. tabs =====');
    const caseC = { case: 'c-tabs' };
    const tab1Url = (await shellStatus()).addr; // DDG search URL
    await clickNewTab();
    await sleep(1000);
    caseC.tabsAfterPlus = await tabCount();
    caseC.tab2Ntp = await page.evaluate(() => {
      const n = document.getElementById('ntp');
      return n && getComputedStyle(n).display !== 'none';
    });
    caseC.tab2AddrEmpty = (await shellStatus()).addr === '';
    await navigateViaShell('example.com');
    caseC.tab2AddrOk = await waitAddr('example.com', 60000);
    caseC.tab2FrameTarget = await frameEval(() => (window.__fpProxy || {}).target || location.href);
    // Switch back to tab 1: its page is still there.
    caseC.switchClick = await clickTabPart(0, 't');
    await sleep(1500);
    caseC.tab1Addr = (await shellStatus()).addr;
    caseC.tab1StillThere = caseC.tab1Addr === tab1Url;
    caseC.tab1FrameTarget = await frameEval(() => (window.__fpProxy || {}).target || location.href);
    // Close tab 2.
    caseC.closeClick = await clickTabPart(1, 'x');
    await sleep(1000);
    caseC.tabsAfterClose = await tabCount();
    // Private tab, then reload the whole page.
    await openMenu('private');
    await sleep(1000);
    caseC.tabsWithPrivate = await tabCount();
    caseC.privateChipPresent = await page.evaluate(() => !!document.querySelector('#tabStrip .tab.private'));
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    caseC.tabsAfterReload = await tabCount();
    caseC.privateAfterReload = await page.evaluate(() => !!document.querySelector('#tabStrip .tab.private'));
    caseC.addrAfterReload = (await shellStatus()).addr;
    caseC.nonPrivateRestored = caseC.addrAfterReload === tab1Url;
    caseC.frameAfterReload = !!(await proxyFrame());
    caseC.ok = caseC.tabsAfterPlus === 2 && caseC.tab2Ntp && caseC.tab2AddrOk
      && caseC.tab1StillThere && caseC.tabsAfterClose === 1
      && caseC.privateChipPresent && caseC.tabsAfterReload === 1
      && !caseC.privateAfterReload && caseC.nonPrivateRestored;
    results.cases.push(caseC);
    console.log(JSON.stringify(caseC, null, 2));

    // ---- d. Navigation back/forward/reload ----
    console.log('\n===== d. navigation =====');
    const caseD = { case: 'd-navigation' };
    await navigateViaShell(TEST01_INDEX);
    // The shell/Worker normalizes .../test-pages/index.html to .../test-pages/
    // (fp-loaded target has the trailing slash, no 'index.html').
    caseD.indexOk = await waitFor(async () => (await shellStatus()).addr.endsWith('/test-pages/'), 60000, 'addr is test-pages/');
    await page.evaluate(() => {
      [...document.querySelectorAll('#testList a')].find((a) => a.textContent.includes('01 —')).click();
    });
    caseD.page01Ok = await waitAddr('01-html-images', 60000);
    await waitScanned(60000);
    await scrollTop(); await page.click('#backBtn');
    caseD.backOk = await waitFor(async () => (await shellStatus()).addr.endsWith('/test-pages/'), 30000, 'back to test-pages/');
    // Back is correctly ENABLED at the index: the stack is [DDG search, index].
    caseD.backEnabledAtIndex = await page.evaluate(() => !document.getElementById('backBtn').disabled);
    await scrollTop(); await page.click('#fwdBtn');
    caseD.fwdOk = await waitAddr('01-html-images', 30000);
    caseD.backEnabledOn01 = await page.evaluate(() => !document.getElementById('backBtn').disabled);
    await scrollTop(); await page.click('#reloadBtn');
    caseD.reloadScanned = await waitScanned(60000);
    caseD.reloadAddr = (await shellStatus()).addr;
    caseD.ok = caseD.indexOk && caseD.page01Ok && caseD.backOk && caseD.backEnabledAtIndex
      && caseD.fwdOk && caseD.backEnabledOn01 && caseD.reloadScanned;
    results.cases.push(caseD);
    console.log(JSON.stringify(caseD, null, 2));

    // ---- e. Filter still wired ----
    console.log('\n===== e. filter wired =====');
    const caseE = { case: 'e-filter-wired' };
    caseE.detectorReady = await waitDetectorReady(180000);
    caseE.countsSettled = await waitCountsSettled(120000);
    caseE.status = await shellStatus();
    caseE.frame = await frameEval(() => {
      const vis = (id) => {
        const el = document.getElementById(id);
        if (!el) return 'missing';
        return getComputedStyle(el).visibility;
      };
      return {
        overlays: document.querySelectorAll('[data-fp-overlay]').length,
        personVisibility: vis('img-person'),
        crowdVisibility: vis('img-crowd'),
        landscapeVisibility: vis('img-landscape'),
        personReady: !!window.__fpPersonReady,
      };
    });
    await navigateViaShell('https://en.wikipedia.org/wiki/Main_Page');
    caseE.wikiCounts = await waitScanned(120000);
    caseE.wikiStatus = await shellStatus();
    caseE.wikiFrame = await frameEval(() => ({
      overlays: document.querySelectorAll('[data-fp-overlay]').length,
      imgs: document.querySelectorAll('img').length,
      title: document.title,
    }));
    caseE.ok = caseE.detectorReady && caseE.countsSettled
      && caseE.frame && caseE.frame.personVisibility === 'hidden'
      && caseE.frame.landscapeVisibility === 'visible'
      && caseE.wikiCounts && caseE.wikiFrame && caseE.wikiFrame.imgs > 0;
    results.cases.push(caseE);
    console.log(JSON.stringify(caseE, null, 2));

    // ---- f. History ----
    console.log('\n===== f. history =====');
    const caseF = { case: 'f-history' };
    caseF.historyBefore = await ls('fp_history_v1');
    await openMenu('history');
    caseF.panelTitle = await page.evaluate(() => document.getElementById('panelTitle').textContent);
    caseF.rows = await panelRows();
    caseF.hasWikipedia = caseF.rows.some((r) => r.includes('wikipedia'));
    caseF.hasExample = caseF.rows.some((r) => r.includes('example.com'));
    // Search filters the list.
    await page.fill('#panelBody input', 'wikipedia');
    await sleep(1200);
    caseF.filteredRows = await panelRows();
    caseF.filterWorks = caseF.filteredRows.length >= 1
      && caseF.filteredRows.length < caseF.rows.length
      && caseF.filteredRows.every((r) => r.toLowerCase().includes('wikipedia'));
    // Clear the filter, then clear history (double-click to confirm).
    await page.fill('#panelBody input', '');
    await sleep(1200);
    await page.locator('#panelBody button', { hasText: 'פֿאַרמעקן געשיכטע' }).click({ force: true });
    await sleep(500);
    caseF.clearArmedText = await page.evaluate(() => {
      const b = [...document.querySelectorAll('#panelBody button')].find((x) => x.textContent.includes('באַשטעטיקן'));
      return b ? b.textContent : null;
    });
    await page.locator('#panelBody button', { hasText: 'באַשטעטיקן' }).click({ force: true });
    await sleep(1200);
    caseF.rowsAfterClear = await panelRows();
    caseF.emptyText = await panelText();
    caseF.historyAfter = await ls('fp_history_v1');
    caseF.ok = caseF.hasWikipedia && caseF.hasExample && caseF.filterWorks
      && caseF.rowsAfterClear.length === 0
      && Array.isArray(caseF.historyAfter) && caseF.historyAfter.length === 0;
    results.cases.push(caseF);
    console.log(JSON.stringify(caseF, null, 2));
    await backToBrowser();

    // ---- g. Bookmarks ----
    console.log('\n===== g. bookmarks =====');
    const caseG = { case: 'g-bookmarks' };
    await navigateViaShell('https://example.com');
    caseG.exampleOk = await waitAddr('example.com', 60000);
    await scrollTop(); await page.click('#bookmarkBtn');
    await sleep(800);
    caseG.starOn = await page.evaluate(() => document.getElementById('bookmarkBtn').textContent === '★');
    caseG.bookmarksAfterStar = await ls('fp_bookmarks_v1');
    await openMenu('bookmarks');
    caseG.rows = await panelRows();
    caseG.listed = caseG.rows.some((r) => r.includes('example.com'));
    // Open it from the bookmarks view.
    await page.locator('#panelBody .row .t').first().click({ force: true });
    await sleep(1500);
    caseG.openedAddr = (await shellStatus()).addr;
    caseG.openedFromView = caseG.openedAddr.includes('example.com');
    // Delete it.
    await openMenu('bookmarks');
    await page.locator('#panelBody button', { hasText: 'מעקן' }).first().click({ force: true });
    await sleep(1000);
    caseG.rowsAfterDelete = await panelRows();
    caseG.bookmarksAfterDelete = await ls('fp_bookmarks_v1');
    caseG.ok = caseG.exampleOk && caseG.starOn && caseG.listed && caseG.openedFromView
      && caseG.rowsAfterDelete.length === 0
      && Array.isArray(caseG.bookmarksAfterDelete) && caseG.bookmarksAfterDelete.length === 0;
    results.cases.push(caseG);
    console.log(JSON.stringify(caseG, null, 2));
    await backToBrowser();

    // ---- h. Downloads policy ----
    console.log('\n===== h. downloads policy =====');
    const caseH = { case: 'h-downloads' };
    await page.evaluate(() => {
      window.__fpLog = [];
      window.addEventListener('message', (e) => {
        const m = e.data || {};
        if (m.source !== 'filter-platform-web' || m.type !== 'fp-status') return;
        window.__fpLog.push({ covered: m.covered, allowed: m.allowed, scanned: m.scanned, verdicts: m.verdicts || {} });
      });
    });
    await navigateViaShell(TEST01);
    caseH.page01Ok = await waitAddr('01-html-images', 60000);
    caseH.detectorReady = await waitDetectorReady(180000);
    caseH.countsSettled = await waitCountsSettled(120000);
    caseH.status = await shellStatus();
    caseH.lastFpStatus = (await page.evaluate(() => window.__fpLog)).slice(-1)[0] || null;
    caseH.buttons = await frameEval(() => {
      const btns = [...document.querySelectorAll('[data-fp-download]')].map((b) => {
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: b.textContent };
      });
      const near = (id) => {
        const el = document.getElementById(id);
        if (!el) return { found: false, reason: 'missing-img' };
        const r = el.getBoundingClientRect();
        // Button sits on the image's top-right corner (see content.js).
        const cx = r.right, cy = r.top;
        const hit = btns.find((b) => Math.abs(b.x - cx) < 120 && Math.abs(b.y - cy) < 80);
        return { found: !!hit, imgRect: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right) } };
      };
      return { count: btns.length, buttons: btns, landscape: near('img-landscape'), person: near('img-person') };
    });
    caseH.allowedHasButton = caseH.buttons && caseH.buttons.landscape && caseH.buttons.landscape.found;
    caseH.coveredHasNoButton = caseH.buttons && caseH.buttons.person && !caseH.buttons.person.found;
    // Click the allowed image's Download button; expect a real download.
    const dlCountBefore = downloads.length;
    let dlEvent = null;
    const dlPromise = page.waitForEvent('download', { timeout: 60000 }).catch((e) => null);
    await frameEval(() => {
      const el = document.getElementById('img-landscape');
      const r = el.getBoundingClientRect();
      const btns = [...document.querySelectorAll('[data-fp-download]')];
      const btn = btns.find((b) => {
        const br = b.getBoundingClientRect();
        return Math.abs((br.left + br.width / 2) - r.right) < 120 && Math.abs((br.top + br.height / 2) - r.top) < 80;
      });
      if (btn) { btn.click(); return 'clicked'; }
      return 'no-button-found';
    });
    dlEvent = await dlPromise;
    if (dlEvent) {
      caseH.downloadFilename = dlEvent.suggestedFilename();
      try { caseH.downloadPath = await dlEvent.path(); } catch (e) { caseH.downloadPath = 'path-error: ' + String(e.message).slice(0, 100); }
      try { caseH.downloadFileExists = caseH.downloadPath ? fs.existsSync(caseH.downloadPath) : false; } catch (e) { caseH.downloadFileExists = false; }
    }
    await sleep(2000);
    caseH.downloadsAfterAllowed = await ls('fp_downloads_v1');
    // Downloads view records the completed download.
    await openMenu('downloads');
    caseH.downloadRows = await panelRows();
    caseH.completedListed = caseH.downloadRows.some((r) => r.includes('געענדיקט') && r.includes('l1-glacier-lake'));
    await backToBrowser();
    // Forced download-request for the COVERED person image, from the iframe.
    const dlCountBeforeForced = downloads.length;
    caseH.forcedPost = await frameEval((personUrl) => {
      window.parent.postMessage({
        source: 'filter-platform-web', type: 'fp-download-request',
        url: personUrl, kind: 'image',
      }, '*');
      return 'posted ' + personUrl;
    }, PERSON_IMG);
    await sleep(5000);
    caseH.downloadsDuringForced = downloads.length - dlCountBeforeForced;
    caseH.downloadsAfterForced = await ls('fp_downloads_v1');
    await openMenu('downloads');
    caseH.downloadRowsAfterForced = await panelRows();
    const firstRow = caseH.downloadRowsAfterForced[0] || '';
    caseH.blockedListed = firstRow.includes('בלאָקירט') && firstRow.includes('verdict-cover');
    caseH.blockedRow = firstRow;
    caseH.ok = caseH.allowedHasButton && caseH.coveredHasNoButton && !!dlEvent
      && caseH.completedListed && caseH.downloadsDuringForced === 0 && caseH.blockedListed;
    results.cases.push(caseH);
    console.log(JSON.stringify(caseH, null, 2));
    await backToBrowser();

    // ---- i. Find in page ----
    console.log('\n===== i. find in page =====');
    const caseI = { case: 'i-find' };
    await navigateViaShell('https://en.wikipedia.org/wiki/Main_Page');
    await waitScanned(120000);
    await openMenu('find');
    caseI.findBarOpen = await page.evaluate(() => document.getElementById('findBar').classList.contains('open'));
    await page.fill('#findInput', 'Wikipedia');
    await scrollTop(); await page.click('#findNext');
    caseI.foundOk = await waitFor(async () =>
      (await page.evaluate(() => document.getElementById('findResult').textContent)).includes('געפֿונען'), 30000, 'find present word');
    caseI.foundText = await page.evaluate(() => document.getElementById('findResult').textContent);
    await page.fill('#findInput', 'zxqvkjzzzqq');
    await scrollTop(); await page.click('#findNext');
    caseI.notFoundOk = await waitFor(async () =>
      (await page.evaluate(() => document.getElementById('findResult').textContent)).includes('נישט געפֿונען'), 30000, 'find nonsense word');
    caseI.notFoundText = await page.evaluate(() => document.getElementById('findResult').textContent);
    await scrollTop(); await page.click('#findClose');
    caseI.ok = caseI.findBarOpen && caseI.foundOk && caseI.notFoundOk;
    results.cases.push(caseI);
    console.log(JSON.stringify(caseI, null, 2));

    // ---- j. Desktop-site toggle ----
    console.log('\n===== j. desktop toggle =====');
    const caseJ = { case: 'j-desktop-toggle' };
    await openMenu('desktop');
    await sleep(1000);
    caseJ.desktopOnToast = await page.evaluate(() => document.getElementById('toast').textContent);
    await navigateViaShell('https://httpbin.org/user-agent');
    caseJ.uaDesktopOk = await waitFor(async () => {
      const t = await frameEval(() => (document.body ? document.body.innerText : ''));
      return typeof t === 'string' && t.includes('Windows NT 10.0');
    }, 60000, 'desktop UA shown');
    caseJ.uaDesktopText = await frameEval(() => (document.body ? document.body.innerText : '').slice(0, 300));
    // Toggle off: default UA returns.
    await openMenu('desktop');
    caseJ.uaDefaultOk = await waitFor(async () => {
      const t = await frameEval(() => (document.body ? document.body.innerText : ''));
      return typeof t === 'string' && t.includes('FilterPlatformWebBrowser/0.1') && !t.includes('Windows NT');
    }, 60000, 'default UA returns');
    caseJ.uaDefaultText = await frameEval(() => (document.body ? document.body.innerText : '').slice(0, 300));
    // New tab: default UA again.
    await scrollTop();
    await clickNewTab();
    await sleep(1000);
    await navigateViaShell('https://httpbin.org/user-agent');
    caseJ.uaNewTabDefault = await waitFor(async () => {
      const t = await frameEval(() => (document.body ? document.body.innerText : ''));
      return typeof t === 'string' && t.includes('FilterPlatformWebBrowser/0.1') && !t.includes('Windows NT');
    }, 60000, 'new tab default UA');
    caseJ.uaNewTabText = await frameEval(() => (document.body ? document.body.innerText : '').slice(0, 300));
    caseJ.ok = caseJ.uaDesktopOk && caseJ.uaDefaultOk && caseJ.uaNewTabDefault;
    results.cases.push(caseJ);
    console.log(JSON.stringify(caseJ, null, 2));

    // ---- k. Settings ----
    console.log('\n===== k. settings =====');
    const caseK = { case: 'k-settings' };
    await openMenu('settings');
    await page.selectOption('#panelBody select', 'google');
    await sleep(800);
    caseK.engineAfterGoogle = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('fp_settings_v1') || '{}').searchEngine; } catch (e) { return 'err'; }
    });
    await backToBrowser();
    await navigateViaShell('how to bake bread');
    caseK.googleAddrOk = await waitFor(async () => {
      const s = await shellStatus();
      const dec = decodeURIComponent(s.addr);
      return dec.includes('google.com/search') && dec.includes('q=how');
    }, 60000, 'addr is Google search (decoded)');
    caseK.googleAddr = (await shellStatus()).addr;
    caseK.googleSafeActive = decodeURIComponent(caseK.googleAddr).includes('safe=active');
    caseK.googleBotChecked = caseK.googleAddr.includes('/sorry/');
    await openMenu('settings');
    await page.selectOption('#panelBody select', 'duckduckgo');
    await sleep(800);
    caseK.engineAfterDuck = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('fp_settings_v1') || '{}').searchEngine; } catch (e) { return 'err'; }
    });
    caseK.aboutText = await panelText();
    caseK.aboutHasVersion = caseK.aboutText.includes('0.2.0');
    caseK.aboutHasLicense = caseK.aboutText.includes('Apache 2.0');
    // Clear browsing data (history) from Settings; confirm dialog auto-accepted.
    await page.locator('#panelBody button', { hasText: 'פֿאַרמעקן געשיכטע' }).click({ force: true });
    await sleep(1200);
    caseK.historyAfterClear = await ls('fp_history_v1');
    await openMenu('history');
    caseK.historyRowsAfterClear = await panelRows();
    caseK.ok = caseK.engineAfterGoogle === 'google' && caseK.googleAddrOk && caseK.googleSafeActive
      && caseK.engineAfterDuck === 'duckduckgo' && caseK.aboutHasVersion && caseK.aboutHasLicense
      && Array.isArray(caseK.historyAfterClear) && caseK.historyAfterClear.length === 0
      && caseK.historyRowsAfterClear.length === 0;
    results.cases.push(caseK);
    console.log(JSON.stringify(caseK, null, 2));
    await backToBrowser();

    // ---- l. SafeSearch + block page ----
    console.log('\n===== l. safesearch + block page =====');
    const caseL = { case: 'l-safesearch-block' };
    await navigateViaShell('https://www.google.com/search?q=cats');
    await sleep(5000);
    caseL.googleTarget = await frameEval(() => (window.__fpProxy || {}).target || location.href);
    caseL.googleHasSafeActive = typeof caseL.googleTarget === 'string'
      && decodeURIComponent(caseL.googleTarget).includes('safe=active');
    caseL.googleBotChecked = typeof caseL.googleTarget === 'string' && caseL.googleTarget.includes('/sorry/');
    await navigateViaShell('https://www.facebook.com');
    await sleep(4000);
    caseL.frameBody = await frameEval(() => (document.body ? document.body.innerText : '').slice(0, 300));
    caseL.ok = caseL.googleHasSafeActive
      && typeof caseL.frameBody === 'string' && caseL.frameBody.includes('דער פּלאַץ איז בלאקירט');
    results.cases.push(caseL);
    console.log(JSON.stringify(caseL, null, 2));
  } catch (e) {
    console.log('HARNESS ERROR:', e);
    results.harnessError = String(e && e.stack ? e.stack : e).slice(0, 1000);
  } finally {
    results.downloadEvents = downloads;
    results.consoleLines = consoleLines.slice(0, 60);
    results.summary = {
      passed: results.cases.filter((c) => c.ok).length,
      total: results.cases.length,
      cases: results.cases.map((c) => c.case + ': ' + (c.ok ? 'PASS' : 'FAIL')),
    };
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    console.log('\nSUMMARY:', JSON.stringify(results.summary, null, 2));
    console.log('wrote', OUT);
    await context.close().catch(() => {});
    relay.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
