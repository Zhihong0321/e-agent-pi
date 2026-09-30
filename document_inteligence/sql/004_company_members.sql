-- Internal company people are separate from customer contacts.
CREATE TABLE di.company_member (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  name text NOT NULL,
  position text,
  department text,
  email text,
  phone text,
  location text,
  notes text,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text DEFAULT di.current_actor(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  deleted_at timestamptz,
  deleted_by text
);

CREATE UNIQUE INDEX di_company_member_email_active_idx
  ON di.company_member (tenant_id, lower(email))
  WHERE email IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX di_company_member_department_idx
  ON di.company_member (tenant_id, department) WHERE deleted_at IS NULL;

ALTER TABLE di.company_member ENABLE ROW LEVEL SECURITY;
CREATE POLICY di_tenant_isolation ON di.company_member
  USING (tenant_id=di.current_tenant()) WITH CHECK (tenant_id=di.current_tenant());
CREATE TRIGGER di_touch BEFORE UPDATE ON di.company_member FOR EACH ROW EXECUTE FUNCTION di.touch();
CREATE TRIGGER di_audit AFTER INSERT OR UPDATE ON di.company_member FOR EACH ROW EXECUTE FUNCTION di.audit();
CREATE TRIGGER di_no_delete BEFORE DELETE ON di.company_member FOR EACH ROW EXECUTE FUNCTION di.forbid_delete();
CREATE TRIGGER di_no_truncate BEFORE TRUNCATE ON di.company_member FOR EACH STATEMENT EXECUTE FUNCTION di.forbid_delete();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='di_app') THEN
    GRANT SELECT,INSERT,UPDATE ON di.company_member TO di_app;
  END IF;
END $$;
