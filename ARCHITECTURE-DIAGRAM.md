# Filter Platform — Architecture Diagram + Module Split

Status: 2026-11-18 ~13:40 EST. Phases 1–4 core are built; Phase 5
(device apps/MDM) and Phase 6 (production) are not. **Decisions
2026-11-18 ~12:55 EST (Yakob, binding): browser base = GeckoView
160.0.20261116130455 (stable, MPL-2.0, AC 160.0.1) — prototype built,
see `android/GECKOVIEW-PROTOTYPE.md`; Cromite demoted (GPLv3); raw
Chromium backup only. EfficientDet-Lite0 prototype-only; production
candidate Intel OMZ person-detection-0202 (see `ARCHITECTURE.md`
Decisions §1–§3 and `scanner/models/PRODUCTION-MODELS.md`). This doc is
the architecture-diagram deliverable for the master plan: what exists,
where each piece runs, and how data flows. Vendors: **Cloudflare +
Neon + GitHub only**.

## System diagram

```
                    ┌─────────────────────────────┐
                    │  USER DEVICES               │
                    │                             │
                    │  ┌─ Browser extension (MV3) │──┐
                    │  │  desktop Chrome/Edge;    │  │
                    │  │  Android via Vivaldi 8.2+│  │
                    │  └──────────────────────────┘  │
                    │  ┌─ Android app (Kotlin)    │  │
                    │  │  setup · register ·      │  │
                    │  │  policy · heartbeat ·    │  │
                    │  │  GeckoView browser +     │  │
                    │  │  built-in visual filter  │  │
                    │  └──────────────────────────┘  │
                    │  ┌─ Dashboard (any browser) │  │
                    │  │  Yiddish RTL, admin +    │  │
                    │  │  customer tabs           │  │
                    │  └──────────────────────────┘  │
                    └──────────────┬──────────────┘
                                   │ HTTPS + Bearer API_TOKEN
                                   ▼
              ┌────────────────────────────────────────┐
              │  CLOUDFLARE                            │
              │                                        │
              │  Worker: filter-platform-api           │
              │  · /health (public)                    │
              │  · /api/v1/* (customers, devices,      │
              │    policies, domains, applications,    │
              │    blocked-words, requests, analysis,  │
              │    audit-logs, ads/blocklist,          │
              │    safesearch)                         │
              │  · rules classifier (text) +           │
              │    auto-decide / threshold 0.70        │
              │                                        │
              │  Pages: filter-platform-dashboard      │
              │  · static dashboard (direct upload)    │
              └──────────────┬─────────────────────────┘
                             │ Neon HTTP /sql
                             ▼
              ┌────────────────────────────────────────┐
              │  NEON POSTGRES 17 — "Filter Platform"  │
              │  13 tables: users, customers, devices, │
              │  policies, policy_versions, domains,   │
              │  applications, approval_requests,      │
              │  ai_analysis_results, audit_logs,      │
              │  device_status, blocked_words,         │
              │  ad_domains                            │
              └────────────────────────────────────────┘

     ┌──────────────────────────────────────────────────┐
     │  SCANNER HOST (currently this VM / future        │
     │  container — NOT yet a deployed service)         │
     │                                                  │
     │  scanner/ (Playwright + headless Chromium)       │
     │  · renders the page in an isolated context       │
     │  · collects img / CSS bg / svg / canvas / video  │
     │  · MediaPipe ObjectDetector (EfficientDet-Lite0, │
     │    person) + face-api.js fallback (face)         │
     │  · person OR face = human; fail closed to REVIEW │
     │  · writes Visual Content Map JSON                │
     │    (ALLOW / COVER / BLOCK / REVIEW)              │
     │  · SSRF guard (24 unit cases) + sandbox          │
     │                                                  │
     │  NOTE (Yakob decision 2026-11-18): the          │
     │  Playwright/Chromium scanner is the              │
     │  PRE-RENDERING prototype only. The production    │
     │  scanner must check visual content INSIDE        │
     │  GeckoView (built-in privileged WebExtension +   │
     │  content scripts + native bridge; fail-closed    │
     │  covering; 8 content types tested separately).   │
     │  Chromium-scanner results do NOT transfer        │
     │  automatically to GeckoView. See                 │
     │  android/GECKOVIEW-PROTOTYPE.md.                 │
     └──────────────────────────────────────────────────┘
```

## Module split — what runs where

| Module | Runs in / on | What it does | Status |
|---|---|---|---|
| Extension background (`extension/background.js`) | User's browser (service worker) | Fetches policy + domains + ads blocklist from the API; builds DNR rules (domains 1000+, ads 5000+ gated on `filter_ads`); hourly re-sync; cache fallback offline | Live, verified (3 modes + ads both flag states) |
| Extension content script (`extension/content.js`) | User's browser (page) | Scans `<img>`, CSS backgrounds, lazy + dynamic (MutationObserver); on-device **face** detection; block / cover / strict | Live, verified; **face-only** — the person detector lives in the scanner only, not yet in the extension |
| Extension popup (`extension/popup.html/js`) | User's browser | Token + device id, demo switch, sync, policy + rule counts + ads state | Live |
| Android app (`android/`, Kotlin) | Android phone | Setup (URL + token, encrypted), device registration (6-digit code), policy display, heartbeat/status, dashboard link. **GeckoView browser prototype (Yakob decision 2026-11-18):** own-UI browser Activity (address bar, navigation), own `FilterEngine`, built-in privileged WebExtension + content script (fail-closed covering) + native bridge; test pages for 8 content types (`android/test-pages/`). 22/22 unit tests pass; manual debug APK verified (200,066,826 bytes, arm64-v8a, apksigner v2+v3). **Never run on a phone yet** — GeckoView startup, extension install, injection, bridge and cover behaviour are unproven until a real-device run. Gradle build blocked: JVM data transfer is intercepted on this VM AND SDK platform 37 is unpublished (GeckoView 160 AAR needs `minCompileSdk=37`) — Gradle fails on every machine until Google publishes it; manual build (`build.sh`, android.jar 34) is the verified path. There is no `other_tcp` setting; do not ask Yakob for it |
| Dashboard (`public/index.html`) | Any browser (Cloudflare Pages) | Admin: customers, devices (+live status/last seen), policies, domains, apps, blocked words, requests, analyses, audit. Customer: my devices, policy, domain check, register-with-code. New: ads blocklist (26), SafeSearch (7 rules), scan stats | Live, redeployed 2026-11-18 |
| Worker API (`worker.js`) | Cloudflare Workers | All `/api/v1/*` endpoints; rules classifier on real fetched page text; auto-decide; threshold 0.70; SafeSearch + ads config endpoints | Live (Phase 1 + Phase 3; `asBool` policy bug fixed 2026-11-18) |
| Database (Neon) | Neon Postgres 17 | 13 tables (see diagram); default Standard policy; 16 seeded domains; 26 ad domains; 8 blocked words | Live |
| Scanner (`scanner/`) | Scanner host (VM/container) | Pre-rendering inspection: Playwright render → MediaPipe person + face detection → Visual Content Map → verdicts | Prototype v0.2.0, verified on real sites + real video/canvas pages. Not yet a deployed service; no Queue/R2 wiring yet |
| Egress relay (`harness/egress-relay.js`) | VM only (test tooling) | Lets the VM's Chromium reach the internet through the sandbox proxy; fixed 2026-11-18 (pipelined-`head` bug) | Test-only; production scanner hosts have direct internet and need no relay |

## Data flows

1. **Device registration:** customer → `POST /devices` (pending + 6-digit code)
   → `POST /devices/register {code}` → active → heartbeat → `device_status`.
2. **Browsing (extension):** navigation → DNR rules (domains always; ads only
   if `filter_ads=true`) → content script scans images → face detect →
   block/cover/strict per policy; uncertain covered only in strict.
3. **Pre-render scan:** URL → scanner (isolated Chromium) → collect elements
   → MediaPipe person + face-api fallback → Visual Content Map →
   ALLOW/COVER/BLOCK/REVIEW. Video = one captured frame; 2D canvas = screenshot
   path (immune to the `<img>` CORS gate); WebGL unanalysable.
4. **Approval:** unlisted site → `POST /requests` (pending) →
   `POST /requests/:id/classify` (real fetched text, rules score) →
   confidence ≥ 0.70 → approved/rejected + list update; below → review bucket,
   site stays blocked (`domains/check` → `pending-review`).
5. **SafeSearch:** `GET /api/v1/safesearch` returns the policy flag + per-engine
   rules (Google/Bing/DuckDuckGo/YouTube). **Config only so far** — the
   extension does not yet rewrite search URLs or set DNS.
6. **Ads:** `GET /api/v1/ads/blocklist` (26 domains, `?category=` filter).
   Enforced by the extension only when the policy has `filter_ads=true`.

## What runs in the browser vs on the servers

- **In the browser:** extension UI + DNR enforcement + on-device face
  detection; dashboard UI (all logic is API calls); Android app UI.
- **On the servers (Cloudflare + Neon):** API, auth, policies, lists,
  decisions, audit, storage. No image/AI inference runs on the Worker —
  the Worker is API/orchestration only.
- **On the scanner host:** rendering + AI inference (MediaPipe/face-api on
  CPU). This is the only place full pages are rendered and analyzed.
- **On the device (Android app):** registration, policy display, heartbeat
  — plus the GeckoView browser prototype with its own filtering engine
  (built-in privileged WebExtension + content script + native bridge;
  fail-closed covering; stub person detector — everything stays covered
  until a real detector runs). The filtering engine is the extension
  (Vivaldi) on desktop; on Android it is now the GeckoView prototype,
  unproven on a real device.

## Not yet built

- Cloudflare Queues for background scan dispatch; R2 for scan maps /
  screenshots (assessed: plausible, not wired — scanner is still a local
  prototype, not a service).
- Person detection inside the **extension** (scanner-only today).
- SafeSearch enforcement in the extension/device (config endpoint only).
- Full custom browser (base decision MADE 2026-11-18: GeckoView;
  prototype built — see Android app row above). Still to prove on a real
  Android device: GeckoView startup, extension install, content-script
  injection, native-bridge round-trip, cover behaviour on the 8 content
  types, person detection on real sites inside GeckoView. Gradle build
  blocked until Google publishes SDK platform 37. Phase 5 device
  apps/MDM; Phase 6 production hardening (restricted CORS, rate limits,
  per-customer auth, monitoring, load testing).
- Google Images verification (Google serves headless Chromium its `/sorry`
  bot-check page; needs a machine where Google serves real results to a
  real browser).
