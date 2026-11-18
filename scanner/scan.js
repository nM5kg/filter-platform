/**
 * scan.js — scan runner for the Visual Protection Engine prototype.
 *
 *   node scan.js [url ...] [--out results]
 *
 * Default URL list (real sites, no placeholders):
 *   - https://example.com
 *   - https://en.wikipedia.org/wiki/Main_Page
 *   - https://www.bbc.com
 *   - https://commons.wikimedia.org/wiki/Commons:Featured_pictures
 *
 * Writes one JSON per site into <out>/ plus <slug>.png screenshots,
 * then a SCAN_REPORT.md summary in the scanner/ directory.
 *
 * Environment (sandbox only — see scanner.js header):
 *   SCANNER_PROXY=http://127.0.0.1:18080   egress-relay for this VM
 *   SCANNER_TLS_SPKI_PIN=<base64>            pin for the sandbox egress CA
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { scan } = require('./scanner');

const DEFAULT_URLS = [
  'https://example.com',
  'https://en.wikipedia.org/wiki/Main_Page',
  'https://www.bbc.com',
  'https://commons.wikimedia.org/wiki/Commons:Featured_pictures',
];

function slugFor(u) {
  try {
    return (new URL(u).hostname + new URL(u).pathname)
      .replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80) || 'scan';
  } catch { return 'scan'; }
}

function byType(elements) {
  const t = {};
  for (const e of elements) t[e.type] = (t[e.type] || 0) + 1;
  return t;
}

async function main() {
  const args = process.argv.slice(2);
  const urls = args.filter((a) => !a.startsWith('--'));
  const get = (name, dflt) => {
    const eq = args.find((x) => x.startsWith(`--${name}=`));
    if (eq) return eq.split('=').slice(1).join('=');
    const i = args.indexOf(`--${name}`);
    if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
    return dflt;
  };
  const list = urls.length ? urls : DEFAULT_URLS;
  const outDir = path.resolve(get('out', path.join(__dirname, 'results')));
  fs.mkdirSync(outDir, { recursive: true });

  const proxy = process.env.SCANNER_PROXY || null;
  const spkiPin = process.env.SCANNER_TLS_SPKI_PIN || null;
  if (proxy) console.log(`[scan] proxy: ${proxy} (sandbox relay)`);
  if (spkiPin) console.log('[scan] TLS SPKI pin active (sandbox egress CA only)');
  if (!proxy) console.log('[scan] no proxy — direct internet (production mode)');

  const rows = [];
  for (const url of list) {
    const slug = slugFor(url);
    console.log(`\n[scan] === ${url} ===`);
    const t0 = Date.now();
    let map;
    try {
      map = await scan(url, { proxy, spkiPin, screenshot: true, slug, outDir, maxImages: 40 });
    } catch (e) {
      map = { url, scanned_at: new Date().toISOString(), verdict: 'ERROR', scan_ms: Date.now() - t0,
        cpu_seconds: 0, peak_rss_mb: 0, elements: [], summary: { total: 0, people: 0, covered: 0, blocked: 0, review: 0 },
        failures: [`runner crash: ${e.message}`] };
    }
    const file = path.join(outDir, `${slug}.json`);
    fs.writeFileSync(file, JSON.stringify(map, null, 2));
    const people = map.elements.filter((e) => e.detection === 'person');
    console.log(`[scan] verdict=${map.verdict} http=${map.http_status ?? '?'} scan_ms=${map.scan_ms} cpu=${map.cpu_seconds}s rss=${map.peak_rss_mb}MB ` +
      `elements=${map.summary.total} people=${map.summary.people} blocked=${map.summary.blocked} review=${map.summary.review} ` +
      `failures=${(map.failures || []).length} -> ${file}`);
    if (people.length) {
      for (const p of people) console.log(`[scan]   PERSON conf=${p.confidence} ${p.type} ${p.selector} ${(p.src || '').slice(0, 90)}`);
    }
    rows.push({ url, slug, file, map });
  }

  // ---- SCAN_REPORT.md -----------------------------------------------------
  const lines = [];
  lines.push('# Visual Protection Engine — Scan Report (prototype v0.1.0)');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()} (UTC)`);
  lines.push(`Policy: standard-v1 (block_images=true, cover_images=false, threshold 0.70)`);
  lines.push(`Detector: face-api.js tinyFaceDetector, CPU backend, models bundled in scanner/models/`);
  lines.push(`Sandbox: ${proxy ? `proxy ${proxy} + TLS SPKI pin (egress CA only)` : 'direct internet, strict TLS'}`);
  lines.push('');
  lines.push('| Site | Verdict | HTTP | Scan ms | CPU s | Peak RSS MB | Elements | People | Blocked | Review | Failures |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const { url, map } of rows) {
    const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
    lines.push(`| ${host} | ${map.verdict} | ${map.http_status ?? '?'} | ${map.scan_ms} | ${map.cpu_seconds} | ${map.peak_rss_mb} | ${map.summary.total} | ${map.summary.people} | ${map.summary.blocked} | ${map.summary.review} | ${(map.failures || []).length} |`);
  }
  lines.push('');
  for (const { url, slug, map } of rows) {
    lines.push(`## ${url}`);
    lines.push('');
    lines.push(`- Result file: \`results/${slug}.json\`${map.screenshot ? `, screenshot: \`results/${slug}.png\`` : ''}`);
    lines.push(`- Final URL: ${map.final_url || map.url}`);
    lines.push(`- HTTP status: ${map.http_status ?? 'n/a'}, redirects: ${map.redirects ?? 'n/a'}, navigation: ${map.nav_ms ?? 'n/a'} ms`);
    lines.push(`- Scan time: ${map.scan_ms} ms, CPU: ${map.cpu_seconds} s, peak RSS: ${map.peak_rss_mb} MB`);
    lines.push(`- Detector: loaded=${map.detector ? map.detector.loaded : '?'}${map.detector && map.detector.error ? `, error: ${map.detector.error}` : ''}; candidates checked: ${map.detection_candidates ?? '?'}, skipped (over budget): ${map.detection_skipped ?? '?'}`);
    lines.push(`- Elements by type: ${JSON.stringify(byType(map.elements))}`);
    lines.push(`- Summary: ${JSON.stringify(map.summary)}`);
    const people = map.elements.filter((e) => e.detection === 'person');
    if (people.length) {
      lines.push(`- People detected:`);
      for (const p of people) lines.push(`  - conf=${p.confidence} (${p.faces || 1} face${(p.faces || 1) > 1 ? 's' : ''}) — ${p.type} \`${p.selector}\` → ${p.decision} — ${(p.src || '').slice(0, 120)}`);
    } else lines.push('- People detected: none');
    const uncertain = map.elements.filter((e) => e.detection === 'uncertain');
    if (uncertain.length) {
      lines.push(`- Uncertain / unanalyzable (${uncertain.length}):`);
      for (const u of uncertain.slice(0, 10)) lines.push(`  - ${u.type} \`${u.selector}\` → ${u.decision}${u.note ? ` — ${u.note}` : ''}`);
      if (uncertain.length > 10) lines.push(`  - …and ${uncertain.length - 10} more (see JSON)`);
    }
    if ((map.failures || []).length) {
      lines.push('- Failures / notes:');
      for (const f of map.failures) lines.push(`  - ${f}`);
    }
    if ((map.ssrf_checks || []).filter((c) => !c.ok).length) {
      lines.push('- SSRF blocks:');
      for (const c of map.ssrf_checks.filter((x) => !x.ok)) lines.push(`  - ${c.check}: ${c.reason} — ${(c.url || '').slice(0, 100)}`);
    }
    lines.push('');
  }
  const reportPath = path.join(__dirname, 'SCAN_REPORT.md');
  fs.writeFileSync(reportPath, lines.join('\n'));
  console.log(`\n[scan] report -> ${reportPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
