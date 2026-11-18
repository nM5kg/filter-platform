# Filter Platform — free kosher internet filter

Phase 1 (Core Platform) of a free internet filter platform for the masses:
DNS/domain filtering, page-level policy, an AI approval engine (automatic
approve/reject/review), customer + admin dashboards, all managed from home.

## Live (Phase 1)

- API Worker: https://filter-platform-api.gavhah-copy.workers.dev
- Dashboard (Yiddish RTL): https://filter-platform-dashboard.pages.dev
- Database: Neon Postgres, project "Filter Platform", DB `filter`

## Default policy

"Standard — block images + explicit words, rest open": blocks human pictures
and really explicit words (even in text), leaves the rest open. Other
policies are added later. The free AI auto-decides approve/reject on every
website; uncertain stays blocked (review bucket only). Nobody reviews
thousands of requests by hand.

## Layout

- `schema.sql` — 12 tables (users, customers, devices, policies, domains,
  applications, approval_requests, ai_analysis_results, audit_logs,
  device_status, policy_versions, blocked_words)
- `seed.sql` — the Standard policy + real global allow/block domains and apps
- `migration-001-policy-decision.sql` — the policy decision (threshold 0.70)
- `cleanup-001-demo-data.sql` — removes placeholder rows; real data only
- `worker.js` — Cloudflare Worker API (`/health`, `/api/v1/*`, Bearer auth)
- `deploy.py` — deploys the Worker (enables the workers.dev subdomain)
- `pages_deploy.py` — deploys the dashboard via Pages Direct Upload
- `fpsql.py` — runs SQL against Neon over the HTTP /sql endpoint
- `verify_api.py`, `dogfood.py` — verification; `dogfood.py` is the end-to-end
  acceptance test (register customer → device → activation code → domain
  checks → classify → heartbeat)
- `public/index.html` — the dashboard (admin + customer, Yiddish RTL)
- `ARCHITECTURE.md` — schema, API, classifier swap-in interface, limits

## Secrets (never committed)

`database_url.txt` and `api_token.txt` live only locally (0600) and as
Cloudflare Worker secrets. They are git-ignored.

## Status

Phase 1 done and verified by an independent dogfood pass (2026-11-18).
Phases 2–6 (browser filtering, content filtering, real AI model, device
management, production) are not built yet.
