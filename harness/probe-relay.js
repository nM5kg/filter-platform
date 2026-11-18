const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--proxy-server=http://127.0.0.1:18080'] });
  const page = await browser.newPage();
  const r = await page.goto('https://filter-platform-api.gavhah-copy.workers.dev/health', { timeout: 30000 });
  console.log('health nav status:', r.status(), (await r.text()).slice(0, 120));
  const f = await page.evaluate(async () => {
    try { const res = await fetch('https://filter-platform-api.gavhah-copy.workers.dev/health'); return { ok: res.ok, status: res.status, body: (await res.text()).slice(0, 120) }; }
    catch (e) { return { error: String(e) }; }
  });
  console.log('page fetch:', JSON.stringify(f));
  await browser.close();
})().catch(e => { console.error('PROBE FAILED:', e.message); process.exit(1); });
