const { chromium } = require('playwright');
const fs = require('fs');
const crypto = require('crypto');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome',
    args: ['--proxy-server=http://127.0.0.1:18080','--proxy-bypass-list=localhost;127.0.0.1','--ignore-certificate-errors','--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  const urls = {
    'pages content.js': 'https://filter-platform-dashboard.pages.dev/browser-assets/content.js',
    'worker content.js': 'https://filter-platform-web-browser.gavhah-copy.workers.dev/browser-assets/content.js',
    'pages browser.html': 'https://filter-platform-dashboard.pages.dev/browser',
  };
  for (const [name, url] of Object.entries(urls)) {
    const t = await page.evaluate(async (u) => {
      const resp = await fetch(u); const txt = await resp.text();
      return { status: resp.status, text: txt };
    }, url);
    const sha = crypto.createHash('sha256').update(t.text).digest('hex');
    console.log(name, JSON.stringify({ status: t.status, len: t.text.length, sha, hasPolicyReq: t.text.includes('fp-policy-request') }));
  }
  console.log('local content.js', crypto.createHash('sha256').update(fs.readFileSync('/home/hatch/workspace/filter-platform/public/browser-assets/content.js')).digest('hex'));
  console.log('local browser.html hasPolicyReq:', fs.readFileSync('/home/hatch/workspace/filter-platform/public/browser.html','utf8').includes('fp-policy-request'));
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
