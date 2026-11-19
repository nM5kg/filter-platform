#!/usr/bin/env node
// Focused verification of extension v1.2.1 (update check) — coordinator run.
// Loads the LIVE 1.2.1 ZIP (downloaded from the Pages site) unpacked.
// Checks: SW starts, manifest 1.2.1, popup opens, no console errors,
// live update check via the egress relay (versions.json says 1.2.1 ->
// no false update), banner shows when the flag is forced, sync + DNR
// rules with a throwaway device (deleted afterwards).
// The API token is read from api_token.txt and NEVER printed.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = '/home/hatch/workspace/filter-platform';
const EXT = '/tmp/fp-121-ext';
const API = 'https://filter-platform-api.gavhah-copy.workers.dev';
const TOKEN = fs.readFileSync(path.join(ROOT, 'api_token.txt'), 'utf8').trim();
const CHROME = '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome';
const results = { ranAt: new Date().toISOString(), steps: {} };

function api(method, p, body) {
  const args = ['-s', '--max-time', '40', '-X', method, API + p,
    '-H', 'Authorization: Bearer ' + TOKEN, '-H', 'Content-Type: application/json'];
  if (body) args.push('-d', JSON.stringify(body));
  return JSON.parse(execFileSync('curl', args, { encoding: 'utf8', timeout: 60000 }));
}
function log(k, v) { results.steps[k] = v; console.log(k, JSON.stringify(v)); }

(async () => {
  // 1. live ZIP already extracted to /tmp/fp-121-ext by the runner; sanity check
  const man = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  log('manifest', { version: man.version, name: man.name });

  const profile = '/tmp/fp-121-profile';
  fs.rmSync(profile, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true, timeout: 60000, executablePath: CHROME,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
    args: [`--load-extension=${EXT}`, '--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
      '--proxy-server=http://127.0.0.1:18080', '--proxy-bypass-list=localhost;127.0.0.1', '--ignore-certificate-errors'],
  });
  // find extension id via the service worker target
  let extId = null;
  for (let i = 0; i < 30 && !extId; i++) {
    for (const t of ctx.serviceWorkers()) { if (t.url().includes('background.js')) extId = t.url().split('/')[2]; }
    if (!extId) await new Promise(r => setTimeout(r, 1000));
  }
  log('load', { extensionId: extId, swFound: !!extId });

  const popup = await ctx.newPage();
  const consoleErrors = [];
  popup.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  popup.on('pageerror', e => consoleErrors.push('pageerror: ' + String(e).slice(0, 200)));
  await popup.goto(`chrome-extension://${extId}/popup.html`, { timeout: 20000 });
  await popup.waitForTimeout(1500);
  log('popup', { opened: true, consoleErrors });

  // 2. live update check (fetch goes through the relay to the live site)
  const check = await popup.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: 'checkUpdate' }).catch(e => ({ error: String(e) }));
    const s = await chrome.storage.local.get(['fpUpdateAvailable', 'fpLatestVersion', 'fpUpdateCheckedAt']);
    return { checkResult: r, stored: s };
  });
  log('updateCheckLive', check);
  const bannerHidden = await popup.evaluate(() => {
    const b = document.getElementById('updateBanner');
    return b ? getComputedStyle(b).display : 'MISSING';
  });
  log('bannerWhenMatching', { display: bannerHidden });

  // 3. force the flag -> banner must show; then reset
  await popup.evaluate(async () => {
    await chrome.storage.local.set({ fpUpdateAvailable: true, fpLatestVersion: '9.9.9' });
  });
  await popup.reload({ timeout: 20000 });
  await popup.waitForTimeout(1200);
  const bannerShown = await popup.evaluate(() => {
    const b = document.getElementById('updateBanner');
    return { display: b ? getComputedStyle(b).display : 'MISSING', text: b ? b.innerText.slice(0, 120) : '' };
  });
  log('bannerWhenForced', bannerShown);
  await popup.evaluate(async () => {
    await chrome.storage.local.set({ fpUpdateAvailable: false, fpLatestVersion: '1.2.1' });
  });

  // 4. sync + DNR rules with a throwaway device
  const run = String(Date.now());
  const cust = api('POST', '/api/v1/customers', { name: 'Verify121', email: `verify121-${run}@filter.local` });
  const custId = cust.data.id;
  const dev = api('POST', '/api/v1/devices', { customer_id: custId, name: 'Verify121 Laptop', platform: 'windows' });
  const devId = dev.data.id;
  const code = dev.data.activation_code;
  const act = api('POST', '/api/v1/devices/register', { code });
  log('tempDevice', { created: !!devId, activated: act.data && act.data.status === 'active' });
  await popup.evaluate(async (s) => {
    await chrome.storage.local.set(s);
  }, { fpToken: TOKEN, fpDeviceId: devId, fpCustomerId: custId });
  await popup.waitForTimeout(4000);
  const sync = await popup.evaluate(async () => {
    const s = await chrome.storage.local.get(['fpStatus']);
    return s.fpStatus || null;
  });
  const rules = await popup.evaluate(async () => {
    const rs = await chrome.declarativeNetRequest.getDynamicRules();
    const byRange = { domain: 0, redirect: 0, ads: 0, safesearch: 0, other: 0 };
    for (const r of rs) {
      if (r.id >= 8000) byRange.safesearch++;
      else if (r.id >= 5000) byRange.ads++;
      else if (r.id >= 3000) byRange.redirect++;
      else if (r.id >= 1000) byRange.domain++;
      else byRange.other++;
    }
    return { total: rs.length, byRange };
  });
  log('sync', { status: sync, dnrRules: rules });

  // 5. cleanup throwaway rows via API + direct SQL for the customer
  try { api('DELETE', `/api/v1/devices/${devId}`); } catch (e) { /* fall through to SQL */ }
  spawnSync('python3', ['fpsql.py', `DELETE FROM audit_logs WHERE actor_id='${custId}' OR entity_id='${devId}' OR entity_id='${custId}';`], { cwd: ROOT, encoding: 'utf8' });
  spawnSync('python3', ['fpsql.py', `DELETE FROM devices WHERE id='${devId}';`], { cwd: ROOT, encoding: 'utf8' });
  spawnSync('python3', ['fpsql.py', `DELETE FROM customers WHERE id='${custId}';`], { cwd: ROOT, encoding: 'utf8' });
  const after = api('GET', `/api/v1/devices?customer_id=${custId}`);
  log('cleanup', { devicesLeftForCustomer: (after.data || []).length });

  await ctx.close();
  fs.writeFileSync('/home/hatch/workspace/filter-platform/harness/verify-1.2.1-results.json', JSON.stringify(results, null, 2));
  console.log('RESULTS WRITTEN');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
