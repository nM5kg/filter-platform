// filter-platform-api — Phase 1 (Core Platform) Worker
// Plain ES module, no dependencies. Talks to Neon via the HTTP /sql endpoint
// (same pattern as the Webline preview Worker). All /api/v1/* routes require
// Authorization: Bearer <API_TOKEN>. /health is public.
// CORS is open (*) for the Phase 1 demo dashboard; restrict to the dashboard
// origin before production use.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

const lit = (v) =>
  v === null || v === undefined ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'";
const isUuid = (s) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || "");
const isBool = (v) => typeof v === "boolean";
const isInt = (v) => Number.isInteger(v);

async function sql(env, query) {
  const u = new URL(env.DATABASE_URL.replace("postgresql://", "https://"));
  const res = await fetch(`https://${u.hostname}/sql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Neon-Connection-String": env.DATABASE_URL,
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    throw new Error("db " + res.status + ": " + (await res.text()).slice(0, 300));
  }
  const data = await res.json();
  return (data.rows || []).map((r) => {
    if (Array.isArray(r)) {
      const o = {};
      (data.fields || []).forEach((c, i) => { o[c.name] = r[i]; });
      return o;
    }
    return r;
  });
}

async function audit(env, action, entity_type, entity_id, details) {
  try {
    await sql(env, `INSERT INTO audit_logs (actor_type, action, entity_type, entity_id, details)
      VALUES ('user', ${lit(action)}, ${lit(entity_type)}, ${entity_id ? lit(entity_id) : "NULL"}, ${lit(JSON.stringify(details || {}))}::jsonb)`);
  } catch (e) {
    console.log("audit failed:", e.message);
  }
}

function auth(request, env) {
  const h = request.headers.get("Authorization") || "";
  return h === "Bearer " + env.API_TOKEN;
}

// ---- Classifier: transparent rules+scoring (Phase 1) ----
// Swap-in interface (see ARCHITECTURE.md): a model adapter implements
//   classify(target) -> { verdict: 'approve'|'reject', confidence: 0..1, reasons: string[], signals: object }
// The Phase 1 adapter is pure rules+scoring over REAL fetched page text.
// A future open-source model (NSFWJS / MediaPipe / TFLite) replaces the
// scoreContent() internals without changing the endpoint or the DB shape.
// The classifier NEVER invents content: if the page cannot be fetched,
// the result is 'review' (uncertain stays blocked).

async function fetchPageText(target) {
  const url = target.startsWith("http") ? target : "https://" + target + "/";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) return { ok: false, reason: "http-" + res.status };
    const html = await res.text();
    const text = html
      .slice(0, 200000)
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .toLowerCase();
    return { ok: true, text, finalUrl: res.url, bytes: html.length };
  } catch (e) {
    return { ok: false, reason: "fetch-failed: " + String(e.message || e).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

function scoreContent(text, blockedWords) {
  // score 0 = clean, 1 = explicit. reasons explain every point.
  let score = 0;
  const reasons = [];
  const hitWords = [];
  let hits = 0;
  for (const w of blockedWords) {
    const re = new RegExp("\\b" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "g");
    const m = text.match(re);
    if (m) {
      hits += m.length;
      hitWords.push(w + " x" + m.length);
    }
  }
  if (hits > 0) {
    score += Math.min(0.6, hits * 0.15);
    reasons.push("explicit words found: " + hitWords.slice(0, 8).join(", "));
  }
  const phrases = ["adult video", "porn video", "xxx video", "live cam", "webcam girls", "escort service", "adult content"];
  const hitPhrases = phrases.filter((p) => text.includes(p));
  if (hitPhrases.length) {
    score += Math.min(0.4, hitPhrases.length * 0.2);
    reasons.push("explicit phrases found: " + hitPhrases.join(", "));
  }
  if (!text || text.trim().length === 0) {
    // Nothing to judge: no signal at all. Push the score into the middle
    // band so the verdict lands in the review bucket (uncertain stays blocked).
    reasons.push("no page text could be extracted");
    return { score: 0.3, hits, reasons };
  }
  return { score: Math.min(1, score), hits, reasons };
}

function verdictFromScore(score, reasons) {
  // High score -> reject with high confidence. Low score -> approve with
  // high confidence. Middle -> lean by score but LOW confidence, so the
  // auto-decide threshold sends it to the review bucket.
  if (score >= 0.5) {
    return { verdict: "reject", confidence: Math.min(0.99, 0.55 + score * 0.45), reasons };
  }
  if (score <= 0.15) {
    const r = reasons.length ? reasons : ["no explicit words or phrases in fetched page text"];
    return { verdict: "approve", confidence: Math.min(0.98, 0.95 - score), reasons: r };
  }
  const r = reasons.length ? reasons : ["weak signal in fetched page text"];
  return { verdict: score >= 0.3 ? "reject" : "approve", confidence: 0.5, reasons: r };
}

// Shared auto-decision: applies a verdict to a request row, updates the
// customer's list when the decision is final, writes the audit log.
// Returns the updated request row.
async function applyAutoDecision(env, r, verdict, confidence, reasons, threshold) {
  if (confidence < threshold) {
    const upd = await sql(env, `UPDATE approval_requests SET status = 'review', ai_verdict = ${lit(verdict)}, ai_confidence = ${confidence}, ai_reasons = ${lit(JSON.stringify(reasons))}::jsonb, review_reason = 'low-confidence', auto_decided_at = now() WHERE id = ${lit(r.id)} RETURNING *`);
    await audit(env, "request.review", "approval_requests", r.id, { kind: r.kind, target: r.target, confidence, threshold });
    return upd[0];
  }
  const finalStatus = verdict === "approve" ? "approved" : "rejected";
  const upd = await sql(env, `UPDATE approval_requests SET status = ${lit(finalStatus)}, ai_verdict = ${lit(verdict)}, ai_confidence = ${confidence}, ai_reasons = ${lit(JSON.stringify(reasons))}::jsonb, decided_at = now(), auto_decided_at = now() WHERE id = ${lit(r.id)} RETURNING *`);
  if (r.kind === "website") {
    const decision = verdict === "approve" ? "allow" : "block";
    await sql(env, `INSERT INTO domains (customer_id, domain, decision, source) VALUES (${lit(r.customer_id)}, ${lit(r.target)}, ${lit(decision)}, 'ai')
      ON CONFLICT (customer_id, domain) WHERE customer_id IS NOT NULL DO UPDATE SET decision = EXCLUDED.decision, source = 'ai'`);
  }
  await audit(env, "request.auto-" + finalStatus, "approval_requests", r.id, { kind: r.kind, target: r.target, confidence });
  return upd[0];
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // ---- public: /health ----
    if (path === "/health" && request.method === "GET") {
      try {
        await sql(env, "SELECT 1");
        return json({ service: "filter-platform-api", status: "ok", database: "connected", phase: 1, time: new Date().toISOString() });
      } catch (e) {
        return json({ service: "filter-platform-api", status: "error", database: "error", error: e.message }, 500);
      }
    }

    if (!path.startsWith("/api/v1/")) return json({ error: "Not found" }, 404);
    if (!auth(request, env)) return json({ error: "Unauthorized" }, 401);

    const seg = path.replace("/api/v1/", "").split("/").filter(Boolean);
    const resource = seg[0];
    const id = seg[1] && isUuid(seg[1]) ? seg[1] : null;
    const sub = seg[1] && !isUuid(seg[1]) ? seg[1] : seg[2] || null;
    let body = {};
    if (request.method === "POST" || request.method === "PATCH") {
      try { body = await request.json(); } catch { body = {}; }
    }

    try {
      // ---- customers ----
      if (resource === "customers" && request.method === "GET" && !id) {
        const rows = await sql(env, `SELECT c.*, (SELECT count(*) FROM devices d WHERE d.customer_id = c.id) AS device_count FROM customers c ORDER BY c.created_at DESC`);
        return json({ data: rows });
      }
      if (resource === "customers" && request.method === "GET" && id) {
        const rows = await sql(env, `SELECT * FROM customers WHERE id = ${lit(id)}`);
        if (!rows.length) return json({ error: "Customer not found" }, 404);
        return json({ data: rows[0] });
      }
      if (resource === "customers" && request.method === "POST") {
        if (!body.name || !body.email) return json({ error: "name and email are required" }, 400);
        const rows = await sql(env, `INSERT INTO customers (name, email, phone) VALUES (${lit(body.name)}, ${lit(body.email)}, ${lit(body.phone || null)}) RETURNING *`);
        await audit(env, "customer.created", "customers", rows[0].id, { name: body.name });
        return json({ data: rows[0] }, 201);
      }

      // ---- users (no password hashes ever leave the API) ----
      if (resource === "users" && request.method === "GET") {
        const rows = await sql(env, `SELECT id, email, role, created_at, last_login_at FROM users ORDER BY created_at DESC`);
        return json({ data: rows });
      }
      if (resource === "users" && request.method === "POST") {
        if (!body.email || !body.password_hash || !["super_admin", "admin", "support", "viewer"].includes(body.role)) {
          return json({ error: "email, password_hash and a valid role are required" }, 400);
        }
        const rows = await sql(env, `INSERT INTO users (email, password_hash, role) VALUES (${lit(body.email)}, ${lit(body.password_hash)}, ${lit(body.role)}) RETURNING id, email, role, created_at`);
        return json({ data: rows[0] }, 201);
      }

      // ---- policies ----
      if (resource === "policies" && request.method === "GET" && !id) {
        const rows = await sql(env, `SELECT * FROM policies ORDER BY created_at DESC`);
        return json({ data: rows });
      }
      if (resource === "policies" && request.method === "GET" && id) {
        const rows = await sql(env, `SELECT * FROM policies WHERE id = ${lit(id)}`);
        if (!rows.length) return json({ error: "Policy not found" }, 404);
        const versions = await sql(env, `SELECT id, version, created_at FROM policy_versions WHERE policy_id = ${lit(id)} ORDER BY version DESC`);
        return json({ data: { ...rows[0], versions } });
      }
      if (resource === "policies" && request.method === "POST") {
        if (!body.name) return json({ error: "name is required" }, 400);
        const b = (k, d) => (body[k] === undefined ? d : body[k]);
        // NOTE (fixed 2026-11-18): the old code passed isBool(...) here,
        // which returns whether the value IS a boolean — so every boolean
        // body value (true AND false) was stored as true. asBool coerces
        // the actual value instead; a false flag now really stays false.
        const asBool = (v, d) => (v === undefined ? d : !!v);
        const strictness = isInt(body.strictness) && body.strictness >= 1 && body.strictness <= 3 ? body.strictness : 2;
        const rows = await sql(env, `INSERT INTO policies (name, description, strictness, cover_images, block_images, filter_videos, filter_ads, require_approval_for_new_sites, force_safesearch)
          VALUES (${lit(body.name)}, ${lit(b("description", null))}, ${strictness}, ${asBool(b("cover_images", true), true)}, ${asBool(b("block_images", false), false)}, ${asBool(b("filter_videos", true), true)}, ${asBool(b("filter_ads", true), true)}, ${asBool(b("require_approval_for_new_sites", true), true)}, ${asBool(b("force_safesearch", true), true)}) RETURNING *`);
        const p = rows[0];
        await sql(env, `INSERT INTO policy_versions (policy_id, version, snapshot) VALUES (${lit(p.id)}, 1, ${lit(JSON.stringify(p))}::jsonb)`);
        await audit(env, "policy.created", "policies", p.id, { name: p.name });
        return json({ data: p }, 201);
      }

      // ---- devices ----
      if (resource === "devices" && request.method === "GET" && !id) {
        const customer_id = url.searchParams.get("customer_id") || "";
        const where = customer_id && isUuid(customer_id) ? `WHERE d.customer_id = ${lit(customer_id)}` : "";
        const rows = await sql(env, `SELECT d.*, c.name AS customer_name, p.name AS policy_name
          FROM devices d JOIN customers c ON c.id = d.customer_id LEFT JOIN policies p ON p.id = d.policy_id ${where} ORDER BY d.created_at DESC`);
        return json({ data: rows });
      }
      if (resource === "devices" && request.method === "GET" && id && sub === "status") {
        const rows = await sql(env, `SELECT * FROM device_status WHERE device_id = ${lit(id)} ORDER BY checked_at DESC LIMIT 1`);
        return json({ data: rows[0] || null });
      }
      if (resource === "devices" && request.method === "POST" && sub === "register") {
        if (!body.code) return json({ error: "code is required" }, 400);
        const rows = await sql(env, `SELECT * FROM devices WHERE activation_code = ${lit(String(body.code).trim())} AND status = 'pending'`);
        if (!rows.length) return json({ error: "Invalid or already-used activation code" }, 404);
        const d = rows[0];
        const upd = await sql(env, `UPDATE devices SET status = 'active', activated_at = now(), last_seen_at = now() WHERE id = ${lit(d.id)} RETURNING *`);
        await sql(env, `INSERT INTO device_status (device_id, status, filter_active, policy_version) VALUES (${lit(d.id)}, 'online', true, 1)`);
        await audit(env, "device.activated", "devices", d.id, { name: d.name });
        return json({ data: upd[0] });
      }
      if (resource === "devices" && request.method === "POST" && sub === "heartbeat" && id) {
        if (!["online", "offline", "unknown"].includes(body.status)) return json({ error: "valid status is required" }, 400);
        await sql(env, `INSERT INTO device_status (device_id, status, filter_active, policy_version) VALUES (${lit(id)}, ${lit(body.status)}, ${body.filter_active !== false}, ${isInt(body.policy_version) ? body.policy_version : "NULL"})`);
        await sql(env, `UPDATE devices SET last_seen_at = now() WHERE id = ${lit(id)}`);
        return json({ data: { ok: true } });
      }
      if (resource === "devices" && request.method === "POST") {
        if (!body.customer_id || !isUuid(body.customer_id) || !body.name || !["android", "ios", "windows", "macos", "other"].includes(body.platform)) {
          return json({ error: "customer_id, name and a valid platform are required" }, 400);
        }
        // New devices get the default policy (Standard) unless one is given.
        let policyId = body.policy_id && isUuid(body.policy_id) ? body.policy_id : null;
        if (!policyId) {
          const def = await sql(env, `SELECT id FROM policies WHERE is_default = true LIMIT 1`);
          policyId = def.length ? def[0].id : null;
        }
        const code = String(Math.floor(100000 + Math.random() * 900000));
        const rows = await sql(env, `INSERT INTO devices (customer_id, name, platform, policy_id, activation_code)
          VALUES (${lit(body.customer_id)}, ${lit(body.name)}, ${lit(body.platform)}, ${policyId ? lit(policyId) : "NULL"}, ${lit(code)}) RETURNING *`);
        await audit(env, "device.created", "devices", rows[0].id, { name: body.name });
        return json({ data: rows[0] }, 201);
      }

      // ---- domains (allow/block lists + check) ----
      if (resource === "domains" && request.method === "GET" && sub === "check") {
        const domain = (url.searchParams.get("domain") || "").toLowerCase().trim();
        const customer_id = url.searchParams.get("customer_id") || "";
        if (!domain) return json({ error: "domain query param is required" }, 400);
        let rows = [];
        if (customer_id && isUuid(customer_id)) {
          rows = await sql(env, `SELECT * FROM domains WHERE domain = ${lit(domain)} AND customer_id = ${lit(customer_id)}`);
        }
        if (!rows.length) {
          rows = await sql(env, `SELECT * FROM domains WHERE domain = ${lit(domain)} AND customer_id IS NULL`);
        }
        if (rows.length) return json({ data: { domain, decision: rows[0].decision, category: rows[0].category, source: rows[0].source } });
        // Uncertain stays blocked: a pending/review request for this domain
        // blocks it even under an otherwise open policy.
        if (customer_id && isUuid(customer_id)) {
          const pending = await sql(env, `SELECT id FROM approval_requests WHERE customer_id = ${lit(customer_id)} AND kind = 'website' AND target = ${lit(domain)} AND status IN ('pending', 'review') LIMIT 1`);
          if (pending.length) return json({ data: { domain, decision: "block", category: null, source: "pending-review" } });
        }
        // Unlisted domain: the Standard policy leaves the rest open, so the
        // effective decision is allow; a strict policy (require_approval)
        // flips it to block.
        let effective = "allow";
        if (customer_id && isUuid(customer_id)) {
          const pol = await sql(env, `SELECT p.require_approval_for_new_sites FROM devices d LEFT JOIN policies p ON p.id = d.policy_id WHERE d.customer_id = ${lit(customer_id)} AND d.status = 'active' LIMIT 1`);
          if (pol.length && pol[0].require_approval_for_new_sites) effective = "block";
        }
        return json({ data: { domain, decision: effective, category: null, source: effective === "allow" ? "unlisted-open" : "unlisted" } });
      }
      if (resource === "domains" && request.method === "GET") {
        const decision = url.searchParams.get("decision");
        const customer_id = url.searchParams.get("customer_id");
        let where = "1=1";
        if (["allow", "block"].includes(decision)) where += ` AND decision = ${lit(decision)}`;
        if (customer_id && isUuid(customer_id)) where += ` AND (customer_id = ${lit(customer_id)} OR customer_id IS NULL)`;
        const rows = await sql(env, `SELECT * FROM domains WHERE ${where} ORDER BY domain`);
        return json({ data: rows });
      }
      if (resource === "domains" && request.method === "POST") {
        if (!body.domain || !["allow", "block"].includes(body.decision)) return json({ error: "domain and a valid decision (allow/block) are required" }, 400);
        const domain = body.domain.toLowerCase().trim();
        const hasCustomer = body.customer_id && isUuid(body.customer_id);
        const cid = hasCustomer ? lit(body.customer_id) : "NULL";
        const conflict = hasCustomer
          ? `ON CONFLICT (customer_id, domain) WHERE customer_id IS NOT NULL DO UPDATE SET decision = EXCLUDED.decision, category = EXCLUDED.category, source = EXCLUDED.source`
          : `ON CONFLICT (domain) WHERE customer_id IS NULL DO UPDATE SET decision = EXCLUDED.decision, category = EXCLUDED.category, source = EXCLUDED.source`;
        const rows = await sql(env, `INSERT INTO domains (customer_id, domain, decision, category, source)
          VALUES (${cid}, ${lit(domain)}, ${lit(body.decision)}, ${lit(body.category || null)}, ${lit(body.source || "manual")})
          ${conflict}
          RETURNING *`);
        await audit(env, "domain.upserted", "domains", rows[0].id, { domain, decision: body.decision });
        return json({ data: rows[0] }, 201);
      }

      // ---- applications ----
      if (resource === "applications" && request.method === "GET") {
        const rows = await sql(env, `SELECT * FROM applications ORDER BY name`);
        return json({ data: rows });
      }
      if (resource === "applications" && request.method === "POST") {
        if (!body.package_id || !["android", "ios"].includes(body.platform) || !["allow", "block"].includes(body.decision)) {
          return json({ error: "package_id, a valid platform and decision are required" }, 400);
        }
        const hasCustomer = body.customer_id && isUuid(body.customer_id);
        const cid = hasCustomer ? lit(body.customer_id) : "NULL";
        const conflict = hasCustomer
          ? `ON CONFLICT (customer_id, package_id) WHERE customer_id IS NOT NULL DO UPDATE SET decision = EXCLUDED.decision, name = EXCLUDED.name`
          : `ON CONFLICT (package_id) WHERE customer_id IS NULL DO UPDATE SET decision = EXCLUDED.decision, name = EXCLUDED.name`;
        const rows = await sql(env, `INSERT INTO applications (customer_id, package_id, name, platform, decision, category, source)
          VALUES (${cid}, ${lit(body.package_id)}, ${lit(body.name || null)}, ${lit(body.platform)}, ${lit(body.decision)}, ${lit(body.category || null)}, ${lit(body.source || "manual")})
          ${conflict}
          RETURNING *`);
        await audit(env, "application.upserted", "applications", rows[0].id, { package_id: body.package_id, decision: body.decision });
        return json({ data: rows[0] }, 201);
      }

      // ---- blocked words (explicit-words text blocklist) ----
      if (resource === "blocked-words" && request.method === "GET") {
        const rows = await sql(env, `SELECT * FROM blocked_words ORDER BY word`);
        return json({ data: rows });
      }
      if (resource === "blocked-words" && request.method === "POST") {
        if (!body.word) return json({ error: "word is required" }, 400);
        const rows = await sql(env, `INSERT INTO blocked_words (word, category, source)
          VALUES (${lit(body.word.toLowerCase().trim())}, ${lit(body.category || null)}, ${lit(body.source || "manual")})
          ON CONFLICT (word) DO UPDATE SET category = EXCLUDED.category RETURNING *`);
        await audit(env, "blocked_word.upserted", "blocked_words", rows[0].id, { word: body.word });
        return json({ data: rows[0] }, 201);
      }

      // ---- Phase 3 starters: ad/tracker blocklist ----
      // Separate from `domains`: enforced only when the device policy has
      // filter_ads=true. The extension's declarativeNetRequest rules consume
      // this list; the main domains/check flow is untouched.
      if (resource === "ads" && request.method === "GET" && sub === "blocklist") {
        const category = url.searchParams.get("category");
        const where = ["ads", "tracking", "analytics"].includes(category) ? `WHERE category = ${lit(category)}` : "";
        const rows = await sql(env, `SELECT domain, category, source FROM ad_domains ${where} ORDER BY domain`);
        return json({ data: { domains: rows.map((r) => r.domain), entries: rows, count: rows.length } });
      }

      // ---- Phase 3 starters: SafeSearch enforcement config ----
      // Returns the URL-param + DNS rules the extension/device applies when
      // the resolved policy forces SafeSearch. URL params are best-effort
      // (a user can remove them); the DNS CNAMEs lock it at the network.
      if (resource === "safesearch" && request.method === "GET") {
        const device_id = url.searchParams.get("device_id") || "";
        const customer_id = url.searchParams.get("customer_id") || "";
        let pol = null;
        if (device_id && isUuid(device_id)) {
          const r = await sql(env, `SELECT p.* FROM devices d JOIN policies p ON p.id = d.policy_id WHERE d.id = ${lit(device_id)}`);
          if (r.length) pol = r[0];
        }
        if (!pol && customer_id && isUuid(customer_id)) {
          const r = await sql(env, `SELECT p.* FROM devices d JOIN policies p ON p.id = d.policy_id WHERE d.customer_id = ${lit(customer_id)} AND d.status = 'active' ORDER BY d.created_at DESC LIMIT 1`);
          if (r.length) pol = r[0];
        }
        if (!pol) {
          const r = await sql(env, `SELECT * FROM policies WHERE is_default = true LIMIT 1`);
          if (r.length) pol = r[0];
        }
        if (!pol) return json({ error: "No policy found" }, 404);
        const engines = pol.force_safesearch ? [
          { engine: "google", method: "url_param", rule: "safe=active", note: "Google Search SafeSearch strict" },
          { engine: "google", method: "dns", rule: "CNAME forcesafesearch.google.com", note: "Network lock: map www.google.com (and country domains) to this CNAME" },
          { engine: "bing", method: "url_param", rule: "adlt=strict", note: "Bing SafeSearch strict" },
          { engine: "bing", method: "dns", rule: "CNAME strict.bing.com", note: "Network lock for Bing" },
          { engine: "duckduckgo", method: "url_param", rule: "kp=1", note: "DuckDuckGo SafeSearch strict (kp=1 strict, -1 moderate, -2 off)" },
          { engine: "duckduckgo", method: "dns", rule: "CNAME safe.duckduckgo.com", note: "Network lock for DuckDuckGo, disables the client controls" },
          { engine: "youtube", method: "dns", rule: "CNAME restrict.youtube.com", note: "YouTube Restricted Mode lock (restrictmoderate.youtube.com for moderate)" },
        ] : [];
        return json({ data: { policy_id: pol.id, policy_name: pol.name, force_safesearch: !!pol.force_safesearch, engines } });
      }

      // ---- approval requests ----
      if (resource === "requests" && request.method === "GET") {
        const status = url.searchParams.get("status");
        const customer_id = url.searchParams.get("customer_id");
        let where = "1=1";
        if (["pending", "approved", "rejected", "review"].includes(status)) where += ` AND r.status = ${lit(status)}`;
        if (customer_id && isUuid(customer_id)) where += ` AND r.customer_id = ${lit(customer_id)}`;
        const rows = await sql(env, `SELECT r.*, c.name AS customer_name FROM approval_requests r JOIN customers c ON c.id = r.customer_id WHERE ${where} ORDER BY r.created_at DESC`);
        return json({ data: rows });
      }
      // ---- approval requests: automated AI decision (Phase 4 engine hook) ----
      // POST /api/v1/requests/:id/auto-decide { verdict: approve|reject, confidence: 0..1, reasons: [...] }
      // Confidence below the policy threshold -> status 'review', site stays blocked.
      // Otherwise the decision is final and updates the customer's list.
      // No flow depends on a human reviewing each request.
      if (resource === "requests" && request.method === "POST" && id && sub === "auto-decide") {
        if (!["approve", "reject"].includes(body.verdict) || typeof body.confidence !== "number" || body.confidence < 0 || body.confidence > 1) {
          return json({ error: "verdict (approve/reject) and confidence (0..1) are required" }, 400);
        }
        const cur = await sql(env, `SELECT r.*, p.auto_decide_threshold FROM approval_requests r LEFT JOIN devices d ON d.id = r.device_id LEFT JOIN policies p ON p.id = d.policy_id WHERE r.id = ${lit(id)}`);
        if (!cur.length) return json({ error: "Request not found" }, 404);
        const r = cur[0];
        if (r.status !== "pending" && r.status !== "review") return json({ error: "Request already decided: " + r.status }, 409);
        const threshold = r.auto_decide_threshold !== null && r.auto_decide_threshold !== undefined ? Number(r.auto_decide_threshold) : 0.70;
        const reasons = Array.isArray(body.reasons) ? body.reasons : (body.reasons ? [String(body.reasons)] : []);
        const upd = await applyAutoDecision(env, r, body.verdict, body.confidence, reasons, threshold);
        return json({ data: upd });
      }
      // POST /api/v1/requests/:id/classify — fetch the REAL site content,
      // score it with the transparent rules module, store the analysis, and
      // auto-decide (or send to review when confidence is low).
      if (resource === "requests" && request.method === "POST" && id && sub === "classify") {
        const cur = await sql(env, `SELECT r.*, p.auto_decide_threshold FROM approval_requests r LEFT JOIN devices d ON d.id = r.device_id LEFT JOIN policies p ON p.id = d.policy_id WHERE r.id = ${lit(id)}`);
        if (!cur.length) return json({ error: "Request not found" }, 404);
        const r = cur[0];
        if (r.status !== "pending" && r.status !== "review") return json({ error: "Request already decided: " + r.status }, 409);
        if (r.kind !== "website") return json({ error: "classifier is website-only in Phase 1" }, 400);
        const threshold = r.auto_decide_threshold !== null && r.auto_decide_threshold !== undefined ? Number(r.auto_decide_threshold) : 0.70;
        // Smart-cache reuse: a fresh analysis (24h) for the same target.
        const cached = await sql(env, `SELECT * FROM ai_analysis_results WHERE target_type = 'website' AND target = ${lit(r.target)} AND created_at > now() - interval '24 hours' ORDER BY created_at DESC LIMIT 1`);
        let analysis;
        if (cached.length) {
          analysis = { ...cached[0].result, cached: true };
        } else {
          const words = await sql(env, `SELECT word FROM blocked_words`);
          const fetched = await fetchPageText(r.target);
          if (!fetched.ok) {
            analysis = { verdict: "reject", confidence: 0.5, reasons: ["could not fetch site content: " + fetched.reason], signals: { fetch: fetched.reason }, cached: false };
            await sql(env, `INSERT INTO ai_analysis_results (target_type, target, result) VALUES ('website', ${lit(r.target)}, ${lit(JSON.stringify(analysis))}::jsonb)`);
            const upd = await applyAutoDecision(env, r, analysis.verdict, analysis.confidence, analysis.reasons, threshold);
            return json({ data: { request: upd, analysis } });
          }
          const scored = scoreContent(fetched.text, words.map((w) => w.word));
          const v = verdictFromScore(scored.score, scored.reasons);
          analysis = { ...v, signals: { score: scored.score, word_hits: scored.hits, bytes: fetched.bytes, final_url: fetched.finalUrl }, cached: false };
          await sql(env, `INSERT INTO ai_analysis_results (target_type, target, result) VALUES ('website', ${lit(r.target)}, ${lit(JSON.stringify(analysis))}::jsonb)`);
        }
        const upd = await applyAutoDecision(env, r, analysis.verdict, analysis.confidence, analysis.reasons, threshold);
        return json({ data: { request: upd, analysis } });
      }
      if (resource === "requests" && request.method === "POST") {
        if (!body.customer_id || !isUuid(body.customer_id) || !["website", "app"].includes(body.kind) || !body.target) {
          return json({ error: "customer_id, kind (website/app) and target are required" }, 400);
        }
        const rows = await sql(env, `INSERT INTO approval_requests (customer_id, device_id, kind, target)
          VALUES (${lit(body.customer_id)}, ${body.device_id && isUuid(body.device_id) ? lit(body.device_id) : "NULL"}, ${lit(body.kind)}, ${lit(body.target.toLowerCase().trim())}) RETURNING *`);
        await audit(env, "request.created", "approval_requests", rows[0].id, { kind: body.kind, target: body.target });
        return json({ data: rows[0] }, 201);
      }
      if (resource === "requests" && request.method === "PATCH" && id) {
        if (!["approved", "rejected", "review"].includes(body.status)) return json({ error: "status must be approved, rejected or review" }, 400);
        const cur = await sql(env, `SELECT * FROM approval_requests WHERE id = ${lit(id)}`);
        if (!cur.length) return json({ error: "Request not found" }, 404);
        const r = cur[0];
        const upd = await sql(env, `UPDATE approval_requests SET status = ${lit(body.status)}, decided_at = now() WHERE id = ${lit(id)} RETURNING *`);
        // Phase 1 approval flow: a decision updates the customer's list.
        if (body.status === "approved" && r.kind === "website") {
          await sql(env, `INSERT INTO domains (customer_id, domain, decision, source) VALUES (${lit(r.customer_id)}, ${lit(r.target)}, 'allow', 'request')
            ON CONFLICT (customer_id, domain) WHERE customer_id IS NOT NULL DO UPDATE SET decision = 'allow', source = 'request'`);
        }
        if (body.status === "rejected" && r.kind === "website") {
          await sql(env, `INSERT INTO domains (customer_id, domain, decision, source) VALUES (${lit(r.customer_id)}, ${lit(r.target)}, 'block', 'request')
            ON CONFLICT (customer_id, domain) WHERE customer_id IS NOT NULL DO UPDATE SET decision = 'block', source = 'request'`);
        }
        await audit(env, "request." + body.status, "approval_requests", id, { kind: r.kind, target: r.target });
        return json({ data: upd[0] });
      }

      // ---- ai analysis results ----
      if (resource === "analysis" && request.method === "GET") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
        const rows = await sql(env, `SELECT * FROM ai_analysis_results ORDER BY created_at DESC LIMIT ${limit}`);
        return json({ data: rows });
      }

      // ---- audit logs ----
      if (resource === "audit-logs" && request.method === "GET") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
        const rows = await sql(env, `SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ${limit}`);
        return json({ data: rows });
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
