# Filter Platform — Architecture (Phase 1: Core Platform)

Built 2026-11-18. Stack: **Neon (PostgreSQL 17) + Cloudflare Workers + Cloudflare Pages**.
Everything is NEW and separate — nothing touches Gavhah, Webline 101, Hotline
Platform, kolylt, or any existing Worker/database/repo.

## Live endpoints

- API Worker: `https://filter-platform-api.gavhah-copy.workers.dev`
- Dashboard (admin + customer): `https://filter-platform-dashboard.pages.dev`
- Neon project: **Filter Platform**, id `wandering-brook-58542930`, region
  `aws-us-east-2`, PG 17, DB `filter`, role `filter_admin`, branch `main`
  (`br-muddy-glitter-bdbpgj7l`).
- Cloudflare account: `123456789gotit` (`8682a959ffd0735a5c8d4c62251cae03`),
  workers.dev subdomain `gavhah-copy`.

## Secrets (never in git, never printed)

- `~/workspace/filter-platform/database_url.txt` (0600) — Neon pooled URI.
- `~/workspace/filter-platform/api_token.txt` (0600) — Worker `API_TOKEN`.
- Both are also set as Cloudflare Worker secrets (`DATABASE_URL`, `API_TOKEN`).
- The dashboard asks for the API token in the browser; it is kept only in
  `sessionStorage` of that tab.

## Schema (12 tables, `schema.sql`)

| Table | Purpose |
|---|---|
| `users` | Admin/staff accounts (`super_admin`, `admin`, `support`, `viewer`). Password hashes only; the API never returns them. |
| `customers` | Customer accounts (name, email, phone, status). |
| `devices` | One row per customer device. `status` pending/active/inactive, `activation_code` (6 digits, unique), `policy_id`, `activated_at`, `last_seen_at`. New devices get the default policy automatically. |
| `policies` | Filter policies. `is_default` marks the default; `auto_decide_threshold` (default 0.70) is the confidence below which the AI sends a request to review. |
| `policy_versions` | Immutable snapshot (JSONB) per policy version, for audit/rollback. |
| `domains` | Allow/block list. `customer_id` NULL = global list; set = per-customer override. Partial unique indexes enforce one row per (domain) globally and per (customer, domain). |
| `applications` | App allow/block list by package/bundle id, same global/per-customer shape as `domains`. |
| `approval_requests` | Website/app approval requests. `status` pending/approved/rejected/review. Automated-decision fields: `ai_verdict`, `ai_confidence`, `ai_reasons` (JSONB), `auto_decided_at`, `review_reason`. |
| `ai_analysis_results` | Stored classifier runs (target, full result JSONB). Also the 24h smart-cache source. |
| `audit_logs` | Every create/decision/activation, with actor, action, entity, details JSONB. |
| `device_status` | Heartbeat log per device (online/offline/unknown, filter_active, policy_version). Latest row = current status. |
| `blocked_words` | Explicit-words text blocklist (global, Phase 1). Matched against real fetched page text by the classifier. |

Seed (`seed.sql`, real data only — no demo/sample rows): the default Standard
policy + v1 snapshot, 16 global domains (5 allow, 11 block, real domains in
education / jewish / social / adult / gambling), 6 real app package IDs,
8 explicit words. Customers, devices, requests and audit rows are created
only through the real API flow.

## The default policy (Yakob, 2026-11-18 ~03:53 EST)

**"Standard — block images + explicit words, rest open"** (`is_default = true`).
- `block_images = true` (human pictures are blocked, not just covered),
  `cover_images = false`, `filter_videos = false`, `filter_ads = false`,
  `require_approval_for_new_sites = false` — blacklist mode: everything not
  on a block list stays open.
- `auto_decide_threshold = 0.70`.
- More policies come later; new devices/customers take this one unless a
  policy is chosen explicitly. Add a policy via `POST /api/v1/policies`;
  set a new default by updating `is_default` (only one row should have it).

## API (`worker.js`, Bearer `API_TOKEN` on all `/api/v1/*`; `/health` public)

| Endpoint | What it does |
|---|---|
| `GET /health` | Service + DB connectivity. |
| `GET/POST /api/v1/customers` | List / create customers. |
| `GET/POST /api/v1/users` | List (no hashes) / create staff users. |
| `GET/POST /api/v1/policies`, `GET /api/v1/policies/:id` | List / create (creates v1 snapshot) / one + its versions. |
| `GET /api/v1/devices` | List with customer + policy names. |
| `POST /api/v1/devices` | Create pending device; returns a 6-digit activation code; default policy applied when none is given. |
| `POST /api/v1/devices/register` `{code}` | Activates a pending device (wrong/used code → 404). Writes a `device_status` row. |
| `POST /api/v1/devices/:id/heartbeat` | Records a status heartbeat. |
| `GET /api/v1/devices/:id/status` | Latest status row. |
| `GET /api/v1/domains?decision=&customer_id=` | List allow/block entries. |
| `GET /api/v1/domains/check?domain=&customer_id=` | Effective verdict: customer list first, then global list, then policy default. A pending/review request for the domain forces `block` (`pending-review`) — uncertain stays blocked. |
| `POST /api/v1/domains` | Add/update a list entry (upsert, global or per-customer). |
| `GET/POST /api/v1/applications` | List / upsert app decisions. |
| `GET/POST /api/v1/blocked-words` | List / add explicit words. |
| `GET/POST /api/v1/requests` | List (filter by status/customer) / create a request. |
| `PATCH /api/v1/requests/:id` `{status}` | Human decision (review bucket only): approved/rejected/review. Updates the customer's domain list. |
| `POST /api/v1/requests/:id/auto-decide` | Machine decision (Phase 4 engine hook): `{verdict, confidence, reasons}`. Below threshold → `review` + `review_reason=low-confidence`, no list change. At/above threshold → final + list update + audit. Already-decided → 409. |
| `POST /api/v1/requests/:id/classify` | Runs the classifier on the request's target (website only), stores the analysis, then auto-decides. Reuses a <24h cached analysis for the same target. |
| `GET /api/v1/analysis`, `GET /api/v1/audit-logs` | Stored analyses / audit trail. |

CORS is open (`*`) for the Phase 1 demo dashboard — restrict it to the
dashboard origin before production use.

## Classifier — transparent rules+scoring (Phase 1), model deferred

Open-source model selection is **deferred** by Yakob's decision. Phase 1 ships
a transparent rules+scoring module that runs on **real fetched site content**
— never on invented examples — with a clean swap-in interface for a real
open-source model later.

- `fetchPageText(target)` — fetches `https://<target>/` (8s timeout, browser
  User-Agent, follows redirects), strips scripts/styles/tags, returns lowercased
  text (first 200KB). Unfetchable → `{ok:false, reason}` → review bucket.
- `scoreContent(text, blockedWords)` — score 0 (clean) to 1 (explicit):
  whole-word hits from `blocked_words` (+0.15 each, capped at +0.6),
  explicit phrases (+0.2 each, capped at +0.4). Empty text → 0.3 (no signal).
- `verdictFromScore(score, reasons)` — ≥0.5 → reject, confidence 0.55–0.99;
  ≤0.15 → approve, confidence 0.80–0.98; middle → lean by score but confidence
  0.5, so the threshold sends it to review.
- Every run is stored in `ai_analysis_results` with the full signals object
  (`score`, `word_hits`, `bytes`, `final_url`, `cached`).

**Swap-in interface for a real open-source model (Phase 4):** replace the
internals of `scoreContent()` (in `worker.js`) with a model adapter. The
adapter contract is: `classify(target, text) -> { verdict: 'approve'|'reject',
confidence: 0..1, reasons: string[], signals: object }`. The endpoint
(`POST /requests/:id/classify`), the `applyAutoDecision()` flow, the threshold
logic, and the DB shape (`ai_analysis_results.result` JSONB,
`approval_requests.ai_*` columns) do **not** change. Candidates named in the
brief (not yet chosen): NSFWJS, MediaPipe, TensorFlow/TFLite.

Known limitation (verified live 2026-11-18): bot-protected sites (e.g.
`bbc.com` returns HTTP 403 to the Worker's fetch even with full browser
headers) cannot be scanned and land in the review bucket, staying blocked.
Phase 4 options: residential egress, headless-browser fetch, or a curated
allowlist fallback for well-known clean sites.

## Approval flow (no human reviews thousands of requests)

1. Customer/device asks for an unlisted site → `POST /requests` (pending).
2. `POST /requests/:id/classify` fetches the real page, scores it, stores the
   analysis, and auto-decides via `applyAutoDecision()`.
3. Confidence ≥ threshold → approved/rejected, and the customer's domain list
   is updated (`source='ai'`). Confidence < threshold → `review` bucket for a
   human; the site stays blocked meanwhile (`domains/check` → `pending-review`).
4. `POST /requests/:id/auto-decide` is the same decision path for an external
   engine (Phase 4) that supplies its own verdict/confidence/reasons.

## Dashboard (`public/index.html`, Pages direct upload)

Single static page (Yiddish RTL) calling the Worker API. Admin tab: health +
counts, customers (+add), devices (+add, shows the activation code once),
policy card, domains allow/block (+add, filter), apps (+add), blocked words
(+add), requests (Classify / Approve / Reject buttons), analyses, audit log.
Customer tab: pick a customer, my devices, my policy, domain check tool,
register-a-device-with-code form, my requests + new request form. The API
token is typed in once and kept in `sessionStorage` only.
Deploy: `python3 pages_deploy.py` (upload-token → check-missing → upload →
upsert-hashes → deployment; blake3 asset hash). GitHub→Pages integration is
broken (error 8000011), so direct upload is the path; re-run the script for
updates.

## How Phase 2 plugs in

- **Browser extension / custom browser:** calls `GET /domains/check` per
  navigation and reads the device's policy (`GET /devices`, `GET /policies/:id`)
  for `block_images`/`cover_images`; reports new images through the same
  `POST /requests` flow. No API change needed.
- **Image/video AI (Visual Shield):** replaces/augments `scoreContent()` via
  the adapter contract above; per-image verdicts can reuse `ai_analysis_results`
  with `target_type='image'`.
- **Device apps (Android Enterprise / iOS MDM):** use `applications` list +
  `devices/register` + `heartbeat` as the device-management spine.
- **SafeSearch / ads / video:** new policy flags on `policies` + new list
  tables mirroring `domains`.

## What is NOT built (Phases 2–6)

Browser extension/custom browser, page-level image covering/blocking, video
frame analysis, Google SafeSearch integration, ad filtering, the real
open-source AI model, device apps, Android Enterprise / iOS MDM, production
hardening (restricted CORS, rate limits, per-customer auth, password hashing
for `users`, backups, monitoring, load testing).

## Operational gotchas (verified)

- API-uploaded Workers have their `workers.dev` route **disabled** by default
  (edge returns 404 `error code: 1042`). Enable with
  `POST /accounts/{id}/workers/scripts/{name}/subdomain {"enabled": true}`.
  `deploy.py` does this after every upload.
- Cloudflare 403s default Python `urllib` User-Agents on `workers.dev`
  (error 1010). Send a browser `User-Agent` (and `Connection: close`); the
  `verify_api.py`/`dogfood.py` scripts do. `curl` works as-is.
- Neon access from this VM is **HTTP `/sql` only** (raw TCP `pg` fails).
  `fpsql.py` reads `database_url.txt` and posts `{query}` to
  `https://<pooler-host>/sql` with the `Neon-Connection-String` header.
- Worker→Neon uses the same `/sql` endpoint from inside the Worker (no driver,
  no bundling).

## Repeating the dogfood test

```bash
cd ~/workspace/filter-platform
python3 dogfood.py        # full end-to-end pass (curl-based); prints every step
python3 verify_api.py     # endpoint smoke test (uses the seeded demo flow)
```
The token lives in `api_token.txt` (0600); the scripts read it, never print it.
To repeat by hand: `POST /customers` → `POST /devices` (note the returned
activation code) → `POST /devices/register` → `GET /domains/check?domain=…` →
`POST /requests` → `POST /requests/:id/classify` → check the dashboards at
the URLs above with the API token.

## GitHub (for the parent to create — not created by this build)

Suggested repo: `nM5kg/filter-platform` (public). Push from
`~/workspace/filter-platform/`: `schema.sql`, `seed.sql`,
`migration-001-policy-decision.sql`, `cleanup-001-demo-data.sql`, `worker.js`,
`deploy.py`, `pages_deploy.py`, `fpsql.py`, `verify_api.py`, `dogfood.py`,
`create_project.py`, `save_uri.py`, `get_code.py`, `public/index.html`,
`ARCHITECTURE.md`. **Do NOT push** `database_url.txt` or `api_token.txt`
(0600, secrets — they stay local and as Cloudflare secrets).
