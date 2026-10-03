-- Audit rows are append-only even if a privileged application connection is used.
ALTER TABLE di.audit_log ADD COLUMN IF NOT EXISTS actor_user_id text;
CREATE OR REPLACE FUNCTION di.forbid_audit_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Database audit history cannot be edited.' USING ERRCODE = 'insufficient_privilege';
END $$;
DROP TRIGGER IF EXISTS di_no_update ON di.audit_log;
CREATE TRIGGER di_no_update BEFORE UPDATE ON di.audit_log
FOR EACH ROW EXECUTE FUNCTION di.forbid_audit_update();
CREATE OR REPLACE FUNCTION di.guard_audit_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'di_app' AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Database audit entries must come from record triggers.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.actor_user_id := nullif(current_setting('di.actor_user_id', true), '');
  RETURN NEW;
END $$;
CREATE TRIGGER di_guard_insert BEFORE INSERT ON di.audit_log
FOR EACH ROW EXECUTE FUNCTION di.guard_audit_insert();
CREATE INDEX IF NOT EXISTS di_audit_tenant_history_idx ON di.audit_log (tenant_id, id DESC);
