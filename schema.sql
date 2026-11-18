-- Filter Platform — Phase 1 (Core Platform) schema
-- Neon project: Filter Platform (wandering-brook-58542930), DB filter, PG 17
-- Tables from brief section 16. Phase 1 only: no browser/image/video AI,
-- no approval engine, no device apps. ai_analysis_results exists as an
-- empty Phase 4 placeholder table.

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'admin', 'support', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  strictness INT NOT NULL DEFAULT 2 CHECK (strictness BETWEEN 1 AND 3),
  cover_images BOOLEAN NOT NULL DEFAULT true,
  block_images BOOLEAN NOT NULL DEFAULT false,
  filter_videos BOOLEAN NOT NULL DEFAULT true,
  filter_ads BOOLEAN NOT NULL DEFAULT true,
  require_approval_for_new_sites BOOLEAN NOT NULL DEFAULT true,
  is_default BOOLEAN NOT NULL DEFAULT false,
  auto_decide_threshold NUMERIC(5,4) NOT NULL DEFAULT 0.70,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Explicit-words blocklist (text filtering). One global list for Phase 1;
-- per-policy word lists are a later phase. Words are matched against page
-- text by the browser/device filter (Phase 2+); the API only stores them.
CREATE TABLE blocked_words (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  word TEXT NOT NULL UNIQUE,
  category TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'request', 'ai', 'import')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_blocked_words_word ON blocked_words (word);

CREATE TABLE policy_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id UUID NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  version INT NOT NULL,
  snapshot JSONB NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (policy_id, version)
);

CREATE TABLE devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'windows', 'macos', 'other')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'inactive')),
  activation_code TEXT UNIQUE,
  policy_id UUID REFERENCES policies(id),
  activated_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'block')),
  category TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'request', 'ai', 'import')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX domains_global_unique ON domains (domain) WHERE customer_id IS NULL;
CREATE UNIQUE INDEX domains_customer_unique ON domains (customer_id, domain) WHERE customer_id IS NOT NULL;

CREATE TABLE applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL,
  name TEXT,
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'block')),
  category TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'request', 'ai', 'import')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX applications_global_unique ON applications (package_id) WHERE customer_id IS NULL;
CREATE UNIQUE INDEX applications_customer_unique ON applications (customer_id, package_id) WHERE customer_id IS NOT NULL;

CREATE TABLE approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('website', 'app')),
  target TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'review')),
  decided_by UUID REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  -- Automated decision (Phase 4 AI Approval Engine). The free AI auto-decides
  -- EVERY request; only low-confidence cases land in the 'review' bucket.
  -- Uncertain stays BLOCKED until decided. No flow depends on a human
  -- reviewing each request.
  ai_verdict TEXT CHECK (ai_verdict IN ('approve', 'reject')),
  ai_confidence NUMERIC(5,4) CHECK (ai_confidence BETWEEN 0 AND 1),
  ai_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  auto_decided_at TIMESTAMPTZ,
  review_reason TEXT,
  ai_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_analysis_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type TEXT NOT NULL,
  target TEXT NOT NULL,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'customer', 'system')),
  actor_id UUID,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE device_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('online', 'offline', 'unknown')),
  filter_active BOOLEAN NOT NULL DEFAULT true,
  policy_version INT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_devices_customer ON devices (customer_id);
CREATE INDEX idx_domains_domain ON domains (domain);
CREATE INDEX idx_applications_package ON applications (package_id);
CREATE INDEX idx_requests_customer ON approval_requests (customer_id);
CREATE INDEX idx_requests_status ON approval_requests (status);
CREATE INDEX idx_audit_created ON audit_logs (created_at);
CREATE INDEX idx_device_status_device ON device_status (device_id);
