-- Link internal company people to the host user identity when login access is enabled.
-- The reference is intentionally nullable and textual: the host users table is
-- created outside the DI migration/PGlite test lifecycle.
ALTER TABLE di.company_member ADD COLUMN IF NOT EXISTS user_id text;
CREATE UNIQUE INDEX IF NOT EXISTS di_company_member_user_active_idx
  ON di.company_member (tenant_id, user_id)
  WHERE user_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS di_company_member_user_id_idx ON di.company_member (user_id);
