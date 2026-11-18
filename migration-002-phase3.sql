-- Filter Platform — Phase 3 starters (migration 002)
-- 1. ad_domains: separate ad/tracker list (NOT in the main `domains` table),
--    enforced only when the device policy has filter_ads=true. The browser
--    extension's declarativeNetRequest rules consume GET /api/v1/ads/blocklist.
-- 2. policies.force_safesearch: SafeSearch enforcement flag (default true).
--    GET /api/v1/safesearch returns the URL-param + DNS rules for it.
-- Real domains only, no placeholders.

CREATE TABLE IF NOT EXISTS ad_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('ads', 'tracking', 'analytics')),
  source TEXT NOT NULL DEFAULT 'ads-list',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO ad_domains (domain, category) VALUES
  ('doubleclick.net', 'ads'),
  ('googlesyndication.com', 'ads'),
  ('googleadservices.com', 'ads'),
  ('googletagservices.com', 'ads'),
  ('adnxs.com', 'ads'),
  ('criteo.com', 'ads'),
  ('outbrain.com', 'ads'),
  ('taboola.com', 'ads'),
  ('adsrvr.org', 'ads'),
  ('pubmatic.com', 'ads'),
  ('rubiconproject.com', 'ads'),
  ('moatads.com', 'ads'),
  ('adsafeprotected.com', 'ads'),
  ('doubleverify.com', 'ads'),
  ('ads.yahoo.com', 'ads'),
  ('google-analytics.com', 'tracking'),
  ('googletagmanager.com', 'tracking'),
  ('scorecardresearch.com', 'tracking'),
  ('quantserve.com', 'tracking'),
  ('hotjar.com', 'tracking'),
  ('mixpanel.com', 'tracking'),
  ('amplitude.com', 'tracking'),
  ('segment.io', 'tracking'),
  ('fullstory.com', 'tracking'),
  ('mouseflow.com', 'tracking'),
  ('newrelic.com', 'tracking')
ON CONFLICT (domain) DO NOTHING;

ALTER TABLE policies ADD COLUMN IF NOT EXISTS force_safesearch BOOLEAN NOT NULL DEFAULT true;
