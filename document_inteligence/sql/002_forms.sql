-- Forms: company-defined forms (application, job report, survey, order form) and the
-- submissions the public sends to them.
--
-- A new form is rows, never a new table: agents describe fields as JSON in
-- form_version.schema, and every submission lands in form_submission.data (jsonb).
--   * A published form_version is frozen by trigger: editing means a new version, so
--     every submission can always be read against the exact form it was filled in on.
--   * A submission's answers are frozen from the moment they arrive; only its review
--     status and links to customers/documents may change.
--   * Same safety as 001: RLS per tenant, no DELETE/TRUNCATE, audit trigger, di_app grants.

CREATE TABLE IF NOT EXISTS di.form (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  slug          text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,47}$'),
  title         text NOT NULL,
  purpose       text,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed')),
  published_version integer,       -- the version the public link serves
  published_at  timestamptz,
  closed_at     timestamptz,
  close_reason  text,
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text,
  UNIQUE (tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS di.form_version (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  form_id       uuid NOT NULL REFERENCES di.form(id),
  version       integer NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  schema        jsonb NOT NULL DEFAULT '{"fields": []}',   -- { fields: [{ key, type, label, ... }] }
  settings      jsonb NOT NULL DEFAULT '{}',               -- consent_text, closes_at, max_submissions, ...
  published_at  timestamptz,
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text,
  UNIQUE (form_id, version)
);

CREATE TABLE IF NOT EXISTS di.form_submission (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  form_id       uuid NOT NULL REFERENCES di.form(id),
  form_version_id uuid NOT NULL REFERENCES di.form_version(id),
  version       integer NOT NULL,
  data          jsonb NOT NULL DEFAULT '{}',   -- validated, normalised answers keyed by field key
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'processed', 'spam')),
  review_note   text,
  linked_customer_id uuid REFERENCES di.customer(id),
  linked_document_id uuid REFERENCES di.document(id),
  processed_at  timestamptz,
  submitter_hash text,                         -- salted hash of the IP, for rate limits; never the IP
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text
);

CREATE INDEX IF NOT EXISTS di_form_version_form_idx ON di.form_version (form_id, version);
CREATE INDEX IF NOT EXISTS di_form_submission_form_idx ON di.form_submission (tenant_id, form_id, submitted_at);
CREATE INDEX IF NOT EXISTS di_form_submission_data_idx ON di.form_submission USING gin (data);
CREATE INDEX IF NOT EXISTS di_attachment_entity_idx ON di.attachment (entity, entity_id);

-- ---------------------------------------------------------------- guards

-- A published or retired version never changes shape; only draft -> published -> retired.
CREATE OR REPLACE FUNCTION di.guard_form_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  movable text[] := ARRAY['status', 'published_at', 'updated_at', 'updated_by'];
BEGIN
  IF OLD.status <> 'draft' THEN
    IF (to_jsonb(NEW) - movable) IS DISTINCT FROM (to_jsonb(OLD) - movable) THEN
      RAISE EXCEPTION 'Form version % is % and frozen; start a new version instead of editing it.', OLD.version, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'draft' OR (OLD.status = 'retired' AND NEW.status <> 'retired') THEN
      RAISE EXCEPTION 'Form version % cannot go from % back to %.', OLD.version, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- What a person submitted is evidence: the answers and their form version never change.
CREATE OR REPLACE FUNCTION di.guard_form_submission() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  movable text[] := ARRAY['status', 'review_note', 'linked_customer_id', 'linked_document_id', 'processed_at',
    'deleted_at', 'deleted_by', 'updated_at', 'updated_by'];
BEGIN
  IF (to_jsonb(NEW) - movable) IS DISTINCT FROM (to_jsonb(OLD) - movable) THEN
    RAISE EXCEPTION 'Submitted answers are frozen; only the review status and links can change.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- wire triggers, RLS

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['form', 'form_version', 'form_submission'];
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

-- Alphabetical trigger order: di_guard runs before di_touch.
DROP TRIGGER IF EXISTS di_guard ON di.form_version;
CREATE TRIGGER di_guard BEFORE UPDATE ON di.form_version FOR EACH ROW EXECUTE FUNCTION di.guard_form_version();
DROP TRIGGER IF EXISTS di_guard ON di.form_submission;
CREATE TRIGGER di_guard BEFORE UPDATE ON di.form_submission FOR EACH ROW EXECUTE FUNCTION di.guard_form_submission();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'di_app') THEN
    GRANT SELECT, INSERT, UPDATE ON di.form, di.form_version, di.form_submission TO di_app;
    GRANT EXECUTE ON FUNCTION di.guard_form_version(), di.guard_form_submission() TO di_app;
  END IF;
EXCEPTION WHEN insufficient_privilege OR invalid_grant_operation THEN
  RAISE NOTICE 'di_app grants for forms incomplete: %', SQLERRM;
END $$;
