-- Own tables: a company's own record types (a clinic's Patient and Appointment, a roofer's Site visit).
-- Additive only. The shape of each company's tables is data (di.entity_def, di.field_def); every row of every
-- own table lives in the one shared di.record, kept apart by `kind` and by row-level security, exactly like
-- every other tenant table. Agents never run DDL: this migration runs once, for all companies.

ALTER TABLE di.entity_def ADD COLUMN IF NOT EXISTS own boolean NOT NULL DEFAULT false;
ALTER TABLE di.field_def ADD COLUMN IF NOT EXISTS link_to text;

-- A field may now hold the id of a record in another table ('link'). The type check is declared inline in
-- 001_core.sql, so find its real name, drop it and add it back under the same name with 'link' included.
DO $$
DECLARE
  cname text;
BEGIN
  SELECT c.conname INTO cname
    FROM pg_constraint c
   WHERE c.conrelid = 'di.field_def'::regclass AND c.contype = 'c'
     AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'di.field_def'::regclass AND a.attname = 'type')];
  IF cname IS NOT NULL AND pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid = 'di.field_def'::regclass AND conname = cname)) LIKE '%link%' THEN
    RETURN;
  END IF;
  cname := coalesce(cname, 'field_def_type_check');
  EXECUTE format('ALTER TABLE di.field_def DROP CONSTRAINT IF EXISTS %I', cname);
  EXECUTE format('ALTER TABLE di.field_def ADD CONSTRAINT %I CHECK (type IN (''text'', ''number'', ''date'', ''boolean'', ''select'', ''link''))', cname);
END $$;

CREATE TABLE IF NOT EXISTS di.record (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  kind          text NOT NULL,          -- the own table: di.entity_def.entity where own
  title         text NOT NULL,
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text
);
CREATE INDEX IF NOT EXISTS di_record_kind_idx ON di.record (tenant_id, kind);

-- Same wiring as every tenant table (see 007_procurement.sql): no delete, no truncate, touch, audit, row-level security.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['record'];
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
    GRANT SELECT, INSERT, UPDATE ON di.record TO di_app;
  END IF;
EXCEPTION WHEN insufficient_privilege OR invalid_grant_operation THEN
  RAISE NOTICE 'di_app grants for own tables incomplete: %', SQLERRM;
END $$;
