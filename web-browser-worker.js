// filter-platform-web-browser — web demo of the Filter Platform browser.
//
// A Cloudflare Worker that proxies a public web page, strips its CSP, rewrites
// its links so navigation stays inside the proxy, injects the filter pipeline
// (the SAME content.js / detector.js / detector-page.js / models the Android
// app ships, served from the Pages site), and decides each visual element
// with a direct JS translation of FilterEngine.decide (see
// android/app/src/main/java/com/filterplatform/app/FilterEngine.kt).
//
// This is a DEMO / TEST harness, not the phone app. Honest limits (also
// shown in the demo shell, public/browser.html):
//   * It runs in Chromium here, not GeckoView — Gecko-specific behaviour
//     is unproven by this demo.
//   * It runs the EfficientDet JS detector, NOT the native RF-DETR Kotlin
//     path (phone-only).
//   * Login flows / cookies on proxied sites mostly will not work.
//   * It CANNOT prove the GeckoView app launches on Yakob's phone.
//   * The EfficientDet-Lite0 weights are PROTOTYPE-ONLY (license
//     unverified — see models-mediapipe/LICENSES.md).
//
// Security notes:
//   * The filter API token lives ONLY as a Worker secret (env.API_TOKEN)
//     and is used server-side for the domain check. It NEVER appears in
//     any client-side file, URL, or injected script.
//   * SSRF guard ported from scanner/scanner.js (same IPv4/IPv6 blocked
//     ranges, credential URLs, non-http(s) schemes). The scanner also
//     resolves DNS and checks every resolved IP; a Worker has no DNS API,
//     so this Worker resolves through Cloudflare DNS-over-HTTPS instead
//     (best effort: if DoH itself is unreachable the navigation proceeds
//     and the status line says so — see SSRF_DOH below).
//   * SafeSearch rewrite is a port of FilterEngine.rewriteSafeSearch
//     (Google safe=active, Bing adlt=strict, DuckDuckGo kp=1, idempotent).
//   * Default policy = FilterEngine.DEFAULT_POLICY: block images, cover,
//     threshold 0.70. PERSON -> cover, NO_PERSON (conf >= 0.70) -> allow,
//     UNKNOWN / low confidence -> cover (fail closed).

const PAGES_ORIGIN = 'https://filter-platform-dashboard.pages.dev';
const API_BASE = 'https://filter-platform-api.gavhah-copy.workers.dev';
const DASHBOARD_URL = PAGES_ORIGIN + '/browser.html';
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 30000;
const DOMAIN_CHECK_TTL_MS = 120000;

// ---------------------------------------------------------------- SSRF guard
// Ported from scanner/scanner.js — same blocked ranges. Do not weaken.
const IPV4_BLOCKS = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
  '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
  '192.168.0.0/16', '198.51.100.0/24', '203.0.113.0/24',
  '224.0.0.0/4', '240.0.0.0/4',
];
const IPV4_NETS = IPV4_BLOCKS.map((cidr) => {
  const [addr, bits] = cidr.split('/');
  const n = addr.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
  const mask = bits === '0' ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
  return { n: (n & mask) >>> 0, mask, cidr };
});

function ipv4Blocked(ip) {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return 'unparsable IPv4';
  const n = o.reduce((a, x) => (a << 8) + x, 0) >>> 0;
  for (const { n: net, mask, cidr } of IPV4_NETS) {
    if (((n & mask) >>> 0) === net) return 'blocked range ' + cidr;
  }
  return null;
}

function ipv6Blocked(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return 'loopback/unspecified (::1/::)';
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return 'link-local (fe80::/10)';
  if (lower.startsWith('fc') || lower.startsWith('fd')) return 'unique-local (fc00::/7)';
  if (lower.startsWith('ff')) return 'multicast (ff00::/8)';
  if (lower.startsWith('2001:db8')) return 'documentation (2001:db8::/32)';
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice('::ffff:'.length);
    if (v4.includes('.')) return ipv4Blocked(v4);
    const groups = v4.split(':').filter(Boolean);
    const lastTwo = groups.slice(-2);
    if (lastTwo.length === 2 && lastTwo.every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
      const n = ((parseInt(lastTwo[0], 16) << 16) | parseInt(lastTwo[1], 16)) >>> 0;
      const dotted = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
      return ipv4Blocked(dotted);
    }
    return 'unparsable IPv4-mapped IPv6';
  }
  if (lower.startsWith('64:ff9b::')) return 'IPv4-embedded translation prefix';
  return null;
}

function ipBlocked(ip) {
  const v4 = /^\d+\.\d+\.\d+\.\d+$/.test(ip);
  if (v4) return ipv4Blocked(ip);
  if (ip.includes(':')) return ipv6Blocked(ip);
  return 'not an IP address (' + ip + ')';
}

function isLoopbackHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '::') return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host.split('.')[0] === '127';
  return false;
}

// Resolve a hostname through Cloudflare DNS-over-HTTPS and check every
// returned address against the blocked ranges (the scanner's DNS check,
// adapted: Workers have no dns.lookup). Returns { blocked, unavailable, reason }.
async function dohCheck(host) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    let res;
    try {
      res = await fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(host) + '&type=A', {
        headers: { accept: 'application/dns-json' }, signal: ctrl.signal,
      });
    } finally { clearTimeout(timer); }
    if (!res.ok) return { blocked: false, unavailable: true, reason: 'DoH HTTP ' + res.status };
    const j = await res.json();
    for (const a of (j.Answer || [])) {
      if (a.type === 1 || a.type === 28) {
        const why = ipBlocked(String(a.data));
        if (why) return { blocked: true, unavailable: false, reason: 'resolves to ' + a.data + ' (' + why + ')' };
      }
    }
    // AAAA pass (cheap second query; failure here is non-fatal).
    try {
      const ctrl2 = new AbortController();
      const timer2 = setTimeout(() => ctrl2.abort(), 3000);
      const res2 = await fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(host) + '&type=AAAA', {
        headers: { accept: 'application/dns-json' }, signal: ctrl2.signal,
      }).finally(() => clearTimeout(timer2));
      if (res2.ok) {
        const j2 = await res2.json();
        for (const a of (j2.Answer || [])) {
          if (a.type === 28) {
            const why = ipBlocked(String(a.data));
            if (why) return { blocked: true, unavailable: false, reason: 'resolves to ' + a.data + ' (' + why + ')' };
          }
        }
      }
    } catch (e) { /* AAAA check is best-effort */ }
    return { blocked: false, unavailable: false, reason: '' };
  } catch (e) {
    return { blocked: false, unavailable: true, reason: 'DoH unreachable: ' + String(e && e.message ? e.message : e).slice(0, 100) };
  }
}

// Full SSRF check for one URL string. Returns { ok, reason, dohUnavailable }.
async function ssrfCheck(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return { ok: false, reason: 'unparsable URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'scheme not allowed: ' + u.protocol };
  if (u.username || u.password) return { ok: false, reason: 'credentials in URL not allowed' };
  if (!u.hostname) return { ok: false, reason: 'missing hostname' };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return { ok: false, reason: 'localhost name' };
  if (isLoopbackHost(host)) return { ok: false, reason: 'loopback host' };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
    const why = ipBlocked(host.replace(/^\[|\]$/g, ''));
    if (why) return { ok: false, reason: why };
    return { ok: true };
  }
  if (host === 'metadata.google.internal') return { ok: false, reason: 'cloud metadata hostname' };
  const doh = await dohCheck(host);
  if (doh.blocked) return { ok: false, reason: 'SSRF block: host ' + host + ' — ' + doh.reason };
  return { ok: true, dohUnavailable: doh.unavailable, dohReason: doh.reason };
}

// ---------------------------------------------------------------- SafeSearch
// Port of FilterEngine.rewriteSafeSearch (FilterEngine.kt): idempotent.
const SAFESEARCH_RULES = [
  [/^https:\/\/(?:www\.)?google\.(?:com(?:\.[a-z]{2})?|co\.[a-z]{2}|[a-z]{2,3})\/search/i, ['safe', 'active']],
  [/^https:\/\/(?:www\.)?bing\.com\/search/i, ['adlt', 'strict']],
  [/^https:\/\/(?:www\.)?duckduckgo\.com\/.*[?&]q=/i, ['kp', '1']],
];

function rewriteSafeSearch(url) {
  const rule = SAFESEARCH_RULES.find(([re]) => re.test(url));
  if (!rule) return null;
  const [paramKey, paramValue] = rule[1];
  const hashIdx = url.indexOf('#');
  const fragment = hashIdx >= 0 ? url.substring(hashIdx) : '';
  const noFrag = hashIdx >= 0 ? url.substring(0, hashIdx) : url;
  const qIdx = noFrag.indexOf('?');
  const base = qIdx >= 0 ? noFrag.substring(0, qIdx) : noFrag;
  const query = qIdx >= 0 ? noFrag.substring(qIdx + 1) : '';
  const params = [];
  if (query) {
    for (const part of query.split('&')) {
      const eq = part.indexOf('=');
      if (eq >= 0) params.push([part.substring(0, eq), part.substring(eq + 1)]);
      else params.push([part, '']);
    }
  }
  const existing = params.findIndex(([k]) => k === paramKey);
  if (existing >= 0) {
    if (params[existing][1] === paramValue) return null; // already tagged
    params[existing] = [paramKey, paramValue];
  } else {
    params.push([paramKey, paramValue]);
  }
  const newQuery = params.map(([k, v]) => (v === '' ? k : k + '=' + v)).join('&');
  return base + '?' + newQuery + fragment;
}

// ---------------------------------------------------------------- domain check
const domainCache = new Map(); // host -> { decision, source, at }

// The API's /domains/check is an EXACT-host match, but the app matches
// subdomains too (FilterEngine.matchedBlockedHost: a subdomain of a
// blocked host is blocked). So check the full host first, then each parent
// domain (www.facebook.com -> facebook.com); the first explicit allow or
// block wins, and only a fully unlisted host falls through as unlisted.
// NOTE: Cloudflare error 1010 blocks non-browser User-Agents on
// *.workers.dev (verified 2026-11-19), so this server-to-server fetch
// MUST send a browser User-Agent or every check fails as unavailable.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let lastCheckDebug = '';
async function checkOneDomain(env, host) {
  const path = '/api/v1/domains/check?domain=' + encodeURIComponent(host);
  const headers = { Authorization: 'Bearer ' + env.API_TOKEN, 'User-Agent': BROWSER_UA };
  // Service binding first: direct worker-to-worker call, no public
  // network. (A public fetch to *.workers.dev from inside a Worker gets
  // Cloudflare error 1042 even with the subdomain enabled — verified
  // 2026-11-19 — so the public URL is only a fallback.)
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let res;
    try {
      if (env.FILTER_API && typeof env.FILTER_API.fetch === 'function') {
        res = await env.FILTER_API.fetch(new Request('https://filter-api' + path, { headers, signal: ctrl.signal }));
      } else {
        res = await fetch(API_BASE + path, { headers, signal: ctrl.signal });
      }
    } finally { clearTimeout(timer); }
    if (!res.ok) { lastCheckDebug = 'http-' + res.status; return null; }
    const j = await res.json();
    lastCheckDebug = 'ok';
    return { decision: (j.data && j.data.decision) || 'unknown', source: (j.data && j.data.source) || 'api' };
  } catch (e) {
    lastCheckDebug = 'fetch-error:' + String(e && e.message ? e.message : e).slice(0, 120);
    return null;
  }
}

async function checkDomain(env, host) {
  const now = Date.now();
  const cached = domainCache.get(host);
  if (cached && now - cached.at < DOMAIN_CHECK_TTL_MS) return cached;
  const out = { decision: 'unknown', source: 'api-unavailable', at: now, debug: '' };
  let apiAnswered = false;
  // Most specific host first, then parent domains.
  const labels = host.split('.');
  for (let i = 0; i <= labels.length - 2; i++) {
    const candidate = labels.slice(i).join('.');
    const r = await checkOneDomain(env, candidate);
    if (!r) break; // API offline/error: proceed with visual filtering only
    apiAnswered = true;
    // An explicit list entry (block, or allow with a real source) decides
    // here. 'unlisted-open' just means "not in the list" — keep looking
    // at the parent domain (www.facebook.com is unlisted, facebook.com
    // is blocked).
    if (r.decision === 'block') { out.decision = 'block'; out.source = r.source; break; }
    if (r.decision === 'allow' && r.source !== 'unlisted-open' && r.source !== 'unlisted') {
      out.decision = 'allow'; out.source = r.source; break;
    }
  }
  // The API answered but no candidate was on any list: the API's own
  // semantics for that is "unlisted-open" (allow), not "unknown".
  if (out.decision === 'unknown' && apiAnswered) { out.decision = 'allow'; out.source = 'unlisted-open'; }
  out.debug = lastCheckDebug;
  domainCache.set(host, out);
  return out;
}

// ---------------------------------------------------------------- pages
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function blockPage(host, source) {
  const h = escHtml(host);
  const s = escHtml(source || '');
  return '<!DOCTYPE html><html lang="yi" dir="rtl"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>דער פּלאַץ איז בלאקירט — פֿילטער פּלאַטפאָרם</title><style>'
    + '*{box-sizing:border-box}body{margin:0;padding:0;font:16px/1.6 system-ui,sans-serif;background:#f9fafb;color:#111827;direction:rtl}'
    + '.wrap{max-width:560px;margin:12vh auto 0;padding:32px 28px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.06);text-align:center}'
    + '.shield{font-size:48px;line-height:1}h1{font-size:24px;margin:12px 0 4px}'
    + '.domain{font-size:18px;font-weight:700;color:#b91c1c;direction:ltr;word-break:break-all}'
    + 'p{margin:10px 0}.policy{font-size:14px;color:#6b7280}'
    + '.actions{margin-top:22px;display:flex;flex-direction:column;gap:10px}'
    + 'a.btn,button.btn{display:block;padding:11px;border-radius:8px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}'
    + 'a.primary{background:#1d4ed8;color:#fff}a.secondary{background:#e5e7eb;color:#111827}'
    + 'button.back{background:none;border:1px solid #d1d5db;color:#374151}'
    + '.note{font-size:13px;color:#6b7280;margin-top:18px}</style></head><body>'
    + '<div class="wrap"><div class="shield">🛡️</div><h1>דער פּלאַץ איז בלאקירט</h1>'
    + '<div class="domain">' + h + '</div>'
    + '<p>דער פֿילטער האָט בלאקירט דעם פּלאַץ לויט דער פּאָליסי פֿון אײַער דיווייס.</p>'
    + '<p class="policy">מקור: ' + s + '</p>'
    + '<div class="actions">'
    + '<a class="btn primary" href="' + PAGES_ORIGIN + '" target="_blank" rel="noopener">בעטן אַן איבערקוק פֿון דעם פּלאַץ</a>'
    + '<a class="btn secondary" href="' + DASHBOARD_URL + '">גיי צום וועב־בלעטערער</a>'
    + '<button class="btn back" type="button" onclick="history.back()">↩ צוריק צום פֿריערדיקן בלאַט</button>'
    + '</div><p class="note">Filter Platform — Free kosher internet filter. דער פּלאַץ ווערט נישט געלאָדן; קיין אינהאַלט פֿון אים איז נישט געוויזן געוואָרן.</p>'
    + '</div></body></html>';
}

function errorPage(title, message) {
  return '<!DOCTYPE html><html lang="yi" dir="rtl"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>' + escHtml(title) + ' — פֿילטער פּלאַטפאָרם</title><style>'
    + 'body{margin:0;font:16px/1.6 system-ui,sans-serif;background:#f9fafb;color:#111827;direction:rtl}'
    + '.wrap{max-width:560px;margin:12vh auto 0;padding:32px 28px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;text-align:center}'
    + 'h1{font-size:22px}.url{direction:ltr;word-break:break-all;color:#6b7280;font-size:14px}'
    + 'a{display:inline-block;margin-top:16px;padding:11px 18px;border-radius:8px;background:#14324f;color:#fff;text-decoration:none;font-weight:600}'
    + '</style></head><body><div class="wrap"><h1>' + escHtml(title) + '</h1><p>' + escHtml(message) + '</p>'
    + '<a href="' + DASHBOARD_URL + '">צוריק צום וועב־בלעטערער</a></div></body></html>';
}

// ---------------------------------------------------------------- the shim
// Injected into every proxied page BEFORE content.js. Provides the TWO
// browser.* calls the app's content script uses (see task feasibility
// note, verified against android/app/src/main/assets/filter-extension/):
//   browser.runtime.getURL(p)     -> '/browser-assets/' + p  (same-origin
//                                  through this Worker, so no CORS is needed
//                                  for the models / WASM / detector iframe)
//   browser.runtime.sendMessage(m)-> the in-page filter engine below.
//
// The in-page engine is a direct JS translation of FilterEngine.decide +
// JsReportedPersonDetector + DEFAULT_POLICY (FilterEngine.kt):
//   default policy: blockImages=true, coverImages=true, threshold 0.70
//   PERSON           -> cover (blockImages + coverImages => COVER)
//   NO_PERSON, conf >= 0.70 -> allow
//   UNKNOWN / low confidence  -> cover (fail closed; REVIEW is sent as cover,
//                                exactly like FilterEngine.buildDecisionsMessage)
// It also reports live status to the demo shell (the parent frame) via
// postMessage, because the shell cannot read inside the cross-origin iframe.
const SHIM_JS = `(function () {
  'use strict';
  var THRESHOLD = 0.70;   // FilterEngine.DEFAULT_POLICY.autoDecideThreshold
  var SCORE_FLOOR = 0.40; // JsReportedPersonDetector.SCORE_FLOOR
  var verdicts = {};      // element id -> latest verdict ('allow'/'cover'/'block')
  var readyPosted = false;

  // JsReportedPersonDetector.detect, translated from FilterEngine.kt.
  function detect(f) {
    if (!f.detected) return { outcome: 'UNKNOWN', confidence: 0 };
    var best = Math.max(f.personBest || 0, f.faceBest || 0);
    if ((f.persons || 0) > 0 || (f.faces || 0) > 0) {
      if (best >= THRESHOLD) return { outcome: 'PERSON', confidence: best };
      return { outcome: 'UNKNOWN', confidence: 0 };
    }
    if (best >= SCORE_FLOOR) return { outcome: 'UNKNOWN', confidence: 0 };
    return { outcome: 'NO_PERSON', confidence: 1.0 };
  }

  // FilterEngine.decide, translated from FilterEngine.kt (DEFAULT_POLICY:
  // blockImages=true, coverImages=true, threshold 0.70).
  function decide(f) {
    var r = detect(f);
    if (r.outcome === 'PERSON') return 'cover';
    if (r.outcome === 'NO_PERSON' && r.confidence >= THRESHOLD) return 'allow';
    return 'cover'; // UNKNOWN / low confidence -> REVIEW -> cover (fail closed)
  }

  function counts() {
    var c = { covered: 0, allowed: 0, blocked: 0, scanned: 0 };
    for (var id in verdicts) {
      c.scanned++;
      if (verdicts[id] === 'allow') c.allowed++;
      else if (verdicts[id] === 'block') c.blocked++;
      else c.covered++;
    }
    return c;
  }

  function postStatus() {
    try {
      var c = counts();
      var proxy = window.__fpProxy || {};
      window.parent.postMessage({
        type: 'fp-status', source: 'filter-platform-web',
        target: proxy.target || location.href,
        apiCheck: proxy.apiCheck || 'unknown',
        dohUnavailable: !!proxy.dohUnavailable,
        detectorReady: !!window.__fpPersonReady,
        covered: c.covered, allowed: c.allowed, blocked: c.blocked, scanned: c.scanned
      }, '*');
    } catch (e) { /* parent gone */ }
  }

  // Tell the shell we loaded (so it can show the real target URL and the
  // domain-check state even before the first scan finishes).
  try {
    var proxy0 = window.__fpProxy || {};
    window.parent.postMessage({
      type: 'fp-loaded', source: 'filter-platform-web',
      target: proxy0.target || location.href,
      apiCheck: proxy0.apiCheck || 'unknown',
      dohUnavailable: !!proxy0.dohUnavailable
    }, '*');
  } catch (e) { /* parent gone */ }

  // Detector-ready polling: content.js sets window.__fpPersonReady when the
  // MediaPipe detector is up; report it once so the shell can show it.
  var readyTimer = setInterval(function () {
    if (window.__fpPersonReady && !readyPosted) {
      readyPosted = true;
      clearInterval(readyTimer);
      postStatus();
    }
  }, 1000);
  setTimeout(function () { clearInterval(readyTimer); }, 120000);

  window.browser = { runtime: {
    getURL: function (p) { return '/browser-assets/' + p; },
    sendMessage: function (msg) {
      try {
        var out = { type: 'decisions', decisions: [] };
        if (msg && msg.type === 'scan' && Array.isArray(msg.findings)) {
          for (var i = 0; i < msg.findings.length; i++) {
            var f = msg.findings[i];
            var v = decide(f);
            verdicts[f.id] = v;
            out.decisions.push({ id: f.id, verdict: v });
          }
        }
        postStatus();
        return Promise.resolve(out);
      } catch (e) { return Promise.reject(e); }
    }
  } };
})();`;

// Minimal shim for the detector iframe page (detector.html, served through
// this Worker under /browser-assets/detector.html). detector-page.js only
// uses browser.runtime.getURL (WASM + .tflite paths); it never sendMessages.
const DETECTOR_SHIM_JS = `window.browser={runtime:{getURL:function(p){return '/browser-assets/'+p;}}};`;

// Scripts injected at the end of every proxied HTML page, in order:
// shim (defines window.browser) -> face-api -> detector bridge -> content script.
function injectionHtml(proxyInfoJson) {
  return '<script>window.__fpProxy=' + proxyInfoJson + ';</script>'
    + '<script>' + SHIM_JS + '</script>'
    + '<script src="/browser-assets/vendor/face-api.js"></script>'
    + '<script src="/browser-assets/detector.js"></script>'
    + '<script src="/browser-assets/content.js"></script>';
}

// ---------------------------------------------------------------- rewriting
function toProxy(value, baseUrl) {
  if (!value) return value;
  const v = value.trim();
  if (!v || v.startsWith('#') || v.startsWith('data:') || v.startsWith('blob:')
    || v.startsWith('mailto:') || v.startsWith('tel:') || v.startsWith('javascript:')) return value;
  let abs;
  try { abs = new URL(v, baseUrl); } catch (e) { return value; }
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return value;
  return '/browse?u=' + encodeURIComponent(abs.toString());
}

function rewriteSrcset(value, baseUrl) {
  return value.split(',').map((part) => {
    const pieces = part.trim().split(/\s+/);
    if (!pieces[0]) return part;
    pieces[0] = toProxy(pieces[0], baseUrl);
    return pieces.join(' ');
  }).join(', ');
}

function rewriteCssUrls(css, baseUrl) {
  let out = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
    const r = toProxy(u, baseUrl);
    return r === u ? m : 'url(' + (q || '') + r + (q || '') + ')';
  });
  out = out.replace(/@import\s+['"]([^'"]+)['"]/gi, (m, u) => {
    const r = toProxy(u, baseUrl);
    return r === u ? m : '@import "' + r + '"';
  });
  return out;
}

function rewriterFor(targetUrl) {
  const rw = new HTMLRewriter();
  const urlAttrs = { a: ['href'], area: ['href'], link: ['href'] };
  const srcAttrs = ['img', 'script', 'source', 'video', 'audio', 'iframe', 'embed', 'track', 'input'];
  for (const [tag, attrs] of Object.entries(urlAttrs)) {
    rw.on(tag, {
      element(el) {
        for (const a of attrs) {
          const v = el.getAttribute(a);
          if (v) el.setAttribute(a, toProxy(v, targetUrl));
        }
      },
    });
  }
  for (const tag of srcAttrs) {
    rw.on(tag, {
      element(el) {
        const src = el.getAttribute('src');
        if (src) el.setAttribute('src', toProxy(src, targetUrl));
        const srcset = el.getAttribute('srcset');
        if (srcset) el.setAttribute('srcset', rewriteSrcset(srcset, targetUrl));
        const style = el.getAttribute('style');
        if (style && style.includes('url(')) el.setAttribute('style', rewriteCssUrls(style, targetUrl));
      },
    });
  }
  rw.on('form', {
    element(el) {
      const a = el.getAttribute('action');
      if (a) el.setAttribute('action', toProxy(a, targetUrl));
    },
  });
  // Any other element can carry an inline background-image.
  rw.on('*', {
    element(el) {
      const style = el.getAttribute('style');
      if (style && style.includes('url(')) el.setAttribute('style', rewriteCssUrls(style, targetUrl));
    },
  });
  rw.on('style', {
    text(t) {
      const r = rewriteCssUrls(t.text, targetUrl);
      if (r !== t.text) t.replace(r);
    },
  });
  // Strip the page's own CSP (a proxy must, or the injected filter scripts
  // and the detector iframe get blocked) and <base> (relative URLs are
  // rewritten to absolute /browse?u=... above, so a <base> would only lie).
  rw.on('meta', {
    element(el) {
      const equiv = (el.getAttribute('http-equiv') || '').toLowerCase();
      if (equiv === 'content-security-policy' || equiv === 'content-security-policy-report-only') el.remove();
    },
  });
  rw.on('base', { element(el) { el.remove(); } });
  return rw;
}

const STRIP_HEADERS = new Set([
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'set-cookie', 'cross-origin-embedder-policy',
  'cross-origin-opener-policy', 'cross-origin-resource-policy',
]);

function cleanHeaders(upstreamHeaders) {
  const h = new Headers();
  for (const [k, v] of upstreamHeaders.entries()) {
    if (STRIP_HEADERS.has(k.toLowerCase())) continue;
    // Content-Length / Content-Encoding are re-derived by the runtime for
    // transformed bodies; keep them only on binary passthrough (handled
    // by the caller passing the original Response through untouched).
    if (k.toLowerCase() === 'content-length') continue;
    h.set(k, v);
  }
  return h;
}

// ---------------------------------------------------------------- assets
const ASSET_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.tflite': 'application/octet-stream',
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

async function serveAsset(path, request, ctx) {
  const assetUrl = PAGES_ORIGIN + '/browser-assets/' + path;
  const cache = caches.default;
  const cacheKey = new Request('https://filter-platform-web-browser.gavhah-copy.workers.dev/browser-assets/' + path);
  let res = await cache.match(cacheKey);
  if (!res) {
    res = await fetch(assetUrl, { headers: { 'Accept-Encoding': 'identity' } });
    if (!res.ok) return new Response('asset not found: ' + path, { status: res.status });
    // Cache a clone; the WASM (15 MB) and .tflite (7 MB) are fetched once.
    const toCache = new Response(res.body, { headers: res.headers, status: res.status });
    ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
    res = toCache;
  }
  const headers = new Headers(res.headers);
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (ASSET_TYPES[ext]) headers.set('Content-Type', ASSET_TYPES[ext]);
  headers.set('Cache-Control', 'public, max-age=86400');
  if (path === 'detector.html') {
    // Inject the tiny browser.* shim so detector-page.js can resolve its
    // model/WASM paths through this Worker (same-origin, no CORS needed).
    const html = await res.text();
    const injected = html.replace('<body>', '<body><script>' + DETECTOR_SHIM_JS + '</script>');
    return new Response(injected, { headers });
  }
  return new Response(res.body, { headers, status: res.status });
}

// ---------------------------------------------------------------- proxy fetch
async function fetchTarget(env, startUrl, request) {
  let current = startUrl;
  let dohUnavailable = false;
  let dohReason = '';
  let lastRes = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = await ssrfCheck(current);
    if (!check.ok) return { blocked: true, reason: check.reason };
    if (check.dohUnavailable) { dohUnavailable = true; dohReason = check.dohReason || ''; }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const headers = new Headers();
      const ct = request.headers.get('Content-Type');
      if (ct) headers.set('Content-Type', ct);
      const range = request.headers.get('Range');
      if (range) headers.set('Range', range);
      headers.set('Accept-Encoding', 'identity');
      headers.set('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 FilterPlatformWebBrowser/0.1');
      headers.set('Accept', request.headers.get('Accept') || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
      headers.set('Accept-Language', 'en-US,en;q=0.9');
      const init = { method: request.method, headers, redirect: 'manual', signal: ctrl.signal };
      if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;
      lastRes = await fetch(current, init);
    } catch (e) {
      return { fetchError: String(e && e.message ? e.message : e).slice(0, 200) };
    } finally { clearTimeout(timer); }
    const loc = lastRes.headers.get('Location');
    if (lastRes.status >= 300 && lastRes.status < 400 && loc) {
      if (hop === MAX_REDIRECTS) return { blocked: true, reason: 'too many redirects (>' + MAX_REDIRECTS + ')' };
      try { current = new URL(loc, current).toString(); } catch (e) { return { blocked: true, reason: 'bad redirect Location' }; }
      continue;
    }
    return { res: lastRes, finalUrl: current, dohUnavailable, dohReason };
  }
  return { blocked: true, reason: 'too many redirects (>' + MAX_REDIRECTS + ')' };
}

// ---------------------------------------------------------------- main
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/' || path === '') {
      return Response.redirect(DASHBOARD_URL, 302);
    }
    if (path === '/health') {
      return new Response(JSON.stringify({ service: 'filter-platform-web-browser', status: 'ok', time: new Date().toISOString() }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (path.startsWith('/browser-assets/')) {
      const asset = path.slice('/browser-assets/'.length);
      if (!asset || asset.includes('..')) return new Response('not found', { status: 404 });
      return serveAsset(asset, request, ctx);
    }
    if (path !== '/browse') return new Response('Not found', { status: 404 });

    const rawU = url.searchParams.get('u');
    if (!rawU) return Response.redirect(DASHBOARD_URL, 302);
    let target;
    try {
      target = new URL(rawU);
      // GET form submits arrive as extra query params on /browse — merge
      // them into the target URL (e.g. ?u=<search>&q=...).
      for (const [k, v] of url.searchParams.entries()) {
        if (k === 'u') continue;
        target.searchParams.append(k, v);
      }
    } catch (e) {
      return new Response(errorPage('אומגילטיקע אַדרעס', 'די אַדרעס קען נישט געלײֵנט ווערן: ' + rawU), {
        status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // SafeSearch rewrite on the navigation (port of FilterEngine.rewriteSafeSearch).
    const rewritten = rewriteSafeSearch(target.toString());
    if (rewritten) target = new URL(rewritten);

    // Blocked-domain check (server-side, API token never leaves the Worker).
    const domain = checkDomain(env, target.hostname.toLowerCase());
    const checked = await domain;
    if (checked.decision === 'block') {
      return new Response(blockPage(target.hostname, checked.source), {
        status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    const apiCheck = checked.decision === 'unknown' ? 'unavailable' : 'ok';

    const fetched = await fetchTarget(env, target.toString(), request);
    if (fetched.blocked) {
      return new Response(errorPage('דער פּלאַץ איז בלאקירט', 'דער פּראָקסי האָט אָפּגעוואָרפֿן די אַדרעס: ' + fetched.reason), {
        status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    if (fetched.fetchError) {
      return new Response(errorPage('דער פּלאַץ לאָדט זיך נישט', 'מען האָט נישט געקענט פֿעטשן דעם פּלאַץ (' + fetched.fetchError + '). פּרוּווט שפּעטער נאָך אַ מאָל.'), {
        status: 502, headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    const upstream = fetched.res;
    const finalUrl = fetched.finalUrl;
    const ctype = (upstream.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();

    // Non-HTML: pass through (images, video, JS, ...). Subresource fetches
    // arrive here as /browse?u=<absolute url> thanks to the rewriter.
    if (ctype !== 'text/html' && ctype !== 'application/xhtml+xml') {
      if (ctype === 'text/css') {
        const css = await upstream.text();
        const headers = cleanHeaders(upstream.headers);
        headers.set('Content-Type', 'text/css; charset=utf-8');
        return new Response(rewriteCssUrls(css, finalUrl), { status: upstream.status, headers });
      }
      // Binary passthrough, preserving status + Range semantics.
      const headers = new Headers();
      for (const [k, v] of upstream.headers.entries()) {
        if (STRIP_HEADERS.has(k.toLowerCase())) continue;
        headers.set(k, v);
      }
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    // HTML: rewrite + inject the filter pipeline.
    const proxyInfo = JSON.stringify({
      target: finalUrl,
      apiCheck,
      dohUnavailable: !!fetched.dohUnavailable,
      dohReason: fetched.dohReason || '',
    });
    const rw = rewriterFor(finalUrl);
    const headers = cleanHeaders(upstream.headers);
    headers.set('Content-Type', 'text/html; charset=utf-8');
    headers.set('Cache-Control', 'no-store');
    headers.set('X-FP-Domain-Debug', (checked.debug || '').slice(0, 200));
    const transformed = rw.transform(new Response(upstream.body, { status: upstream.status, headers }));
    // HTMLRewriter's document-end injection: append the shim + scripts.
    // (transform() returns a Response; wrap it so the injection lands at
    // the end of the document.)
    const injected = new HTMLRewriter()
      .onDocument({ end(end) { end.append(injectionHtml(proxyInfo), { html: true }); } })
      .transform(transformed);
    return injected;
  },
};
