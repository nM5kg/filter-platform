# Filter Platform — Architecture (Phase 1: Core Platform)

Built 2026-11-18. Stack: **Neon (PostgreSQL 17) + Cloudflare Workers + Cloudflare Pages**.
Everything is NEW and separate — nothing touches Gavhah, Webline 101, Hotline
Platform, kolylt, or any existing Worker/database/repo.

## Decisions 2026-11-18 ~12:55 EST (Yakob — binding)

### 1. Browser base = GeckoView (main candidate)

- **GeckoView 160.0.20261116130455** (stable channel, Firefox 160.0.1 build
  2026-11-16), **MPL-2.0**; matching Android Components **160.0.1** (also
  MPL-2.0). Verified 2026-11-18 from Mozilla Maven metadata — see
  `android/GECKOVIEW-RESEARCH.md`. Own Browser App + own Filtering Engine,
  using Mozilla Android Components where they help build browser
  UI/functions — NOT a ready-made foreign browser UI. Stable release, NOT
  Nightly, for the first production version. Pin `geckoview-omni`
  explicitly alongside AC's `browser-engine-gecko`; never mix plain
  `geckoview` with `-omni`.
- **Cromite is NOT the main base** (GPLv3 — the browser app itself would
  have to be open source). **Raw Chromium stays a backup only**, if
  GeckoView cannot meet the technical requirements.
- **Prototype built 2026-11-18** (see `android/GECKOVIEW-PROTOTYPE.md`):
  GeckoView browser Activity with own UI (address bar, navigation), own
  `FilterEngine`, built-in privileged WebExtension + content script
  (fail-closed covering), native bridge (WebExtension message handler <->
  Kotlin). Unit tests 22/22 pass. Manual debug APK verified (200,066,826
  bytes, arm64-v8a, apksigner v2+v3, `com.filterplatform.app`). Never run
  on a phone yet — GeckoView startup, extension install, content-script
  injection, bridge round-trip and cover behaviour on real sites are all
  UNPROVEN until a real Android device run.

### 2. EfficientDet-Lite0 — prototype / first testing ONLY

- Do NOT confirm it as the production model until exact weights, hash,
  source and license are verified. Hash confirmed (independently, twice):
  sha256 `4b59100025bea1235a84c1038879a6cccc9f6c49f5e41144e91e74d99e780993`,
  float16, 7,254,339 bytes, source Google's official MediaPipe bucket.
  Weights license still UNVERIFIED — see `scanner/models/LICENSES.md` and
  `scanner/models/PRODUCTION-MODELS.md` (pub.dev's Apache 2.0 claim covers
  the float32 v1 builds, not our float16 file; "KTag SBOM" could not be
  located; TF Hub is Kaggle-gated and unreadable).
- **Production candidate: Intel OMZ person-detection-0202** (Apache 2.0 repo
  license verified; IR-only; conversion path IR → ONNX via community tool
  `openvino2onnx`, then one ONNX file serves extension (onnxruntime-web /
  WASM), Android (onnxruntime-android AAR) and scanner (onnxruntime-node)).
  Open: published `model.yml` checksums do NOT match the files the bucket
  serves (measured FP16 .bin sha256 `11599bdd44bf863d…`, published
  `2a149bc8c2f02965c…`), and Intel staff (2026-11-18) say to get written
  confirmation before commercial shipment. License-cleanest fallback:
  RF-DETR Nano (Apache 2.0, README explicitly allows closed-source
  commercial use; ~122 MB FP32). Nothing here is legal advice.

### 3. Visual Scanner — GeckoView-native (rework)

- Do NOT assume the Playwright Chromium scanner sees the same content as
  the Android browser. The scanner must check visual content INSIDE
  GeckoView: built-in privileged WebExtension + content scripts + native
  bridge (see prototype, §1). Test separately: HTML images, CSS
  backgrounds, Canvas, SVG, WebGL, video frames, live streams, dynamic
  content. Unreviewed visual content stays COVERED until a decision is
  ready (fail closed). The Playwright/Chromium scanner (`scanner/`)
  remains the pre-rendering prototype and its results do NOT transfer
  automatically to GeckoView.

### 4. Order of work

1. GeckoView Browser Prototype with the Visual Filter integrated (done,
   2026-11-18 — see §1). 2. Prove the scanner detects people on real
   sites incl. canvas and video INSIDE GeckoView (needs a real Android
   device). 3. Then continue with the whole platform. Do NOT rebuild the
   whole project.

### 5. Build environment (verified 2026-11-18, corrects the old record)

- Installed Gradle 8.5 (`~/gradle-8.5/bin/gradle`) RUNS (`gradle --version`
  → Gradle 8.5 / JVM 17.0.21, exit 0). Use it directly, never `./gradlew`
  (the wrapper fails: its distribution download dies in the SSL
  handshake).
- BUT: JVM data transfer is still intercepted on this VM — a Java Socket
  connects, but the first `read()` returns the 193-byte sandbox
  interceptor message (`muse: Other TCP connections is turned off…`); the
  Gradle daemon dies on the loopback socket with the same bytes. So
  Gradle cannot download dependencies here. AND: **SDK platform 37 does
  not exist for download** (verified 2026-11-18: `repository2-1.xml`
  lists at most platform-36-ext19; `platform-37_r01.zip` → 404) while the
  GeckoView 160 AAR declares `minCompileSdk=37` — a Gradle build of this
  module fails on EVERY machine right now, not just this VM, until Google
  publishes SDK platform 37.
- The manual build (`android/manual-build/build.sh`, curl for deps, kotlinc
  + aapt2 + d8) is therefore the primary verified build path: it compiles
  against android.jar 34 (a prototype-only compromise vs the AAR's
  minCompileSdk=37) and produced the verified 200 MB APK above.
- There is NO `other_tcp` / "Direct network protocols" setting anywhere
  in Muse's permissions — do not send Yakob hunting for it.

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
| `ad_domains` | Phase 3 starter: ad/tracker domains (category `ads`/`tracking`/`analytics`), seeded with 26 real domains (15 ads, 11 tracking, 0 analytics). Separate from `domains`; enforced only when the policy has `filter_ads=true`. Extension DNR enforcement wired 2026-11-18 (see "What is NOT built" / Phase 3 wiring). |

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
- `force_safesearch = true` (Phase 3 starter, `policies` column added by
  `migration-002-phase3.sql`).
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
| `GET /api/v1/devices` | List with customer + policy names. `?customer_id=` filters to one customer (fixed 2026-11-18 — it used to ignore the filter). |
| `GET /api/v1/devices/:id/status` | Latest status row. |
| `GET /api/v1/ads/blocklist` | Phase 3 starter: ad/tracker domains from the `ad_domains` table (`?category=ads|tracking|analytics`). Enforced only when the device policy has `filter_ads=true`; the main `domains/check` flow is untouched. The extension enforces it via DNR since 2026-11-18 (ads rules in id range 5000+, verified in `extension/verify/results-phase3-ads.json`). |
| `GET /api/v1/safesearch` | Phase 3 starter: SafeSearch enforcement config for the resolved policy (`?device_id=` / `?customer_id=`, else the default policy). Returns `force_safesearch` + per-engine URL-param and DNS-CNAME rules (Google `safe=active` / `forcesafesearch.google.com`, Bing `adlt=strict` / `strict.bing.com`, DuckDuckGo `kp=1` / `safe.duckduckgo.com`, YouTube `restrict.youtube.com`). |
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
**Phase 3 additions (2026-11-18):** ads/tracker blocklist card — lists the 26
`ad_domains` from `GET /api/v1/ads/blocklist` with a category filter
(all/ads/tracking/analytics; live counts 15/11/0) and a note that the list
only takes effect when the policy has `filter_ads=true`; SafeSearch card —
`GET /api/v1/safesearch` for the default policy or a chosen device, showing
`force_safesearch` + the 7 per-engine URL-param/DNS-CNAME rules; scan-stats
card — the `GET /api/v1/analysis` list upgraded to summary tiles (total /
approved / rejected / avg confidence / from-cache) + a table with time,
target, verdict, confidence, reasons; devices table now shows live status
(`GET /api/v1/devices/:id/status` — online/offline) and last-seen time, and
the customer view shows last-seen + the policy's ads/SafeSearch flags.
Customer tab: pick a customer, my devices, my policy, domain check tool,
register-a-device-with-code form, my requests + new request form. The API
token is typed in once and kept in `sessionStorage` only.
Deploy: `python3 pages_deploy.py` (upload-token → check-missing → upload →
upsert-hashes → deployment; blake3 asset hash). GitHub→Pages integration is
broken (error 8000011), so direct upload is the path; re-run the script for
updates. Verified live 2026-11-18 via `harness/verify-dashboard-phase3.js`
(Playwright through the egress relay): HTTP 200, 26 ads rows, 7 SafeSearch
rules, 4 analyses (1 approved / 3 rejected, avg confidence 0.73), 5 devices
with live status + last seen, tracking filter → 11 rows, per-device SafeSearch
resolves to the same Standard policy.

## How Phase 2 plugs in

- **Browser extension / custom browser:** calls `GET /domains/check` per
  navigation and reads the device's policy (`GET /devices`, `GET /policies/:id`)
  for `block_images`/`cover_images`; reports new images through the same
  `POST /requests` flow. No API change needed. The custom browser is the
  GeckoView prototype (`android/` — see Decisions §1); its in-browser visual
  filter is a built-in privileged WebExtension + content script + native
  bridge, NOT the MV3 extension (different runtime).
- **Image/video AI (Visual Shield):** replaces/augments `scoreContent()` via
  the adapter contract above; per-image verdicts can reuse `ai_analysis_results`
  with `target_type='image'`.
- **Device apps (Android Enterprise / iOS MDM):** use `applications` list +
  `devices/register` + `heartbeat` as the device-management spine.
- **SafeSearch / ads / video:** new policy flags on `policies` + new list
  tables mirroring `domains`.

## What is NOT built (Phases 4–6)

Custom Android browser — **decision made 2026-11-18 (Yakob): GeckoView**
(see Decisions §1); the prototype is built (`android/`,
`GECKOVIEW-PROTOTYPE.md`, 22/22 unit tests, 200 MB manual APK verified)
but has never run on a phone — GeckoView startup, extension install,
content-script injection, bridge round-trip and cover behaviour on real
sites are all unproven until a real Android device run. Gradle build is
blocked until Google publishes SDK platform 37 (the GeckoView 160 AAR
declares `minCompileSdk=37`). Full SafeSearch enforcement in the
extension/device (the Worker config endpoints exist — Phase 3 starters —
and the dashboard shows them, but the extension does NOT yet rewrite
search URLs or set DNS; that is the next Phase 3 step), the real
open-source AI model (Phase 4; the scanner and extension both use face
detection as the placeholder detector), device apps, Android Enterprise /
iOS MDM, production hardening (restricted CORS, rate limits, per-customer
auth, password hashing for `users`, backups, monitoring, load testing).

Built overnight 2026-11-18 (all verified live, see below): the MV3 browser
extension (`extension/` — policy fetch, on-device face detection,
cover/block/strict, DNR blocklist, test page with real photos; verification
in `extension/verify/VERIFY.md` + `results.json`, and the relay re-run
`results-relay.json` which proved the LIVE policy fetch in-browser);
the pre-rendering scanner (`scanner/` — verified on 4 real sites, see
`scanner/README.md` and `scanner/SCAN_REPORT.md`); the Phase 3 starters
(`ad_domains` + `GET /api/v1/ads/blocklist`, `force_safesearch` +
`GET /api/v1/safesearch`).

**Phase 3 wiring, 2026-11-18 ~10:45 EST (this session):** the dashboard now
shows the ads blocklist, SafeSearch config and scan stats (see Dashboard
above), and the extension enforces the ads blocklist via DNR — but ONLY when
the device policy has `filter_ads=true` (ads rules live in their own DNR id
range 5000+, domains stay 1000+; `fpAdBlocklist` cached alongside the domains
list, same gate on the cache path). Verified live via
`harness/verify-phase3-ads.js` (Playwright + egress relay, both runs LIVE
sync from the service worker): Standard policy (`filter_ads=false`) → 22 DNR
rules, 0 ads rules; temporary test policy (`filter_ads=true`, device deleted
after) → 74 rules (22 + 52 ads) and `doubleclick.net` navigation fails with
`ERR_BLOCKED_BY_CLIENT`; results in `extension/verify/results-phase3-ads.json`.
The Phase 2 regression re-run (`harness/verify-phase2-relay.js block`) still
passes: 22 domain rules, 9 found/10 scanned, 6 human blocked, facebook.com
blocked. Worker fix in the same session: `POST /api/v1/policies` used
`isBool(...)` (a type check) as the stored value, so EVERY boolean flag came
back `true` no matter what the caller sent — including `filter_ads=false`.
Fixed with a real coercion (`asBool`); verified live (create with all flags
false → POST and GET both return false; test policies deleted, 1 policy left).
The fix is why a `filter_ads=false` policy created through the API could
previously have silently enabled ads filtering.

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

## GitHub

Repo: `nM5kg/filter-platform` (public, main) — created 2026-11-18, **37
commits** as of 2026-11-18 ~06:52 EST (92 files incl. Phase 1, extension,
scanner, Android skeleton; verified via raw.githubusercontent.com). Push
from `~/workspace/filter-platform/` via the browser upload flow (GitHub
web UI, signed in as nM5kg): `schema.sql`, `seed.sql`,
`migration-001-policy-decision.sql`, `cleanup-001-demo-data.sql`, `worker.js`,
`deploy.py`, `pages_deploy.py`, `fpsql.py`, `verify_api.py`, `dogfood.py`,
`create_project.py`, `save_uri.py`, `get_code.py`, `public/index.html`,
`ARCHITECTURE.md`. **Do NOT push** `database_url.txt` or `api_token.txt`
(0600, secrets — they stay local and as Cloudflare secrets).
