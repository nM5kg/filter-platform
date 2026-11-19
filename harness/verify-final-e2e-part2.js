// FINAL E2E — part 2 (resume after part 1 fatal in step 1e).
// Re-links device #2 with a FRESH invite, manager-unlinks from dashboard,
// then runs the negative checks. Fixes the part-1 races: regResult is
// cleared before each register click, and every read waits for fresh text.
// NEVER prints the API token or any invite code.
const { chromium } = require('playwright');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const TOKEN = fs.readFileSync(path.join(ROOT, 'api_token.txt'), 'utf8').trim();
const API_BASE = 'https://filter-platform-api.gavhah-copy.workers.dev';
const DASH = 'https://filter-platform-dashboard.pages.dev/';
const CHROME_ALT = '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome';
const OUT = path.join(__dirname, 'verify-final-e2e-part2-results.json');
const RUN = '73245679';
const MANAGER_ID = 'cc6779b8-6f8d-40ef-9da0-754a08089b18';
const STD_ID = '179d3448-98d0-4eb4-8a2c-ac813a648e84';
const DEVICE1_ID = 'db2125b6-7672-460c-9206-91a875a2d239';
const PENDING_INVITE2_ID = '24651a5d-55bc-4994-996e-68068f641d7a'; // never redeemed (part-1 race) — deleted in cleanup

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function curlApi(method, pathSuffix, body) {
  const args = ['-s', '-H', 'Authorization: Bearer ' + TOKEN];
  if (body) args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body));
  if (method !== 'GET') args.push('-X', method);
  args.push(API_BASE + pathSuffix);
  return JSON.parse(execFileSync('curl', args, { encoding: 'utf8', timeout: 40000 }));
}
function curlRaw(method, pathSuffix, body) {
  const args = ['-s', '-w', '\n%{http_code}', '-H', 'Authorization: Bearer ' + TOKEN];
  if (body) args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body));
  if (method !== 'GET') args.push('-X', method);
  args.push(API_BASE + pathSuffix);
  const out = execFileSync('curl', args, { encoding: 'utf8', timeout: 40000 });
  const i = out.lastIndexOf('\n');
  return { status: Number(out.slice(i + 1).trim()), body: out.slice(0, i) };
}
async function waitForRelay(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((res) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); res(true); });
      s.on('error', () => res(false));
    });
    if (ok) return true;
    await sleep(300);
  }
  return false;
}
async function findExtensionId(context) {
  const probePage = await context.newPage();
  let extId = null;
  const start = Date.now();
  while (Date.now() - start < 60000 && !extId) {
    try {
      const cdp = await context.newCDPSession(probePage);
      const t = await cdp.send('Target.getTargets');
      const sws = (t.targetInfos || []).filter(x => x.type === 'service_worker' && x.url.includes('chrome-extension://') && x.url.endsWith('/background.js'));
      for (const sw of sws) {
        const id = sw.url.split('/')[2];
        const p = await context.newPage().catch(() => null);
        if (!p) continue;
        try {
          await p.goto(`chrome-extension://${id}/popup.html`, { timeout: 8000 });
          const txt = await p.evaluate(() => document.body.innerText.slice(0, 200)).catch(() => '');
          if (txt.includes('פֿילטער')) { extId = id; await p.close().catch(() => {}); break; }
        } catch (e) {}
        await p.close().catch(() => {});
      }
    } catch (e) {}
    if (!extId) await sleep(500);
  }
  await probePage.close().catch(() => {});
  return extId;
}

const results = { ranAt: new Date().toISOString(), run: RUN, steps: {} };
function logStep(k, v) { results.steps[k] = v; console.log(`\n### ${k}:`, JSON.stringify(v, null, 1).slice(0, 1500)); }

(async () => {
  if (!await waitForRelay(18080, 10000)) { console.log('RELAY 18080 NOT UP'); process.exit(1); }

  // Manager dashboard (fresh browser)
  const mgrBrowser = await chromium.launch({ headless: true, timeout: 60000, executablePath: CHROME_ALT,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--proxy-server=http://127.0.0.1:18080', '--proxy-bypass-list=localhost;127.0.0.1', '--ignore-certificate-errors'] });
  const mgrCtx = await mgrBrowser.newContext();
  const dash = await mgrCtx.newPage();
  dash.on('dialog', d => d.accept());
  await dash.goto(DASH, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2000);
  await dash.fill('#token', TOKEN);
  await dash.click('#connectBtn');
  await dash.waitForFunction((mid) => {
    const s = document.getElementById('myCustomer');
    return s && Array.from(s.options).some(o => o.value === mid);
  }, MANAGER_ID, { timeout: 30000 });
  await dash.click('#tabCustomer');
  await dash.selectOption('#myCustomer', MANAGER_ID);
  await dash.waitForFunction(() => {
    const el = document.getElementById('managedDevices');
    return el && el.innerText.length > 0;
  }, { timeout: 30000 });

  // Managed extension (REUSE part-1 profile so popup storage persists)
  const profile = path.join('/tmp', 'fp-e2e-managed-' + RUN);
  const manCtx = await chromium.launchPersistentContext(profile, {
    headless: true, timeout: 60000, executablePath: CHROME_ALT,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
    args: [`--load-extension=${EXT}`, '--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
      '--proxy-server=http://127.0.0.1:18080', '--proxy-bypass-list=localhost;127.0.0.1', '--ignore-certificate-errors'],
  });
  const extId = await findExtensionId(manCtx);
  if (!extId) throw new Error('Extension SW never appeared');
  const popup = await manCtx.newPage();
  popup.on('dialog', d => d.accept());
  await popup.goto(`chrome-extension://${extId}/popup.html`, { timeout: 20000 });
  await sleep(1500);
  // Confirm popup still holds device 1 (unlinked) from part 1
  const storedBefore = await popup.evaluate(async () => {
    const s = await chrome.storage.local.get(['fpDeviceId', 'fpCustomerId']);
    return { deviceId: s.fpDeviceId || null, customerId: s.fpCustomerId || null };
  });
  logStep('resume_state', { popupStillHoldsDevice1: storedBefore.deviceId === DEVICE1_ID, storedDeviceId: storedBefore.deviceId });

  // ===== 1e-a. Fresh invite #2b from the dashboard =====
  await dash.fill('#invDeviceName', 'E2E Managed Laptop 2');
  await dash.waitForFunction((sid) => {
    const s = document.getElementById('invPolicy');
    return s && Array.from(s.options).some(o => o.value === sid);
  }, STD_ID, { timeout: 15000 });
  await dash.selectOption('#invPolicy', STD_ID);
  await dash.click('form[onsubmit*="createManagedInvite"] button');
  await dash.waitForFunction(() => {
    const el = document.getElementById('inviteResult');
    return el && el.innerText.includes('אײַנלאַדונג־קאָד');
  }, { timeout: 30000 });
  const code2b = await dash.evaluate(() => {
    const b = document.querySelector('#inviteResult b');
    return b ? b.textContent.trim() : '';
  });
  // Wait for the pending-invites list to show the new invite (part-1 timing question)
  let invitesShowDevice2 = false;
  try {
    await dash.waitForFunction(() => {
      const el = document.getElementById('myInvites');
      return el && el.innerText.includes('E2E Managed Laptop 2');
    }, { timeout: 30000 });
    invitesShowDevice2 = true;
  } catch (e) { invitesShowDevice2 = false; }
  logStep('1e_invite2b', { inviteCreated6Digits: /^\d{6}$/.test(code2b), pendingInvitesListShowsDevice: invitesShowDevice2 });

  // ===== 1e-b. Register device #2 in the popup (clear stale result first) =====
  const managedEmail2 = `e2e-managed2-${RUN}@filter.local`;
  await popup.evaluate(() => {
    const el = document.getElementById('regResult');
    el.textContent = ''; el.style.display = 'none';
    const mb = document.getElementById('managedBy');
    mb.textContent = '';
  });
  await popup.fill('#token', TOKEN);
  await popup.fill('#regCode', code2b);
  await popup.fill('#regName', 'E2E Managed Person 2');
  await popup.fill('#regEmail', managedEmail2);
  await popup.fill('#regDeviceName', 'E2E Managed Laptop 2');
  await popup.click('#registerBtn');
  await popup.waitForFunction(() => {
    const el = document.getElementById('regResult');
    return el && el.style.display !== 'none' && el.innerText.includes('E2E Managed Laptop 2');
  }, { timeout: 60000 });
  const regResult2 = await popup.evaluate(() => document.getElementById('regResult').innerText);
  // Wait for the managed-by box to refresh with the manager name
  let managedBy2 = '';
  try {
    await popup.waitForFunction(() => {
      const el = document.getElementById('managedBy');
      return el && el.innerText.includes('E2E Manager');
    }, { timeout: 60000 });
    managedBy2 = await popup.evaluate(() => document.getElementById('managedBy').innerText);
  } catch (e) {
    managedBy2 = await popup.evaluate(() => document.getElementById('managedBy').innerText);
  }
  const stored2 = await popup.evaluate(async () => {
    const s = await chrome.storage.local.get(['fpDeviceId', 'fpCustomerId']);
    return { deviceId: s.fpDeviceId || null, customerId: s.fpCustomerId || null };
  });
  const deviceId2 = stored2.deviceId;
  const devApi2 = deviceId2 ? curlApi('GET', '/api/v1/devices/' + deviceId2) : null;
  logStep('1e_register_device2', {
    regResult2, managedByBox: managedBy2, device2IdSaved: !!deviceId2, device2IsNew: deviceId2 !== DEVICE1_ID,
    apiDevice2: devApi2 ? { name: devApi2.data.name, status: devApi2.data.status, managed_by_name: devApi2.data.managed_by_name, policy_name: devApi2.data.policy_name } : null,
  });

  // ===== 1e-c. Manager unlinks device #2 from the DASHBOARD =====
  await dash.evaluate(() => loadCustomerView());
  await dash.waitForFunction(() => {
    const el = document.getElementById('managedDevices');
    return el && el.innerText.includes('E2E Managed Laptop 2');
  }, { timeout: 60000 });
  const mgrRow2 = await dash.evaluate(() => document.getElementById('managedDevices').innerText);
  await dash.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#managedDevices tr'));
    const row = rows.find(r => r.innerText.includes('E2E Managed Laptop 2'));
    row.querySelector('button.danger').click();
  });
  await dash.waitForFunction(() => {
    const el = document.getElementById('managedDevices');
    return el && !el.innerText.includes('E2E Managed Laptop 2');
  }, { timeout: 30000 });
  const dashStatus = await dash.evaluate(() => document.getElementById('status').innerText);
  const devApiUnlinked2 = curlApi('GET', '/api/v1/devices/' + deviceId2);
  // Popup side: refresh and read the managed-by box
  await popup.click('#refresh');
  await sleep(3000);
  let managedByAfterMgrUnlink = '';
  try {
    await popup.waitForFunction(() => {
      const el = document.getElementById('managedBy');
      return el && el.innerText.includes('נישט פֿאַרוואַלט');
    }, { timeout: 30000 });
  } catch (e) {}
  managedByAfterMgrUnlink = await popup.evaluate(() => document.getElementById('managedBy').innerText);
  logStep('1e_manager_unlink_dashboard', {
    dashboardRowHadDevice2: mgrRow2.includes('E2E Managed Laptop 2'),
    dashboardStatusAfter: dashStatus,
    apiManagedByAfter: devApiUnlinked2.data.managed_by_name,
    popupManagedByAfterRefresh: managedByAfterMgrUnlink,
    pass: (devApiUnlinked2.data.managed_by_name === null || devApiUnlinked2.data.managed_by_name === undefined) && managedByAfterMgrUnlink.includes('נישט פֿאַרוואַלט'),
  });

  // ===== 1f. Negative checks (clear stale result first each time) =====
  const devsBeforeNeg = curlApi('GET', '/api/v1/devices?customer_id=' + stored2.customerId);
  // (a) reuse the SPENT code from step 1a — need it fresh: it was consumed in
  // part 1, so reuse is tested via the API with the used invite's code is not
  // available here; instead reuse code2b (now spent) in the popup.
  await popup.evaluate(() => { const el = document.getElementById('regResult'); el.textContent = ''; el.style.display = 'none'; });
  await popup.fill('#regCode', code2b); // spent — used for device 2
  await popup.fill('#regName', 'E2E Negative');
  await popup.fill('#regEmail', `e2e-neg-${RUN}@filter.local`);
  await popup.fill('#regDeviceName', 'E2E Negative Device');
  await popup.click('#registerBtn');
  await popup.waitForFunction(() => {
    const el = document.getElementById('regResult');
    return el && el.style.display !== 'none' && el.innerText.includes('טעות');
  }, { timeout: 30000 });
  const negSpent = await popup.evaluate(() => document.getElementById('regResult').innerText);
  const spentApi = curlRaw('POST', '/api/v1/devices/managed-register', { code: code2b, name: 'E2E Negative', email: `e2e-neg-api-${RUN}@filter.local`, device_name: 'E2E Neg API' });
  // (b) wrong code
  await popup.evaluate(() => { const el = document.getElementById('regResult'); el.textContent = ''; el.style.display = 'none'; });
  await popup.fill('#regCode', '000000');
  await popup.click('#registerBtn');
  await popup.waitForFunction(() => {
    const el = document.getElementById('regResult');
    return el && el.style.display !== 'none' && el.innerText.includes('טעות');
  }, { timeout: 30000 });
  const negWrong = await popup.evaluate(() => document.getElementById('regResult').innerText);
  const devsAfterNeg = curlApi('GET', '/api/v1/devices?customer_id=' + stored2.customerId);
  const storedAfterNeg = await popup.evaluate(async () => {
    const s = await chrome.storage.local.get(['fpDeviceId']);
    return s.fpDeviceId || null;
  });
  logStep('1f_negative_checks', {
    spentCodePopupError: negSpent, spentCodeApiStatus: spentApi.status,
    wrongCodePopupError: negWrong,
    devicesForManagedCustomerBefore: devsBeforeNeg.data.length, devicesForManagedCustomerAfter: devsAfterNeg.data.length,
    popupStillHoldsDevice2: storedAfterNeg === deviceId2,
    pass: negSpent.includes('נישט גילטיק') && negWrong.includes('נישט גילטיק') && spentApi.status === 404 && devsBeforeNeg.data.length === devsAfterNeg.data.length,
  });

  results.cleanupIds = { managerId: MANAGER_ID, deviceId1: DEVICE1_ID, deviceId2, managedCustomerIds: [storedBefore.customerId, stored2.customerId], pol2Id: 'c0a9231d-8816-4f04-802a-83749951ea2d', pendingInvite2Id: PENDING_INVITE2_ID, managedEmails: [`e2e-managed-${RUN}@filter.local`, managedEmail2] };
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log('\nResults saved to', OUT);
  await popup.close().catch(() => {});
  await manCtx.close().catch(() => {});
  await mgrBrowser.close().catch(() => {});
})().catch(e => {
  console.error('FATAL:', e);
  try { fs.writeFileSync(OUT, JSON.stringify(results, null, 2)); } catch (_) {}
  process.exit(1);
});
