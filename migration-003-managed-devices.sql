-- Filter Platform — Managed devices (migration 003)
-- 1. devices.managed_by_customer_id: the manager (parent/admin) who manages
--    this device. Nullable; NULL means unmanaged.
-- 2. managed_invites: 6-digit invite codes a manager issues; the managed
--    person redeems one via POST /api/v1/devices/managed-register (consent
--    step). An invite is single-use (status pending -> used).

ALTER TABLE devices ADD COLUMN IF NOT EXISTS managed_by_customer_id UUID REFERENCES customers(id);

CREATE TABLE IF NOT EXISTS managed_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  device_name TEXT,
  policy_id UUID REFERENCES policies(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'used')),
  used_device_id UUID REFERENCES devices(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_devices_managed_by ON devices (managed_by_customer_id);

CREATE INDEX IF NOT EXISTS idx_invites_code ON managed_invites (code);
