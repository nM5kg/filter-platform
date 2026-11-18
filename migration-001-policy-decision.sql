-- Filter Platform — migration 001: apply Yakob's 2026-11-18 policy decision
-- to the live DB (schema.sql + seed.sql were already updated to match).
-- 1. Default Standard policy: blocks images + explicit words, rest open.
-- 2. approval_requests gains automated-decision fields (Phase 4 engine);
--    only low-confidence cases go to the review bucket, uncertain stays blocked.
-- 3. New blocked_words table (explicit-words text blocklist).

ALTER TABLE policies ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS auto_decide_threshold NUMERIC(5,4) NOT NULL DEFAULT 0.70;

CREATE TABLE IF NOT EXISTS blocked_words (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  word TEXT NOT NULL UNIQUE,
  category TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'request', 'ai', 'import')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_blocked_words_word ON blocked_words (word);

ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS ai_verdict TEXT CHECK (ai_verdict IN ('approve', 'reject'));
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS ai_confidence NUMERIC(5,4) CHECK (ai_confidence BETWEEN 0 AND 1);
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS ai_reasons JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS auto_decided_at TIMESTAMPTZ;
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS review_reason TEXT;

UPDATE policies
SET name = 'Standard — block images + explicit words, rest open',
    description = 'Default policy (Yakob, 2026-11-18): blocks human pictures and really dirty words, even in text; everything else stays open. Blacklist mode.',
    strictness = 2, cover_images = false, block_images = true,
    filter_videos = false, filter_ads = false,
    require_approval_for_new_sites = false,
    is_default = true, auto_decide_threshold = 0.70, updated_at = now()
WHERE name = 'Strict';

UPDATE policy_versions SET snapshot = jsonb_build_object(
  'name', p.name, 'strictness', p.strictness, 'cover_images', p.cover_images,
  'block_images', p.block_images, 'filter_videos', p.filter_videos,
  'filter_ads', p.filter_ads, 'require_approval_for_new_sites', p.require_approval_for_new_sites,
  'is_default', p.is_default, 'auto_decide_threshold', p.auto_decide_threshold)
FROM policies p WHERE policy_versions.policy_id = p.id AND p.is_default = true;

INSERT INTO blocked_words (word, category) VALUES
  ('porn', 'explicit'), ('pornhub', 'explicit'), ('xvideos', 'explicit'),
  ('xxx', 'explicit'), ('onlyfans', 'explicit'), ('sex', 'explicit'),
  ('nude', 'explicit'), ('escort', 'explicit')
ON CONFLICT (word) DO NOTHING;

UPDATE audit_logs SET details = '{"name": "Standard — block images + explicit words, rest open"}'::jsonb
WHERE action = 'policy.created' AND details = '{"name": "Strict"}'::jsonb;
