/**
 * scanner.js — AI Pre-Rendering Website Inspection & Visual Protection Engine
 * (prototype, v0.1.0) for the Filter Platform.
 *
 * Usage:
 *   node scanner.js <url> [--out results/<slug>.json] [--policy standard]
 *     [--max-images 40] [--proxy http://127.0.0.1:18080]
 *     [--spki-pin <base64-sha256>] [--screenshot]
 *
 * What it does:
 *   1. SSRF-protects the URL (scheme, credentials, DNS resolution against
 *      private/loopback/link-local/reserved ranges, redirect cap) and
 *      enforces the same check on EVERY subresource request.
 *   2. Renders the page in a fresh, isolated headless-Chromium context,
 *      scrolls to trigger lazy loading, then collects rendered visual
 *      elements (<img>, CSS backgrounds, <svg> images, <canvas>, <video>).
 *   3. Detects people on-device, CPU-first, with a real person detector
 *      (MediaPipe ObjectDetector, EfficientDet-Lite0) plus face-api.js
 *      tinyFaceDetector as fallback/complement — see detector.js.
 *      A person OR face hit counts as human.
 *   4. Emits a Visual Content Map JSON with per-element
 *      ALLOW / COVER / BLOCK / REVIEW decisions under the Standard policy.
 *
 * Sandbox notes:
 *   - The scanner NEVER trusts page JavaScript: detection runs in the page
 *     only because face-api needs DOM image pixels; no page script output
 *     is executed by Node, and all values crossing the boundary are
 *     plain JSON (numbers/strings/booleans).
 *   - TLS is strict by default. --spki-pin pins ONE extra CA (base64
 *     SPKI SHA-256) and exists only for sandboxes whose egress proxy
 *     MITMs TLS (e.g. this Hatch VM). Never use it in production.
 *   - --no-sandbox is passed ONLY when running as root (uid 0), which
 *     Chromium refuses otherwise; production runs as a non-root user
 *     with the Chromium sandbox intact.
 *   - A proxy is used only when --proxy / SCANNER_PROXY is set. In
 *     production the scanner container has direct internet; in this
 *     sandbox the relay at 127.0.0.1:18080 adapts the egress proxy's
 *     auth (see ../harness/egress-relay.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { chromium } = require('playwright');
const { createDetector, PERSON_MODEL_NAME, FACE_MODEL_NAME } = require('./detector');

const MODELS_DIR = path.join(__dirname, 'models');
const POLICY_VERSION = 'standard-v1';
// Standard policy (Phase 1 default): block images of people, cover nothing
// by default, explicit words blocked elsewhere in the pipeline.
const POLICY = { block_images: true, cover_images: false, threshold: 0.70 };
const NAV_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_IMAGES = 40;          // detection budget per scan (largest first)
const SCAN_HARD_CAP_MS = 180_000;

// ---------------------------------------------------------------- SSRF guard
const IPV4_BLOCKS = [
  '0.0.0.0/8',        // this network
  '10.0.0.0/8',       // private
  '100.64.0.0/10',    // CGNAT
  '127.0.0.0/8',      // loopback
  '169.254.0.0/16',   // link-local
  '172.16.0.0/12',    // private
  '192.0.0.0/24',     // reserved (IETF protocol assignments)
  '192.0.2.0/24',     // TEST-NET-1
  '192.168.0.0/16',   // private
  '198.51.100.0/24',  // TEST-NET-2
  '203.0.113.0/24',   // TEST-NET-3
  '224.0.0.0/4',      // multicast
  '240.0.0.0/4',      // reserved
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
    if ((n & mask) >>> 0 === net) return `blocked range ${cidr}`;
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
    // IPv4-mapped: check the embedded IPv4 address. WHATWG URL
    // serializes these in hex ('::ffff:808:808'), so parse the last
    // two 16-bit groups as the four IPv4 octets; dotted form is also
    // accepted for direct hostAllowed() calls.
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
  const fam = net.isIP(ip);
  if (fam === 4) return ipv4Blocked(ip);
  if (fam === 6) return ipv6Blocked(ip);
  return `not an IP address (${ip})`;
}

const dnsCache = new Map(); // hostname -> { ok, reason } (per-process)

// TEST-ONLY override (default OFF): SCANNER_ALLOW_LOOPBACK=1 lets the
// scanner target loopback hosts so it can be verified against local test
// pages (scanner/test-video-canvas/). It disables the SSRF guard for
// loopback only and is recorded in failures[] on every run that sets it.
// NEVER set in production.
const LOOPBACK_OVERRIDE = process.env.SCANNER_ALLOW_LOOPBACK === '1';
function isLoopbackHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '::') return true;
  if (net.isIP(host) === 4) return host.split('.')[0] === '127';
  return false;
}

async function hostAllowed(hostname) {
  // URL.hostname returns IPv6 literals with brackets ('[::1]') — strip them.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (LOOPBACK_OVERRIDE && isLoopbackHost(host)) return { ok: true, reason: 'TEST-ONLY: SCANNER_ALLOW_LOOPBACK=1' };
  if (host === 'localhost' || host.endsWith('.localhost')) return { ok: false, reason: 'localhost name' };
  if (net.isIP(host)) {
    const why = ipBlocked(host);
    return why ? { ok: false, reason: why } : { ok: true };
  }
  if (dnsCache.has(host)) return dnsCache.get(host);
  let result;
  try {
    const addrs = await dns.lookup(host, { all: true, verbatim: true });
    if (!addrs.length) result = { ok: false, reason: 'no DNS records' };
    else {
      const bad = addrs.map((a) => ipBlocked(a.address)).find(Boolean);
      result = bad ? { ok: false, reason: `resolves to blocked IP (${bad})` } : { ok: true };
    }
  } catch (e) {
    result = { ok: false, reason: `DNS lookup failed (${e.code || e.message})` };
  }
  dnsCache.set(host, result);
  return result;
}

function validateTargetUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return { ok: false, reason: 'unparsable URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `scheme not allowed: ${u.protocol}` };
  if (u.username || u.password) return { ok: false, reason: 'credentials in URL not allowed' };
  if (!u.hostname) return { ok: false, reason: 'missing hostname' };
  return { ok: true, url: u };
}

// ------------------------------------------------------------ resource usage
function browserTreeRssKb() {
  // Sum RSS of all Chromium processes in this VM (Linux /proc scan).
  // Playwright exposes no public browser PID, and in this sandbox the
  // scanner's Chromium is the only chrome on the machine, so a cmdline
  // match is exact here. In production, scope this by the launch
  // user-data-dir instead.
  try {
    let total = 0;
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8');
        if (!cmd.includes('chrome')) continue;
        const status = fs.readFileSync(`/proc/${d}/status`, 'utf8');
        const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
        if (m) total += Number(m[1]);
      } catch { /* process vanished */ }
    }
    return total;
  } catch { return 0; }
}

// ------------------------------------------------------------------- scanner
async function scan(rawUrl, opts = {}) {
  const startedAt = Date.now();
  const cpuStart = process.cpuUsage();
  const failures = [];
  const ssrfChecks = [];
  let peakRssMb = 0;
  let browserPid = null;
  let rssTimer = null;
  // Chromium CPU: Node's process.cpuUsage() only covers this process, so we
  // also accumulate utime+stime of every chrome process from /proc, sampled
  // every 250 ms (CLK_TCK = 100 on Linux x86_64). Processes that exit
  // between samples lose at most one 250 ms slice — noted as approximation.
  const chromeCpu = { ticks: 0, last: new Map() };
  const sampleChromeCpu = () => {
    try {
      const seen = new Set();
      for (const d of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        const pid = Number(d);
        try {
          const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8');
          if (!cmd.includes('chrome')) continue;
          const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
          const parts = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          const ticks = Number(parts[11]) + Number(parts[12]); // utime + stime
          seen.add(pid);
          const prev = chromeCpu.last.get(pid);
          if (prev !== undefined && ticks >= prev) chromeCpu.ticks += ticks - prev;
          chromeCpu.last.set(pid, ticks);
        } catch { /* vanished */ }
      }
      for (const pid of [...chromeCpu.last.keys()]) if (!seen.has(pid)) chromeCpu.last.delete(pid);
    } catch { /* /proc unavailable */ }
  };

  const sampleRss = () => {
    const nodeMb = process.memoryUsage().rss / 1048576;
    const browserMb = browserPid ? browserTreeRssKb() / 1024 : 0;
    peakRssMb = Math.max(peakRssMb, nodeMb + browserMb);
    sampleChromeCpu();
  };

  const target = validateTargetUrl(rawUrl);
  if (!target.ok) {
    return finish({ url: rawUrl, scanned_at: new Date().toISOString(), policy_version: POLICY_VERSION,
      scan_ms: Date.now() - startedAt, cpu_seconds: 0, peak_rss_mb: 0,
      elements: [], summary: { total: 0, people: 0, covered: 0, blocked: 0, review: 0 },
      verdict: 'ERROR', failures: [`URL rejected: ${target.reason}`], ssrf_checks: ssrfChecks });
  }
  const url = target.url.toString();
  const hostCheck = await hostAllowed(target.url.hostname);
  ssrfChecks.push({ url, check: 'initial-host', ok: hostCheck.ok, reason: hostCheck.reason || 'public IP' });
  if (!hostCheck.ok) {
    return finish({ url, scanned_at: new Date().toISOString(), policy_version: POLICY_VERSION,
      scan_ms: Date.now() - startedAt, cpu_seconds: 0, peak_rss_mb: 0,
      elements: [], summary: { total: 0, people: 0, covered: 0, blocked: 0, review: 0 },
      verdict: 'ERROR', failures: [`SSRF block: host ${target.url.hostname} — ${hostCheck.reason}`], ssrf_checks: ssrfChecks });
  }

  function finish(map) {
    const cpu = process.cpuUsage(cpuStart);
    // Node CPU + accumulated Chromium CPU (see sampleChromeCpu note).
    map.cpu_seconds = +(((cpu.user + cpu.system) / 1e6 + chromeCpu.ticks / 100).toFixed(3));
    map.peak_rss_mb = +peakRssMb.toFixed(1);
    return map;
  }

  // Phase timing log (stderr): pinpoints which phase is slow on a scan.
  const phase = (label) => console.error(`[scan] ${((Date.now() - startedAt) / 1000).toFixed(1)}s ${label}`);
  const withTimeout = (promise, ms, label) => Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label)), ms)),
  ]);

  rssTimer = setInterval(sampleRss, 250);
  // Hard cap that actually aborts: closing the browser makes any
  // in-flight evaluate reject, so the scan ends with a partial ERROR
  // map instead of hanging forever.
  const hardCap = setTimeout(() => {
    failures.push('scan hard cap (180s) reached — aborting');
    if (browser) browser.close().catch(() => {});
  }, SCAN_HARD_CAP_MS);

  let browser;
  try {
    const launchArgs = [];
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      launchArgs.push('--no-sandbox');
      failures.push('note: running as root, Chromium launched with --no-sandbox (sandbox would be on for a non-root user)');
    }
    if (LOOPBACK_OVERRIDE) {
      failures.push('note: TEST-ONLY SCANNER_ALLOW_LOOPBACK=1 — SSRF loopback guard disabled for this run (local test pages only)');
    }
    if (opts.spkiPin) launchArgs.push(`--ignore-certificate-errors-spki-list=${opts.spkiPin}`);
    const launchOpts = { args: launchArgs };
    if (opts.proxy) launchOpts.proxy = { server: opts.proxy };
    browser = await chromium.launch(launchOpts);
    browserPid = true; // Chromium running; RSS sampled via /proc cmdline scan

    const context = await browser.newContext({
      ignoreHTTPSErrors: false, // strict TLS; only the SPKI pin above relaxes one CA
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 FilterPlatformScanner/0.1',
      permissions: [],
      geolocation: undefined,
      // NOTE: no bypassCSP. The detector runs in its own about:blank
      // page (no CSP of its own), and the scanned page's CSP is
      // enforced like a real browser's — the scanner reads the DOM and
      // takes screenshots via CDP, which CSP does not govern. (An
      // earlier version loaded the detector inside the scanned page
      // and needed bypassCSP because sites like Wikipedia/BBC send a
      // connect-src CSP that blocked fetching our bundled models; the
      // dedicated detector page made that workaround unnecessary.)
    });
    const page = await context.newPage();

    // Serve the bundled face-api models to the page WITHOUT a network
    // server: a SINGLE route handler fulfils them from local disk.
    // (One handler, not two — Playwright only runs the first matching
    // handler, so the models branch must live inside the same handler
    // as the SSRF checks. Also avoids mixed-content blocks: the page
    // is https, and this never touches the network.)
    const serveModelFile = async (route, reqUrl) => {
      const file = decodeURIComponent(reqUrl.split('/scanner-models/')[1] || '');
      const safe = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
      const full = path.join(MODELS_DIR, safe);
      if (!full.startsWith(MODELS_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
        return route.abort('failed');
      }
      const ext = path.extname(full);
      const type = ext === '.json' ? 'application/json'
        : ext === '.js' || ext === '.mjs' ? 'text/javascript'
        : ext === '.wasm' ? 'application/wasm'
        : 'application/octet-stream';
      return route.fulfill({ body: fs.readFileSync(full), contentType: type });
    };

    // SSRF enforcement on EVERY request (page + subresources + redirects).
    // Registered on the CONTEXT so the detector page (below) shares the
    // same handler and the same SSRF guarantees.
    let redirectCount = 0;
    let finalStatus = null;
    let finalUrl = url;
    await context.route('**/*', async (route) => {
      const req = route.request();
      const reqUrl = req.url();
      if (reqUrl.startsWith('https://scanner-models/') || reqUrl.startsWith('http://scanner-models/')) {
        return serveModelFile(route, reqUrl);
      }
      let u;
      try { u = new URL(reqUrl); } catch { return route.abort('failed'); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        ssrfChecks.push({ url: reqUrl, check: 'subresource-scheme', ok: false, reason: `scheme ${u.protocol}` });
        return route.abort('blockedbyclient');
      }
      if (u.username || u.password) {
        ssrfChecks.push({ url: reqUrl, check: 'subresource-credentials', ok: false, reason: 'credentials in URL' });
        return route.abort('blockedbyclient');
      }
      const allowed = await hostAllowed(u.hostname);
      if (!allowed.ok) {
        ssrfChecks.push({ url: reqUrl, check: 'subresource-host', ok: false, reason: allowed.reason });
        return route.abort('blockedbyclient');
      }
      const depth = (() => { let d = 0, r = req; while (r.redirectedFrom()) { d++; r = r.redirectedFrom(); } return d; })();
      if (depth > MAX_REDIRECTS) {
        ssrfChecks.push({ url: reqUrl, check: 'redirect-cap', ok: false, reason: `>${MAX_REDIRECTS} redirects` });
        return route.abort('blockedbyclient');
      }
      redirectCount = Math.max(redirectCount, depth);
      return route.continue();
    });

    page.on('response', (res) => {
      if (res.request().isNavigationRequest()) { finalStatus = res.status(); finalUrl = res.url(); }
    });
    // Forward the scanner's own in-page diagnostics (lines starting with
    // '[scanner]'). Page scripts' console output is NOT forwarded.
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.startsWith('[scanner]')) console.error(`[page] ${text.slice(0, 200)}`);
    });
    page.on('pageerror', (e) => failures.push(`page JS error: ${String(e.message).slice(0, 200)}`));
    page.on('requestfailed', (req) => {
      const f = req.failure();
      if (f && f.errorText !== 'net::ERR_ABORTED') failures.push(`request failed: ${req.url().slice(0, 120)} (${f.errorText})`);
    });

    const navStart = Date.now();
    let navError = null;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      phase(`navigation done (${Date.now() - navStart}ms, status=${finalStatus})`);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => failures.push('networkidle not reached in 15s (page keeps loading)'));
    } catch (e) {
      navError = e;
      failures.push(`navigation failed: ${String(e.message).split('\n')[0].slice(0, 200)}`);
    }
    const navMs = Date.now() - navStart;

    // Scroll stepwise to trigger lazy loading, then settle.
    if (!navError) {
      await page.evaluate(async () => {
        const h = document.body ? document.body.scrollHeight : 0;
        for (let y = 0; y <= h; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
        window.scrollTo(0, 0);
      }).catch((e) => failures.push(`scroll failed: ${e.message.slice(0, 120)}`));
      await page.waitForTimeout(1500);
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      phase('scroll pass done');
    }

    // ---- collect rendered visual elements -------------------------------
    const collected = await page.evaluate(() => {
      const cssPath = (el) => {
        const parts = [];
        let n = el;
        while (n && n.nodeType === 1 && parts.length < 6) {
          let s = n.tagName.toLowerCase();
          if (n.id) { s += `#${n.id}`; parts.unshift(s); break; }
          const cls = (n.className && typeof n.className === 'string') ? n.className.trim().split(/\s+/)[0] : '';
          if (cls) s += `.${cls}`;
          const sib = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
          if (sib.length > 1) s += `:nth-of-type(${sib.indexOf(n) + 1})`;
          parts.unshift(s);
          n = n.parentElement;
        }
        return parts.join(' > ');
      };
      const boxOf = (el) => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + window.scrollX), y: Math.round(r.y + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) };
      };
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 2 && r.height > 2 && cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05;
      };
      const out = [];
      document.querySelectorAll('img').forEach((el) => {
        out.push({ type: 'img', selector: cssPath(el), box: boxOf(el), src: el.currentSrc || el.src || '', alt: (el.alt || '').slice(0, 120), visible: visible(el), natural: `${el.naturalWidth}x${el.naturalHeight}` });
      });
      document.querySelectorAll('*').forEach((el) => {
        const bg = getComputedStyle(el).backgroundImage;
        if (bg && bg !== 'none') {
          const m = [...bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((x) => x[1]).filter((s) => !s.startsWith('data:'));
          m.forEach((src) => out.push({ type: 'background', selector: cssPath(el), box: boxOf(el), src, alt: '', visible: visible(el), natural: '' }));
        }
      });
      document.querySelectorAll('svg image').forEach((el) => {
        out.push({ type: 'svg-image', selector: cssPath(el), box: boxOf(el), src: el.getAttribute('href') || el.getAttribute('xlink:href') || '', alt: '', visible: visible(el), natural: '' });
      });
      document.querySelectorAll('canvas').forEach((el) => {
        out.push({ type: 'canvas', selector: cssPath(el), box: boxOf(el), src: '', alt: '', visible: visible(el), natural: `${el.width}x${el.height}` });
      });
      document.querySelectorAll('video').forEach((el) => {
        out.push({ type: 'video', selector: cssPath(el), box: boxOf(el), src: el.currentSrc || el.src || el.poster || '', alt: '', visible: visible(el), natural: `${el.videoWidth}x${el.videoHeight}`, poster: el.poster || '' });
      });
      return out;
    }).catch((e) => { failures.push(`element collection failed: ${e.message.slice(0, 150)}`); return []; });
    phase(`collected ${collected.length} visual elements`);

    // ---- on-device person detection (MediaPipe person + face-api face) ---
    // Detection runs in a DEDICATED detector page (about:blank), NOT in
    // the scanned page: the scanned page's scripts, timers, CSP and
    // tainted canvases cannot stall or corrupt detection, and a hung
    // detector page can be closed and recreated without touching the
    // scan. Images are loaded by URL in the detector page; <video> and
    // <canvas> are sampled via element screenshots (which also bypasses
    // CORS taint — a screenshot is our own pixels). See detector.js.
    let detector = {
      name: `${PERSON_MODEL_NAME} + ${FACE_MODEL_NAME}`,
      backend: 'cpu', loaded: false,
      person_model: PERSON_MODEL_NAME, person_loaded: false,
      face_model: FACE_MODEL_NAME, face_loaded: false,
      error: null,
    };
    const candidates = collected
      .filter((e) => e.visible && e.box.w >= 32 && e.box.h >= 32)
      .sort((a, b) => (b.box.w * b.box.h) - (a.box.w * a.box.h))
      .slice(0, opts.maxImages || MAX_IMAGES);
    const skippedCount = collected.filter((e) => e.visible && e.box.w >= 32 && e.box.h >= 32).length - candidates.length;

    let det = null;
    let detFailed = null;
    const detRequestFailed = (req) => {
      const f = req.failure();
      if (f && f.errorText !== 'net::ERR_ABORTED') failures.push(`detector page request failed: ${req.url().slice(0, 120)} (${f.errorText})`);
    };
    const ensureDet = async () => {
      if (det) return det;
      if (detFailed) throw detFailed;
      try {
        det = await withTimeout(createDetector(context, detRequestFailed), 60_000, 'detector load timed out after 60s');
        detector = det.info;
        return det;
      } catch (e) {
        detFailed = e;
        detector.error = String(e.message).slice(0, 200);
        throw e;
      }
    };
    const resetDet = async () => {
      try { if (det) await det.close(); } catch {}
      det = null;
      return ensureDet();
    };
    const detectPixels = async (input) => {
      const d = await ensureDet();
      return d.detect(input);
    };

    if (candidates.length) {
      try {
        await ensureDet();
        phase(`detector page ready (person_loaded=${detector.person_loaded} face_loaded=${detector.face_loaded} backend=${detector.backend})`);
      } catch (e) {
        detector.error = String(e.message).slice(0, 200);
        failures.push(`detector failed to load: ${detector.error}`);
      }
      if (detector.loaded) {
        const DETECT_TIMEOUT_MS = 25_000;
        for (let idx = 0; idx < candidates.length; idx++) {
          const c = candidates[idx];
          phase(`detect ${idx + 1}/${candidates.length} type=${c.type} box=${c.box.w}x${c.box.h} src=${(c.src || '').slice(0, 90)}`);
          let r = null;
          let rError = null;
          try {
            if (c.type === 'video' || c.type === 'canvas') {
              // Sample a frame via element screenshot (bypasses CORS taint).
              const rect = await withTimeout(page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (!el) return null;
                try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
                const b = el.getBoundingClientRect();
                return { x: Math.max(0, b.x), y: Math.max(0, b.y), width: Math.min(b.width, 1280), height: Math.min(b.height, 900) };
              }, c.selector), 10_000, 'frame rect lookup timed out');
              if (!rect || rect.width < 2 || rect.height < 2) throw new Error('no frame rect');
              await page.waitForTimeout(300);
              const buf = await withTimeout(page.screenshot({ clip: rect }), 15_000, 'frame screenshot timed out');
              r = await withTimeout(detectPixels({ dataUrl: 'data:image/png;base64,' + buf.toString('base64') }), DETECT_TIMEOUT_MS, 'detect timed out after 25s');
            } else {
              if (!c.src) throw new Error('no image URL');
              r = await withTimeout(detectPixels({ src: c.src }), DETECT_TIMEOUT_MS, 'detect timed out after 25s');
            }
          } catch (e) {
            rError = String(e.message).split('\n')[0].slice(0, 140);
            failures.push(`detection element ${idx} (${c.type} ${c.selector}) — ${rError}`);
            // A timeout may mean the detector page is wedged: recycle it
            // so the next element gets a clean page.
            if (/timed out/.test(rError)) {
              try { await resetDet(); } catch (e2) { failures.push(`detector page reset failed: ${String(e2.message).slice(0, 120)}`); }
            }
          }
          if (rError) { c.detection = 'uncertain'; c.confidence = 0; c.detectError = rError; }
          else {
            // Person OR face hit = human. confidence = best of the two.
            const personHit = (r.persons || 0) > 0;
            const faceHit = (r.faces || 0) > 0;
            const best = Math.max(r.personBest || 0, r.faceBest || 0);
            c.persons = r.persons || 0;
            if (r.personBoxes && r.personBoxes.length) c.personBoxes = r.personBoxes;
            if (r.faces) c.faces = r.faces;
            if (personHit || faceHit) {
              c.detected_by = personHit && faceHit ? 'person+face' : personHit ? 'person' : 'face';
              c.detection = best >= POLICY.threshold ? 'person' : 'uncertain';
              c.confidence = best;
            } else { c.detection = 'none'; c.confidence = 0; }
          }
          phase(`detect ${idx + 1}/${candidates.length} -> ${c.detection}${c.confidence ? ` conf=${c.confidence}` : ''}${c.detected_by ? ` via=${c.detected_by}` : ''}${c.detectError ? ` (${c.detectError})` : ''}`);
        }
      } else {
        for (const c of candidates) { c.detection = 'uncertain'; c.confidence = 0; c.detectError = 'detector unavailable'; }
      }
    }

    // ---- decisions --------------------------------------------------------
    const elements = collected.map((e) => {
      const c = candidates.find((x) => x === e);
      const detection = e.detection || (c ? c.detection : undefined) || (e.visible ? 'uncertain' : 'none');
      const confidence = typeof e.confidence === 'number' ? e.confidence : 0;
      let decision;
      if (!e.visible) decision = 'ALLOW'; // off-screen / hidden: nothing shown
      else if (detection === 'person') decision = POLICY.block_images ? 'BLOCK' : (POLICY.cover_images ? 'COVER' : 'ALLOW');
      else if (detection === 'uncertain') decision = 'REVIEW'; // unreviewed stays COVERED on the device
      else decision = 'ALLOW';
      const el = { type: e.type, selector: e.selector, box: e.box, detection, confidence, decision };
      if (e.src) el.src = e.src.slice(0, 200);
      if (e.detectError) el.note = e.detectError;
      if (e.faces) el.faces = e.faces;
      if (e.persons) el.persons = e.persons;
      if (e.detected_by) el.detected_by = e.detected_by;
      return el;
    });

    let screenshotPath = null;
    if (opts.screenshot) {
      const shot = path.join(opts.outDir || path.join(__dirname, 'results'), `${opts.slug || 'scan'}.png`);
      try { await page.screenshot({ path: shot, fullPage: false }); screenshotPath = shot; }
      catch (e) { failures.push(`screenshot failed: ${e.message.slice(0, 100)}`); }
    }

    const summary = {
      total: elements.length,
      people: elements.filter((e) => e.detection === 'person').length,
      covered: elements.filter((e) => e.decision === 'COVER').length,
      blocked: elements.filter((e) => e.decision === 'BLOCK').length,
      review: elements.filter((e) => e.decision === 'REVIEW').length,
    };
    let verdict;
    if (navError || (finalStatus !== null && finalStatus >= 400)) verdict = 'ERROR';
    else if (summary.blocked > 0 || summary.review > 0) verdict = 'REVIEW';
    else verdict = 'ALLOW';
    if (finalStatus === 403 || finalStatus === 429) verdict = 'ERROR';

    const map = {
      url, final_url: finalUrl, scanned_at: new Date().toISOString(),
      policy_version: POLICY_VERSION,
      scan_ms: Date.now() - startedAt, nav_ms: navError ? null : navMs,
      cpu_seconds: 0, peak_rss_mb: 0,
      http_status: finalStatus, redirects: redirectCount,
      detector, detection_candidates: candidates.length, detection_skipped: skippedCount,
      elements, summary, verdict,
      failures, ssrf_checks: ssrfChecks,
    };
    if (screenshotPath) map.screenshot = screenshotPath;
    // Non-throwing: the hard cap may already have closed the browser.
    await context.close().catch(() => {});
    clearInterval(rssTimer);
    clearTimeout(hardCap);
    sampleRss();
    return finish(map);
  } catch (e) {
    failures.push(`scan crashed: ${String(e.message).slice(0, 200)}`);
    clearInterval(rssTimer);
    clearTimeout(hardCap);
    sampleRss();
    return finish({
      url, scanned_at: new Date().toISOString(), policy_version: POLICY_VERSION,
      scan_ms: Date.now() - startedAt, cpu_seconds: 0, peak_rss_mb: 0,
      elements: [], summary: { total: 0, people: 0, covered: 0, blocked: 0, review: 0 },
      verdict: 'ERROR', failures, ssrf_checks: ssrfChecks,
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------- CLI
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const url = args.find((a) => !a.startsWith('--'));
    const get = (name, dflt) => {
      const eq = args.find((x) => x.startsWith(`--${name}=`));
      if (eq) return eq.split('=').slice(1).join('=');
      const i = args.indexOf(`--${name}`);
      if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
      return dflt;
    };
    if (!url) { console.error('usage: node scanner.js <url> [--out file.json] [--proxy URL] [--spki-pin B64] [--screenshot]'); process.exit(2); }
    const out = get('out', null);
    let slug = 'scan';
    try { slug = (new URL(url).hostname + new URL(url).pathname).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80) || 'scan'; } catch { /* scanner.js reports the bad URL */ }
    const map = await scan(url, {
      proxy: get('proxy', process.env.SCANNER_PROXY || null),
      spkiPin: get('spki-pin', process.env.SCANNER_TLS_SPKI_PIN || null),
      maxImages: Number(get('max-images', MAX_IMAGES)),
      screenshot: args.includes('--screenshot'),
      slug,
      outDir: out ? path.dirname(path.resolve(out)) : path.join(__dirname, 'results'),
    });
    const json = JSON.stringify(map, null, 2);
    if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, json); console.log(`wrote ${out}`); }
    else console.log(json);
  })().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { scan, hostAllowed, validateTargetUrl, POLICY, POLICY_VERSION };
