-- Filter Platform — Review decisions (migration 004)
-- review_decisions: one recorded decision per image_key (upsert — latest
-- decision wins). Written by the RF-DETR review engine (web browser shim
-- and Android) when a human picture is reviewed: the decision the AI made
-- (allow / allow_painted / block / uncertain), the model + score, the
-- detection boxes, and the human_image_mode ('paint' | 'block') in force.
-- image_key is 'b:<sha256hex>' when reviewed from fetched bytes, or
-- 'u:<sha256hex>' of the canonical URL otherwise.
-- policies.human_image_mode: lets the default policy carry the paint/block
-- mode for managed devices later; the web demo + app read their local
-- setting first.

CREATE TABLE IF NOT EXISTS review_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image_key TEXT NOT NULL UNIQUE,
  image_url TEXT,
  page_url TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'allow_painted', 'block', 'uncertain')),
  model TEXT,
  best_score NUMERIC(5,4),
  boxes JSONB NOT NULL DEFAULT '[]'::jsonb,
  human_image_mode TEXT NOT NULL DEFAULT 'paint' CHECK (human_image_mode IN ('paint', 'block')),
  first_detector JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_review_decisions_key ON review_decisions (image_key);

CREATE INDEX IF NOT EXISTS idx_review_decisions_created ON review_decisions (created_at DESC);

ALTER TABLE policies ADD COLUMN IF NOT EXISTS human_image_mode TEXT NOT NULL DEFAULT 'paint' CHECK (human_image_mode IN ('paint', 'block'));
