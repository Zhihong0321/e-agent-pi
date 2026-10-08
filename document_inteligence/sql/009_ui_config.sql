-- Per-company page layout: how a company has chosen to show one /demo page (starting with Expenses).
--
--   * The default layout lives in code (core/page-layout.mjs). A row here is only the company's
--     OVERRIDE: the few things it changed, never a copy of the default. No row = the default.
--   * "Restore default" soft-deletes the active row. Saving again inserts a fresh one, so every
--     earlier version stays as history (and in di.audit_log).
--   * rev counts saves of the active row, so two admins can't silently overwrite each other.
--   * Same safety as 001: RLS per tenant, no DELETE/TRUNCATE, audit trigger, di_app grants.

CREATE TABLE IF NOT EXISTS di.ui_config (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  page          text NOT NULL CHECK (page ~ '^[a-z][a-z0-9_]{0,47}$'),     -- 'expenses'
  config        jsonb NOT NULL DEFAULT '{}',   -- sparse override, validated by core/page-layout.mjs
  rev           integer NOT NULL DEFAULT 1,    -- +1 on every save of the active row
  default_rev   integer NOT NULL DEFAULT 1,    -- revision of the code default when this was saved
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text
);
CREATE UNIQUE INDEX IF NOT EXISTS di_ui_config_page_idx
  ON di.ui_config (tenant_id, page) WHERE deleted_at IS NULL;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['ui_config'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS di_no_delete ON di.%I', t);
    EXECUTE format('CREATE TRIGGER di_no_delete BEFORE DELETE ON di.%I FOR EACH ROW EXECUTE FUNCTION di.forbid_delete()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS di_no_truncate ON di.%I', t);
    EXECUTE format('CREATE TRIGGER di_no_truncate BEFORE TRUNCATE ON di.%I FOR EACH STATEMENT EXECUTE FUNCTION di.forbid_delete()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS di_touch ON di.%I', t);
    EXECUTE format('CREATE TRIGGER di_touch BEFORE UPDATE ON di.%I FOR EACH ROW EXECUTE FUNCTION di.touch()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS di_audit ON di.%I', t);
    EXECUTE format('CREATE TRIGGER di_audit AFTER INSERT OR UPDATE ON di.%I FOR EACH ROW EXECUTE FUNCTION di.audit()', t);
    EXECUTE format('ALTER TABLE di.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS di_tenant_isolation ON di.%I', t);
    EXECUTE format('CREATE POLICY di_tenant_isolation ON di.%I USING (tenant_id = di.current_tenant()) WITH CHECK (tenant_id = di.current_tenant())', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'di_app') THEN
    GRANT SELECT, INSERT, UPDATE ON di.ui_config TO di_app;
  END IF;
EXCEPTION WHEN insufficient_privilege OR invalid_grant_operation THEN
  RAISE NOTICE 'di_app grants for ui_config incomplete: %', SQLERRM;
END $$;
