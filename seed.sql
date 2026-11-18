-- Filter Platform — Phase 1 seed: REAL DATA ONLY (Yakob, 2026-11-18).
-- No demo/sample/placeholder rows. Only:
--  - the default Standard policy (+ its v1 snapshot)
--  - global allow/block domain lists with REAL domains
--  - global application allow/block list with REAL package IDs
--  - the explicit-words blocklist
-- Customers, devices, requests, audit rows and status rows are created
-- for real through the API (dogfood flow), never seeded.

INSERT INTO policies (name, description, strictness, cover_images, block_images, filter_videos, filter_ads, require_approval_for_new_sites, is_default, auto_decide_threshold)
SELECT 'Standard — block images + explicit words, rest open', 'Default policy (Yakob, 2026-11-18): blocks human pictures and really dirty words, even in text; everything else stays open. Blacklist mode.', 2, false, true, false, false, false, true, 0.70
WHERE NOT EXISTS (SELECT 1 FROM policies WHERE is_default = true);

INSERT INTO policy_versions (policy_id, version, snapshot)
SELECT id, 1, jsonb_build_object(
  'name', name, 'strictness', strictness, 'cover_images', cover_images,
  'block_images', block_images, 'filter_videos', filter_videos,
  'filter_ads', filter_ads, 'require_approval_for_new_sites', require_approval_for_new_sites,
  'is_default', is_default, 'auto_decide_threshold', auto_decide_threshold)
FROM policies WHERE is_default = true
ON CONFLICT (policy_id, version) DO NOTHING;

-- Global allow list: real, well-known clean sites.
INSERT INTO domains (customer_id, domain, decision, category, source) VALUES
  (NULL, 'wikipedia.org', 'allow', 'education', 'manual'),
  (NULL, 'khanacademy.org', 'allow', 'education', 'manual'),
  (NULL, 'archive.org', 'allow', 'education', 'manual'),
  (NULL, 'gutenberg.org', 'allow', 'books', 'manual'),
  (NULL, 'chabad.org', 'allow', 'jewish', 'manual')
ON CONFLICT (domain) WHERE customer_id IS NULL DO NOTHING;

-- Global block list: real, well-known domains per category.
INSERT INTO domains (customer_id, domain, decision, category, source) VALUES
  (NULL, 'facebook.com', 'block', 'social', 'manual'),
  (NULL, 'instagram.com', 'block', 'social', 'manual'),
  (NULL, 'tiktok.com', 'block', 'social', 'manual'),
  (NULL, 'x.com', 'block', 'social', 'manual'),
  (NULL, 'snapchat.com', 'block', 'social', 'manual'),
  (NULL, 'reddit.com', 'block', 'social', 'manual'),
  (NULL, 'pornhub.com', 'block', 'adult', 'manual'),
  (NULL, 'xvideos.com', 'block', 'adult', 'manual'),
  (NULL, 'xnxx.com', 'block', 'adult', 'manual'),
  (NULL, 'onlyfans.com', 'block', 'adult', 'manual'),
  (NULL, 'bet365.com', 'block', 'gambling', 'manual')
ON CONFLICT (domain) WHERE customer_id IS NULL DO NOTHING;

-- Global application list: real package IDs.
INSERT INTO applications (customer_id, package_id, name, platform, decision, category, source) VALUES
  (NULL, 'com.whatsapp', 'WhatsApp', 'android', 'allow', 'messaging', 'manual'),
  (NULL, 'com.google.android.youtube', 'YouTube', 'android', 'allow', 'video', 'manual'),
  (NULL, 'com.zhiliaoapp.musically', 'TikTok', 'android', 'block', 'social', 'manual'),
  (NULL, 'com.instagram.android', 'Instagram', 'android', 'block', 'social', 'manual'),
  (NULL, 'com.facebook.katana', 'Facebook', 'android', 'block', 'social', 'manual'),
  (NULL, 'com.snapchat.android', 'Snapchat', 'android', 'block', 'social', 'manual')
ON CONFLICT (package_id) WHERE customer_id IS NULL DO NOTHING;

-- Explicit-words text blocklist.
INSERT INTO blocked_words (word, category) VALUES
  ('porn', 'explicit'), ('pornhub', 'explicit'), ('xvideos', 'explicit'),
  ('xxx', 'explicit'), ('onlyfans', 'explicit'), ('sex', 'explicit'),
  ('nude', 'explicit'), ('escort', 'explicit')
ON CONFLICT (word) DO NOTHING;
