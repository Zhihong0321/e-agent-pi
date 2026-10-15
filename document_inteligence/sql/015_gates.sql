-- Logical gates: a company's ordered yes/no rules about a record and who is asking (core/gates.mjs).
--
--   * One row per company and record type; `rules` is the whole ordered list (JSONLogic conditions).
--     Setting gates replaces the list. No row = no gates.
--   * History is di.audit_log. Same safety as 001: RLS per tenant, no DELETE/TRUNCATE, audit trigger,
--     di_app grants.

CREATE TABLE IF NOT EXISTS di.gate (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  record_type   text NOT NULL CHECK (record_type IN ('document')),
  rules         jsonb NOT NULL DEFAULT '[]',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text
);
CREATE UNIQUE INDEX IF NOT EXISTS di_gate_record_type_idx
  ON di.gate (tenant_id, record_type) WHERE deleted_at IS NULL;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['gate'];
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
    GRANT SELECT, INSERT, UPDATE ON di.gate TO di_app;
  END IF;
EXCEPTION WHEN insufficient_privilege OR invalid_grant_operation THEN
  RAISE NOTICE 'di_app grants for gate incomplete: %', SQLERRM;
END $$;
