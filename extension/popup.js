// Filter Platform popup — Yiddish UI. Token + device id are typed by the
// user and kept in chrome.storage.local only; nothing is bundled in code.
const $ = (id) => document.getElementById(id);
const API_BASE = 'https://filter-platform-api.gavhah-copy.workers.dev';

async function apiCall(method, path, body, token) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

// "Managed by" display — everything the manager can see or do is shown
// here; nothing manager-visible is hidden from the managed person.
async function loadManagedInfo() {
  const box = $('managedBy');
  const unlinkBtn = $('unlink');
  unlinkBtn.style.display = 'none';
  const s = await chrome.storage.local.get(['fpToken', 'fpDeviceId']);
  if (!s.fpDeviceId || !s.fpToken) {
    box.textContent = 'קיין דיווייס ID נישטאָ — רעגיסטרירט זיך מיט אַ קאָד אונטן, אָדער שפּאָרט אַ דיווייס ID אויבן.';
    return;
  }
  try {
    const d = await apiCall('GET', '/api/v1/devices/' + encodeURIComponent(s.fpDeviceId), null, s.fpToken);
    const dev = d.data;
    if (dev.managed_by_name) {
      box.textContent = '⚠️ דעם דיווייס פֿאַרוואַלט: ' + dev.managed_by_name + '\n'
        + 'פּאָליסי וואָס ווערט אָנגעווענדט: ' + (dev.policy_name || '?') + '\n'
        + 'דער מאַנאַדזשער קען זען צי דער דיווייס איז אָנליין, און טוישן זײַן פּאָליטיק. ער/זי קען נישט זען אײַערע בלעטער אָדער פּאַסווערטער.';
      box.className = 'status bad';
      unlinkBtn.style.display = '';
    } else {
      box.textContent = 'דער דיווייס איז נישט פֿאַרוואַלט פֿון קיינעם — נאָר איר אַליין באַשטימט די פּאָליסי.';
      box.className = 'status ok';
    }
  } catch (e) {
    box.textContent = 'קען נישט לאָדן פֿאַרוואַלטונג־אינפֿאָ: ' + e.message;
    box.className = 'status bad';
  }
}

async function registerWithCode() {
  const btn = $('registerBtn');
  const out = $('regResult');
  out.style.display = '';
  const token = $('token').value.trim();
  const code = $('regCode').value.trim();
  const name = $('regName').value.trim();
  const email = $('regEmail').value.trim();
  const deviceName = $('regDeviceName').value.trim();
  if (!token) { out.textContent = '❌ גיט אַרײַן דעם API טאָוקן אויבן ערשט — דער מאַנאַדזשער גיט אים אײַך צוזאַמען מיטן קאָד.'; out.className = 'status bad'; return; }
  if (!code || !name || !email) { out.textContent = '❌ פֿילט אויס קאָד, נאָמען און אימעיל.'; out.className = 'status bad'; return; }
  btn.disabled = true;
  btn.textContent = 'רעגיסטרירט…';
  try {
    const d = await apiCall('POST', '/api/v1/devices/managed-register', {
      code, name, email, platform: 'windows',
      device_name: deviceName || undefined
    }, token);
    const dev = d.data.device;
    const cust = d.data.customer;
    await chrome.storage.local.set({
      fpToken: token,
      fpDeviceId: dev.id,
      fpCustomerId: cust.id
    });
    $('deviceId').value = dev.id;
    $('customerId').value = cust.id;
    out.textContent = '✅ רעגיסטרירט! דער דיווייס "' + dev.name + '" ווערט איצט פֿאַרוואַלט פֿון '
      + (d.data.manager_name || '?') + ', מיט דער פּאָליסי "' + (d.data.policy ? d.data.policy.name : '?') + '".';
    out.className = 'status ok';
    const st = await chrome.runtime.sendMessage({ type: 'refresh' });
    const s = await chrome.storage.local.get(['fpStats']);
    renderStatus(st, s.fpStats);
    await loadManagedInfo();
  } catch (e) {
    const msg = /Invalid or already-used/i.test(e.message)
      ? 'דער קאָד איז נישט גילטיק אָדער שוין גענוצט — בעט דעם מאַנאַדזשער פֿאַר אַ נײַעם קאָד.'
      : e.message;
    out.textContent = '❌ טעות: ' + msg;
    out.className = 'status bad';
  } finally {
    btn.disabled = false;
    btn.textContent = 'רעגיסטרירן';
  }
}

async function unlinkSelf() {
  const s = await chrome.storage.local.get(['fpToken', 'fpDeviceId']);
  if (!s.fpDeviceId || !s.fpToken) return;
  if (!confirm('זענט איר זיכער אַז איר ווילט זיך אָפּקאַפּלען פֿון דער פֿאַרוואַלטונג? דער מאַנאַדזשער וועט אײַך מער נישט פֿאַרוואַלטן.')) return;
  const box = $('managedBy');
  try {
    await apiCall('POST', '/api/v1/devices/' + encodeURIComponent(s.fpDeviceId) + '/unlink', {}, s.fpToken);
    box.textContent = '✅ דער דיווייס איז מער נישט פֿאַרוואַלט פֿון קיינעם.';
    box.className = 'status ok';
    $('unlink').style.display = 'none';
    const st = await chrome.runtime.sendMessage({ type: 'refresh' });
    const ss = await chrome.storage.local.get(['fpStats']);
    renderStatus(st, ss.fpStats);
  } catch (e) {
    box.textContent = '❌ אָפּקאַפּלען נישט געלונגען: ' + e.message;
    box.className = 'status bad';
  }
}

// Update banner (v1.2.1): shown when background.js found a newer version
// in versions.json on our own website. Hidden when versions match.
async function loadUpdateBanner() {
  const s = await chrome.storage.local.get(['fpUpdateAvailable', 'fpLatestVersion']);
  const banner = $('updateBanner');
  if (s.fpUpdateAvailable && s.fpLatestVersion) {
    $('updateVersion').textContent = 'ווערסיע ' + s.fpLatestVersion;
    // 'block', not '' — the .update-banner CSS rule sets display:none,
    // so clearing the inline style would keep it hidden.
    banner.style.display = 'block';
  } else {
    banner.style.display = 'none';
  }
}

async function loadState() {
  const s = await chrome.storage.local.get([
    'fpToken', 'fpDeviceId', 'fpCustomerId', 'fpDemoMode', 'fpStatus', 'fpStats'
  ]);
  $('token').value = s.fpToken || '';
  $('deviceId').value = s.fpDeviceId || '';
  $('customerId').value = s.fpCustomerId || '';
  $('demoMode').value = s.fpDemoMode || 'policy';
  renderStatus(s.fpStatus, s.fpStats);
  loadManagedInfo();
  loadUpdateBanner();
}

function renderStatus(st, stats) {
  const el = $('status');
  if (!st) { el.textContent = 'קיין סינק נאָך — שפּאָרן דעם טאָוקן און דיווייס ID.'; return; }
  const lines = [];
  lines.push(st.policyFetched
    ? '✅ פּאָליסי: ' + (st.policyName || '?')
    : '❌ סינק ניט געלונגען: ' + (st.error || '?'));
  if (st.policyFetched) {
    lines.push('בילדער: ' + (st.block_images ? 'בלאקירן' : st.cover_images ? 'באַדעקן' : 'אָפֿן'));
    lines.push('בלאקירטע דאמיינען: ' + (st.blocklistDomains ?? '?') + '  •  DNR כּללים: ' + (st.rulesCount ?? '?'));
    lines.push('אַדס־פֿילטער: ' + (st.adsEnforced
      ? 'אָן — ' + (st.adRulesCount ?? '?') + ' כּללים פֿון ' + (st.adBlocklistDomains ?? '?') + ' דאָמעינס'
      : 'אויס (פּאָליטיק filter_ads=ניין)'));
    lines.push('לעצטע סינק: ' + (st.lastSync || '?'));
  }
  el.textContent = lines.join('\n');
  el.className = 'status ' + (st.policyFetched ? 'ok' : 'bad');

  const se = $('stats');
  if (stats) {
    se.textContent = 'סטאַטיסטיק: בלעטער ' + (stats.pages || 0)
      + ' • געסקאַנט ' + (stats.scanned || 0)
      + ' • מענטשן ' + (stats.human || 0)
      + ' • בלאקירט ' + (stats.blocked || 0)
      + ' • באַדעקט ' + (stats.covered || 0)
      + ' • אומזיכער ' + (stats.uncertain || 0);
  } else {
    se.textContent = 'קיין סטאַטיסטיק נאָך.';
  }
}

async function saveAndSync() {
  const btn = $('save');
  btn.disabled = true;
  btn.textContent = 'סינקט…';
  try {
    await chrome.storage.local.set({
      fpToken: $('token').value.trim(),
      fpDeviceId: $('deviceId').value.trim(),
      fpCustomerId: $('customerId').value.trim(),
      fpDemoMode: $('demoMode').value
    });
    const st = await chrome.runtime.sendMessage({ type: 'refresh' });
    const s = await chrome.storage.local.get(['fpStats']);
    renderStatus(st, s.fpStats);
  } catch (e) {
    $('status').textContent = '❌ טעות: ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'שפּאָרן + סינק פּאָליסי';
  }
}

$('save').addEventListener('click', saveAndSync);
$('refresh').addEventListener('click', async () => {
  const st = await chrome.runtime.sendMessage({ type: 'refresh' });
  const s = await chrome.storage.local.get(['fpStats']);
  renderStatus(st, s.fpStats);
  loadManagedInfo();
});
$('registerBtn').addEventListener('click', registerWithCode);
$('unlink').addEventListener('click', unlinkSelf);
$('demoMode').addEventListener('change', async () => {
  await chrome.storage.local.set({ fpDemoMode: $('demoMode').value });
});

loadState();
