// Filter Platform popup — Yiddish UI. Token + device id are typed by the
// user and kept in chrome.storage.local only; nothing is bundled in code.
const $ = (id) => document.getElementById(id);

async function loadState() {
  const s = await chrome.storage.local.get([
    'fpToken', 'fpDeviceId', 'fpCustomerId', 'fpDemoMode', 'fpStatus', 'fpStats'
  ]);
  $('token').value = s.fpToken || '';
  $('deviceId').value = s.fpDeviceId || '';
  $('customerId').value = s.fpCustomerId || '';
  $('demoMode').value = s.fpDemoMode || 'policy';
  renderStatus(s.fpStatus, s.fpStats);
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
});
$('demoMode').addEventListener('change', async () => {
  await chrome.storage.local.set({ fpDemoMode: $('demoMode').value });
});

loadState();
