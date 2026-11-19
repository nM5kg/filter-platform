// FINAL end-to-end verification — two-person managed-device flow in real
// browsers + SafeSearch per-device sync. VERIFICATION ONLY: no product code
// is touched. Test data is created via the API and deleted afterwards.
// NEVER prints the API token or any invite code (codes live only in memory).
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
const CHROME = '/home/hatch/.cache/ms-playwright/chrome-linux64/chrome';
const CHROME_ALT = '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome';
const OUT = path.join(__dirname, 'verify-final-e2e-results.json');
const RUN = String(Date.now()).slice(-8);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function curlApi(method, pathSuffix, body) {
  const args = ['-s', '-H', 'Authorization: Bearer ' + TOKEN];
  if (body) args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body));
  if (method !== 'GET') args.push('-X', method);
  args.push(API_BASE + pathSuffix);
  const out = execFileSync('curl', args, { encoding: 'utf8', timeout: 40000 });
  return JSON.parse(out);
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
  const chromePath = fs.existsSync(CHROME_ALT) ? CHROME_ALT : CHROME;
  if (!await waitForRelay(18080, 10000)) { console.log('RELAY 18080 NOT UP'); process.exit(1); }
  console.log('relay 18080 alive (reused, not started by this script)');

  // ===== 0. API setup: manager customer + second test policy =====
  const mgr = curlApi('POST', '/api/v1/customers', { name: 'E2E Manager', email: `e2e-manager-${RUN}@filter.local`, phone: '+1-555-0199' });
  const managerId = mgr.data.id;
  const pols = curlApi('GET', '/api/v1/policies');
  const stdPolicy = pols.data.find(p => p.is_default);
  const stdId = stdPolicy.id;
  const pol2 = curlApi('POST', '/api/v1/policies', { name: 'E2E Test — SafeSearch Off', description: 'Temporary policy for final E2E verification; deleted after the run.', strictness: 2, block_images: false, cover_images: true, filter_videos: false, filter_ads: false, force_safesearch: false, require_approval_for_new_sites: false });
  const pol2Id = pol2.data.id;
  const pol2Back = curlApi('GET', '/api/v1/policies/' + pol2Id);
  logStep('setup', { managerId, managerEmail: `e2e-manager-${RUN}@filter.local`, stdPolicyId: stdId, stdPolicyName: stdPolicy.name, secondPolicyId: pol2Id, secondPolicyStored: { force_safesearch: pol2Back.data.force_safesearch, block_images: pol2Back.data.block_images, cover_images: pol2Back.data.cover_images } });

  // ===== 1a. MANAGER browser: live dashboard, create invite #1 =====
  const mgrBrowser = await chromium.launch({ headless: true, timeout: 60000, executablePath: chromePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--proxy-server=http://127.0.0.1:18080', '--proxy-bypass-list=localhost;127.0.0.1', '--ignore-certificate-errors'] });
  const mgrCtx = await mgrBrowser.newContext();
  const dash = await mgrCtx.newPage();
  dash.on('dialog', d => d.accept());
  let dashUrlUsed = DASH;
  try {
    await dash.goto(DASH, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2000);
  } catch (e) {
    dashUrlUsed = 'file://' + path.join(ROOT, 'public', 'index.html');
    await dash.goto(dashUrlUsed, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  const dashTitle = await dash.title().catch(() => '');
  await dash.fill('#token', TOKEN);
  await dash.click('#connectBtn');
  await dash.waitForFunction((mid) => {
    const s = document.getElementById('myCustomer');
    return s && Array.from(s.options).some(o => o.value === mid);
  }, managerId, { timeout: 30000 });
  await dash.click('#tabCustomer');
  await dash.selectOption('#myCustomer', managerId);
  await dash.waitForFunction(() => {
    const el = document.getElementById('managedDevices');
    return el && el.innerText.length > 0;
  }, { timeout: 30000 });
  const managedBefore = await dash.evaluate(() => document.getElementById('managedDevices').innerText);
  await dash.fill('#invDeviceName', 'E2E Managed Laptop');
  await dash.waitForFunction((sid) => {
    const s = document.getElementById('invPolicy');
    return s && Array.from(s.options).some(o => o.value === sid);
  }, stdId, { timeout: 15000 });
  await dash.selectOption('#invPolicy', stdId);
  await dash.click('form[onsubmit*="createManagedInvite"] button');
  await dash.waitForFunction(() => {
    const el = document.getElementById('inviteResult');
    return el && el.innerText.includes('אײַנלאַדונג־קאָד');
  }, { timeout: 30000 });
  const code1 = await dash.evaluate(() => {
    const b = document.querySelector('#inviteResult b');
    return b ? b.textContent.trim() : '';
  });
  const invite1Ok = /^\d{6}$/.test(code1);
  const invitesList1 = await dash.evaluate(() => document.getElementById('myInvites').innerText);
  logStep('1a_manager_invite', { dashboardUrl: dashUrlUsed, dashboardTitle: dashTitle, inviteCreated: invite1Ok, codeFormat6Digits: invite1Ok, managedTableBefore: managedBefore.slice(0, 120), invitesListShowsDevice: invitesList1.includes('E2E Managed Laptop') });

  // ===== 1b. MANAGED browser: extension popup, register with code #1 =====
  const profile = path.join('/tmp', 'fp-e2e-managed-' + RUN);
  fs.rmSync(profile, { recursive: true, force: true });
  const manCtx = await chromium.launchPersistentContext(profile, {
    headless: true, timeout: 60000, executablePath: chromePath,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
    args: [`--load-extension=${EXT}`, '--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
      '--proxy-server=http://127.0.0.1:18080', '--proxy-bypass-list=localhost;127.0.0.1', '--ignore-certificate-errors'],
  });
  const extId = await findExtensionId(manCtx);
  if (!extId) throw new Error('Extension SW never appeared');
  const popup = await manCtx.newPage();
  popup.on('dialog', d => d.accept());
  const popupErrors = [];
  popup.on('pageerror', e => popupErrors.push(String(e).slice(0, 200)));
  popup.on('console', m => { if (m.type() === 'error') popupErrors.push(m.text().slice(0, 200)); });
  await popup.goto(`chrome-extension://${extId}/popup.html`, { timeout: 20000 });
  await sleep(1500);
  const managedEmail1 = `e2e-managed-${RUN}@filter.local`;
  await popup.fill('#token', TOKEN);
  await popup.fill('#regCode', code1);
  await popup.fill('#regName', 'E2E Managed Person');
  await popup.fill('#regEmail', managedEmail1);
  await popup.fill('#regDeviceName', 'E2E Managed Laptop');
  await popup.click('#registerBtn');
  await popup.waitForFunction(() => {
    const el = document.getElementById('regResult');
    return el && el.style.display !== 'none' && el.innerText.length > 5;
  }, { timeout: 60000 });
  const regResult1 = await popup.evaluate(() => document.getElementById('regResult').innerText);
  const stored1 = await popup.evaluate(async () => {
    const s = await chrome.storage.local.get(['fpToken', 'fpDeviceId', 'fpCustomerId', 'fpStatus']);
    return { hasToken: !!s.fpToken, deviceId: s.fpDeviceId || null, customerId: s.fpCustomerId || null, status: s.fpStatus || null };
  });
  const managedBy1 = await popup.evaluate(() => document.getElementById('managedBy').innerText);
  const unlinkVisible1 = await popup.evaluate(() => document.getElementById('unlink').style.display !== 'none');
  const deviceId1 = stored1.deviceId;
  const devApi1 = deviceId1 ? curlApi('GET', '/api/v1/devices/' + deviceId1) : null;
  logStep('1b_managed_register', {
    extensionId: extId, regResult: regResult1, deviceIdSaved: !!deviceId1,
    managedByBox: managedBy1, unlinkButtonVisible: unlinkVisible1, popupErrors,
    apiDevice: devApi1 ? { name: devApi1.data.name, status: devApi1.data.status, managed_by_name: devApi1.data.managed_by_name, policy_name: devApi1.data.policy_name } : null,
  });

  async function popupRefresh() {
    const st = await popup.evaluate(async () => { try { return await chrome.runtime.sendMessage({ type: 'refresh' }); } catch (e) { return { error: String(e) }; } });
    const rules = await popup.evaluate(async () => chrome.declarativeNetRequest.getDynamicRules());
    const ssRules = rules.filter(r => r.id >= 8000);
    const statusText = await popup.evaluate(() => document.getElementById('status').innerText);
    return { status: st, dnrTotal: rules.length, safeSearchRules: ssRules.length, statusText };
  }
  // Baseline sync on Standard
  const syncStd = await popupRefresh();
  logStep('1b_sync_standard_baseline', { policyName: syncStd.status.policyName, policyFetched: syncStd.status.policyFetched, force_safesearch: syncStd.status.force_safesearch, safeSearchEnforced: syncStd.status.safeSearchEnforced, safeSearchRulesCount: syncStd.status.safeSearchRulesCount, dnrSafeSearchRules: syncStd.safeSearchRules, statusText: syncStd.statusText });

  // ===== 1c. MANAGER changes policy via dashboard dropdown -> second policy =====
  await dash.evaluate(() => loadCustomerView());
  await dash.waitForFunction((did) => {
    const sel = document.querySelector('#managedDevices select');
    return sel && sel.closest('tr') && sel.closest('tr').innerText.includes('E2E Managed Laptop');
  }, deviceId1, { timeout: 30000 }).catch(() => {});
  await sleep(1500);
  const mgrRowBefore = await dash.evaluate(() => document.getElementById('managedDevices').innerText);
  await dash.evaluate((pid2) => {
    const sel = document.querySelector('#managedDevices select');
    sel.value = pid2;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, pol2Id);
  await dash.waitForFunction(() => {
    const el = document.getElementById('status');
    return el && el.innerText.includes('פּאָליטיק געטוישט');
  }, { timeout: 30000 });
  await sleep(2000);
  const devApi2 = curlApi('GET', '/api/v1/devices/' + deviceId1);
  const mgrRowAfter = await dash.evaluate(() => document.getElementById('managedDevices').innerText);
  logStep('1c_manager_policy_change_dashboard', {
    dashboardRowBeforeHasDevice: mgrRowBefore.includes('E2E Managed Laptop'),
    statusAfterChange: await dash.evaluate(() => document.getElementById('status').innerText),
    apiPolicyNow: devApi2.data.policy_name, apiPolicyId: devApi2.data.policy_id,
    dashboardRowAfterShowsNewPolicy: mgrRowAfter.includes('E2E Test'),
  });

  // ===== 2. SAFES EARCH per-device: sync managed ext on second policy =====
  const syncPol2 = await popupRefresh();
  await popup.click('#refresh');
  await sleep(3000);
  const syncPol2b = await popup.evaluate(async () => {
    const s = await chrome.storage.local.get(['fpStatus']);
    return s.fpStatus;
  });
  const dnrPol2 = await popup.evaluate(async () => chrome.declarativeNetRequest.getDynamicRules());
  const ssApiPol2 = curlApi('GET', '/api/v1/safesearch?device_id=' + deviceId1);
  logStep('2_safesearch_off_policy_sync', {
    popupStatusPolicy: syncPol2.status.policyName, policyFetched: syncPol2.status.policyFetched,
    block_images: syncPol2.status.block_images, cover_images: syncPol2.status.cover_images,
    force_safesearch: syncPol2.status.force_safesearch, safeSearchEnforced: syncPol2.status.safeSearchEnforced,
    safeSearchRulesCount: syncPol2.status.safeSearchRulesCount, dnrSafeSearchRules: syncPol2.safeSearchRules,
    statusText: syncPol2.statusText, storedAfterRefreshClick: { policyName: syncPol2b && syncPol2b.policyName, force_safesearch: syncPol2b && syncPol2b.force_safesearch, safeSearchEnforced: syncPol2b && syncPol2b.safeSearchEnforced },
    dnrSafeSearchRulesAfterRefreshClick: dnrPol2.filter(r => r.id >= 8000).length,
    apiSafeSearchForDevice: { force_safesearch: ssApiPol2.data.force_safesearch, policy_name: ssApiPol2.data.policy_name },
    pass: syncPol2.status.force_safesearch === false && syncPol2.status.safeSearchEnforced === false && syncPol2.safeSearchRules === 0,
  });

  // Switch back to Standard via dashboard, confirm SafeSearch returns
  await dash.evaluate(() => loadCustomerView());
  await sleep(1500);
  await dash.evaluate((sid) => {
    const sel = document.querySelector('#managedDevices select');
    sel.value = sid;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, stdId);
  await dash.waitForFunction(() => {
    const el = document.getElementById('status');
    return el && el.innerText.includes('פּאָליטיק געטוישט');
  }, { timeout: 30000 });
  await sleep(1500);
  const syncBack = await popupRefresh();
  logStep('2b_safesearch_back_to_standard', {
    policyName: syncBack.status.policyName, force_safesearch: syncBack.status.force_safesearch,
    safeSearchEnforced: syncBack.status.safeSearchEnforced, safeSearchRulesCount: syncBack.status.safeSearchRulesCount,
    dnrSafeSearchRules: syncBack.safeSearchRules,
    pass: syncBack.status.force_safesearch === true && syncBack.safeSearchRules === 3,
  });

  // ===== 1d. MANAGED person unlinks from popup =====
  await popup.evaluate(() => document.getElementById('unlink').click());
  await popup.waitForFunction(() => {
    const el = document.getElementById('managedBy');
    return el && el.innerText.includes('מער נישט פֿאַרוואַלט');
  }, { timeout: 30000 });
  const managedByAfterUnlink = await popup.evaluate(() => document.getElementById('managedBy').innerText);
  const devApiUnlinked = curlApi('GET', '/api/v1/devices/' + deviceId1);
  logStep('1d_managed_unlink_popup', {
    managedByBoxAfter: managedByAfterUnlink,
    apiManagedByName: devApiUnlinked.data.managed_by_name, apiManagedById: devApiUnlinked.data.managed_by_customer_id,
    pass: devApiUnlinked.data.managed_by_name === null || devApiUnlinked.data.managed_by_name === undefined,
  });

  // ===== 1e. Re-link device #2, manager unlinks from dashboard =====
  await dash.evaluate(() => loadCustomerView());
  await sleep(1500);
  await dash.fill('#invDeviceName', 'E2E Managed Laptop 2');
  await dash.selectOption('#invPolicy', stdId);
  await dash.click('form[onsubmit*="createManagedInvite"] button');
  await dash.waitForFunction(() => {
    const el = document.getElementById('inviteResult');
    return el && el.innerText.includes('אײַנלאַדונג־קאָד');
  }, { timeout: 30000 });
  const code2 = await dash.evaluate(() => {
    const b = document.querySelector('#inviteResult b');
    return b ? b.textContent.trim() : '';
  });
  const invite2Ok = /^\d{6}$/.test(code2);
  const managedEmail2 = `e2e-managed2-${RUN}@filter.local`;
  await popup.fill('#regCode', code2);
  await popup.fill('#regName', 'E2E Managed Person 2');
  await popup.fill('#regEmail', managedEmail2);
  await popup.fill('#regDeviceName', 'E2E Managed Laptop 2');
  await popup.click('#registerBtn');
  await popup.waitForFunction(() => {
    const el = document.getElementById('regResult');
    return el && el.innerText.includes('רעגיסטרירט');
  }, { timeout: 60000 });
  const regResult2 = await popup.evaluate(() => document.getElementById('regResult').innerText);
  const stored2 = await popup.evaluate(async () => {
    const s = await chrome.storage.local.get(['fpDeviceId', 'fpCustomerId']);
    return { deviceId: s.fpDeviceId || null, customerId: s.fpCustomerId || null };
  });
  const deviceId2 = stored2.deviceId;
  const devApi2b = deviceId2 ? curlApi('GET', '/api/v1/devices/' + deviceId2) : null;
  // Manager unlinks from dashboard
  await dash.evaluate(() => loadCustomerView());
  await sleep(2000);
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
  const devApiUnlinked2 = curlApi('GET', '/api/v1/devices/' + deviceId2);
  await popup.click('#refresh');
  await sleep(2500);
  const managedByAfterMgrUnlink = await popup.evaluate(() => document.getElementById('managedBy').innerText);
  logStep('1e_relink_and_manager_unlink', {
    invite2Created: invite2Ok, regResult2, device2IdSaved: !!deviceId2,
    apiDevice2BeforeUnlink: devApi2b ? { name: devApi2b.data.name, managed_by_name: devApi2b.data.managed_by_name } : null,
    dashboardRowHadDevice2: mgrRow2.includes('E2E Managed Laptop 2'),
    apiManagedByAfterDashboardUnlink: devApiUnlinked2.data.managed_by_name,
    popupManagedByAfterRefresh: managedByAfterMgrUnlink,
    pass: (devApiUnlinked2.data.managed_by_name === null || devApiUnlinked2.data.managed_by_name === undefined) && managedByAfterMgrUnlink.includes('נישט פֿאַרוואַלט'),
  });

  // ===== 1f. Negative checks: spent code + wrong code =====
  const devsBeforeNeg = curlApi('GET', '/api/v1/devices?customer_id=' + stored2.customerId);
  await popup.fill('#regCode', code1); // spent code from step 1a
  await popup.fill('#regName', 'E2E Negative');
  await popup.fill('#regEmail', `e2e-neg-${RUN}@filter.local`);
  await popup.fill('#regDeviceName', 'E2E Negative Device');
  await popup.click('#registerBtn');
  await popup.waitForFunction(() => {
    const el = document.getElementById('regResult');
    return el && el.innerText.includes('טעות');
  }, { timeout: 30000 });
  const negSpent = await popup.evaluate(() => document.getElementById('regResult').innerText);
  const spentApi = curlRaw('POST', '/api/v1/devices/managed-register', { code: code1, name: 'E2E Negative', email: `e2e-neg-api-${RUN}@filter.local`, device_name: 'E2E Neg API' });
  await popup.fill('#regCode', '000000');
  await popup.click('#registerBtn');
  await popup.waitForFunction(() => {
    const el = document.getElementById('regResult');
    return el && el.innerText.includes('טעות');
  }, { timeout: 30000 });
  const negWrong = await popup.evaluate(() => document.getElementById('regResult').innerText);
  const devsAfterNeg = curlApi('GET', '/api/v1/devices?customer_id=' + stored2.customerId);
  logStep('1f_negative_checks', {
    spentCodePopupError: negSpent, spentCodeApiStatus: spentApi.status,
    wrongCodePopupError: negWrong,
    devicesForManagedCustomerBefore: devsBeforeNeg.data.length, devicesForManagedCustomerAfter: devsAfterNeg.data.length,
    pass: negSpent.includes('נישט גילטיק') && negWrong.includes('נישט גילטיק') && spentApi.status === 404 && devsBeforeNeg.data.length === devsAfterNeg.data.length,
  });

  // Save ids for cleanup (in results file, no codes/token)
  results.cleanupIds = { managerId, deviceId1, deviceId2, managedCustomerIds: [stored1.customerId, stored2.customerId], pol2Id, managedEmails: [managedEmail1, managedEmail2] };
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
