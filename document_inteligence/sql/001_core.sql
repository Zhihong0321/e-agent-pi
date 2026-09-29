-- Document Intelligence core schema.
--
-- Safety is enforced here, not in agent prompts:
--   * Agents run as role di_app (SET LOCAL ROLE per transaction). di_app has no
--     DELETE/TRUNCATE grant and cannot create objects, and a trigger refuses DELETE
--     for everyone else too. Removal is always soft: deleted_at / deleted_by.
--   * Row-level security scopes every table to current_setting('di.tenant_id').
--   * Issued documents are frozen by trigger; only status/payment/void/pdf fields move.
--   * Every insert/update is written to audit_log by trigger, with the acting agent.

CREATE SCHEMA IF NOT EXISTS di;

-- ---------------------------------------------------------------- helpers

CREATE OR REPLACE FUNCTION di.current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('di.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION di.current_actor() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('di.actor', true), ''), current_user::text) $$;

CREATE OR REPLACE FUNCTION di.forbid_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Hard delete is disabled on di.%. Set deleted_at instead (soft delete).', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE OR REPLACE FUNCTION di.touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := di.current_actor();
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND NEW.deleted_by IS NULL THEN
    NEW.deleted_by := di.current_actor();
  END IF;
  -- di.tenant.tenant_id is generated (not yet computed in BEFORE triggers); skip it.
  IF TG_TABLE_NAME <> 'tenant' AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'tenant_id cannot change';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- tenancy

CREATE TABLE IF NOT EXISTS di.tenant (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid GENERATED ALWAYS AS (id) STORED,
  name          text NOT NULL,
  legal_name    text,
  reg_no        text,             -- SSM / BRN
  tin           text,             -- LHDN tax identification no. (MyInvois)
  sst_no        text,
  msic_code     text,             -- MyInvois industry classification
  business_activity text,
  address       jsonb NOT NULL DEFAULT '{}',
  phone         text,
  email         text,
  website       text,
  currency      text NOT NULL DEFAULT 'MYR',
  logo_url      text,
  bank_details  text,
  is_default    boolean NOT NULL DEFAULT false,
  settings      jsonb NOT NULL DEFAULT '{}',
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text
);

-- ---------------------------------------------------------------- CRM

CREATE TABLE IF NOT EXISTS di.customer (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  code          text NOT NULL,
  kind          text NOT NULL DEFAULT 'company' CHECK (kind IN ('company', 'individual')),
  name          text NOT NULL,
  legal_name    text,
  reg_no        text,
  id_type       text CHECK (id_type IN ('BRN', 'NRIC', 'PASSPORT', 'ARMY')),
  tin           text,
  sst_no        text,
  industry      text,
  email         text,
  phone         text,
  website       text,
  billing_address  jsonb NOT NULL DEFAULT '{}',
  shipping_address jsonb NOT NULL DEFAULT '{}',
  payment_terms_days integer,
  source        text NOT NULL DEFAULT 'manual',
  notes         text,
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text,
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS di.contact (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  customer_id   uuid NOT NULL REFERENCES di.customer(id),
  name          text NOT NULL,
  job_title     text,
  email         text,
  phone         text,
  mobile        text,
  is_primary    boolean NOT NULL DEFAULT false,
  notes         text,
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text
);

CREATE TABLE IF NOT EXISTS di.attachment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  entity        text NOT NULL,
  entity_id     uuid NOT NULL,
  kind          text NOT NULL,     -- name_card | document_pdf | other
  file_path     text,
  mime          text,
  extracted     jsonb NOT NULL DEFAULT '{}',
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text
);

-- ---------------------------------------------------------------- catalogue

CREATE TABLE IF NOT EXISTS di.tax_code (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  code          text NOT NULL,
  name          text NOT NULL,
  rate          numeric(6,3) NOT NULL DEFAULT 0,
  kind          text NOT NULL DEFAULT 'none',   -- sst_service | sst_sales | exempt | none
  is_default    boolean NOT NULL DEFAULT false,
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text,
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS di.product (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  sku           text NOT NULL,
  name          text NOT NULL,
  description   text,
  category      text,
  unit          text NOT NULL DEFAULT 'unit',
  unit_price    numeric(14,2) NOT NULL DEFAULT 0,
  tax_code      text,
  is_active     boolean NOT NULL DEFAULT true,
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text,
  UNIQUE (tenant_id, sku)
);

CREATE TABLE IF NOT EXISTS di.package (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  code          text NOT NULL,
  name          text NOT NULL,
  description   text,
  price         numeric(14,2),     -- NULL = sum of item prices
  tax_code      text,
  is_active     boolean NOT NULL DEFAULT true,
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text,
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS di.package_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  package_id    uuid NOT NULL REFERENCES di.package(id),
  product_id    uuid NOT NULL REFERENCES di.product(id),
  quantity      numeric(12,3) NOT NULL DEFAULT 1,
  sort          integer NOT NULL DEFAULT 0,
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text
);

-- ---------------------------------------------------------------- documents

CREATE TABLE IF NOT EXISTS di.document_sequence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  key           text NOT NULL,      -- quotation | invoice | credit_note | receipt | customer
  prefix        text NOT NULL,
  padding       integer NOT NULL DEFAULT 4,
  next_number   integer NOT NULL DEFAULT 1,
  yearly_reset  boolean NOT NULL DEFAULT true,
  current_year  integer,
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text,
  UNIQUE (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS di.template (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  doc_type      text NOT NULL,
  name          text NOT NULL,
  version       integer NOT NULL DEFAULT 1,
  html          text NOT NULL,
  is_default    boolean NOT NULL DEFAULT false,
  notes         text,
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text
);

CREATE TABLE IF NOT EXISTS di.document (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  doc_type      text NOT NULL CHECK (doc_type IN ('quotation', 'invoice', 'credit_note')),
  number        text,              -- assigned at issue, gap-free per tenant+type
  status        text NOT NULL DEFAULT 'draft',
  customer_id   uuid REFERENCES di.customer(id),
  contact_id    uuid REFERENCES di.contact(id),
  customer_snapshot jsonb,         -- frozen bill-to at issue
  issuer_snapshot   jsonb,         -- frozen company header at issue
  issue_date    date,
  valid_until   date,
  due_date      date,
  currency      text NOT NULL DEFAULT 'MYR',
  subtotal      numeric(14,2) NOT NULL DEFAULT 0,
  discount_total numeric(14,2) NOT NULL DEFAULT 0,
  tax_total     numeric(14,2) NOT NULL DEFAULT 0,
  total         numeric(14,2) NOT NULL DEFAULT 0,
  amount_paid   numeric(14,2) NOT NULL DEFAULT 0,
  reference     text,
  notes         text,
  terms         text,
  template_id   uuid REFERENCES di.template(id),
  source_document_id uuid REFERENCES di.document(id),
  issued_at     timestamptz,
  voided_at     timestamptz,
  void_reason   text,
  pdf_path      text,
  einvoice_uuid text,
  einvoice_status text,
  einvoice_qr_url text,
  einvoice_validated_at timestamptz,
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text,
  UNIQUE (tenant_id, doc_type, number)
);

CREATE TABLE IF NOT EXISTS di.document_line (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  document_id   uuid NOT NULL REFERENCES di.document(id),
  sort          integer NOT NULL DEFAULT 0,
  kind          text NOT NULL DEFAULT 'custom' CHECK (kind IN ('product', 'package', 'custom')),
  product_id    uuid REFERENCES di.product(id),
  package_id    uuid REFERENCES di.package(id),
  description   text NOT NULL,
  quantity      numeric(12,3) NOT NULL DEFAULT 1,
  unit          text,
  unit_price    numeric(14,2) NOT NULL DEFAULT 0,
  discount_amount numeric(14,2) NOT NULL DEFAULT 0,
  tax_code      text,
  tax_rate      numeric(6,3) NOT NULL DEFAULT 0,
  subtotal      numeric(14,2) NOT NULL DEFAULT 0,
  tax_amount    numeric(14,2) NOT NULL DEFAULT 0,
  total         numeric(14,2) NOT NULL DEFAULT 0,
  meta          jsonb NOT NULL DEFAULT '{}',
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text
);

-- ---------------------------------------------------------------- money

CREATE TABLE IF NOT EXISTS di.payment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  number        text NOT NULL,
  customer_id   uuid REFERENCES di.customer(id),
  received_on   date NOT NULL,
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),
  method        text NOT NULL DEFAULT 'bank_transfer',
  reference     text,
  status        text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'void')),
  notes         text,
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text,
  UNIQUE (tenant_id, number)
);

CREATE TABLE IF NOT EXISTS di.payment_allocation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  payment_id    uuid NOT NULL REFERENCES di.payment(id),
  document_id   uuid NOT NULL REFERENCES di.document(id),
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text
);

-- ---------------------------------------------------------------- meta (the "intelligence" layer)

CREATE TABLE IF NOT EXISTS di.entity_def (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  entity        text NOT NULL,
  label         text NOT NULL,
  description   text NOT NULL,
  match_keys    jsonb NOT NULL DEFAULT '[]',
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text,
  UNIQUE (tenant_id, entity)
);

CREATE TABLE IF NOT EXISTS di.field_def (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  entity        text NOT NULL,     -- customer | contact | product | package | document | payment
  key           text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,47}$'),
  label         text NOT NULL,
  type          text NOT NULL CHECK (type IN ('text', 'number', 'date', 'boolean', 'select')),
  options       jsonb NOT NULL DEFAULT '[]',
  required_for  text,              -- e.g. 'invoice.issue', 'quotation.issue', 'save'
  help          text,
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text,
  UNIQUE (tenant_id, entity, key)
);

CREATE TABLE IF NOT EXISTS di.workflow_def (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  doc_type      text NOT NULL,
  transition    text NOT NULL,     -- issue
  rules         jsonb NOT NULL DEFAULT '[]',
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text,
  UNIQUE (tenant_id, doc_type, transition)
);

CREATE TABLE IF NOT EXISTS di.audit_log (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid,
  at            timestamptz NOT NULL DEFAULT now(),
  actor         text,
  agent         text,
  action        text NOT NULL,
  entity        text NOT NULL,
  entity_id     uuid,
  before        jsonb,
  after         jsonb
);

CREATE INDEX IF NOT EXISTS di_customer_name_idx ON di.customer (tenant_id, lower(name));
CREATE INDEX IF NOT EXISTS di_contact_customer_idx ON di.contact (customer_id);
CREATE INDEX IF NOT EXISTS di_document_customer_idx ON di.document (tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS di_document_line_doc_idx ON di.document_line (document_id);
CREATE INDEX IF NOT EXISTS di_audit_entity_idx ON di.audit_log (tenant_id, entity, entity_id);

-- ---------------------------------------------------------------- document guards

-- Once a document leaves draft, only lifecycle fields may change.
CREATE OR REPLACE FUNCTION di.guard_document() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  movable text[] := ARRAY['status', 'amount_paid', 'voided_at', 'void_reason', 'pdf_path',
    'einvoice_uuid', 'einvoice_status', 'einvoice_qr_url', 'einvoice_validated_at',
    'updated_at', 'updated_by'];
BEGIN
  IF OLD.status <> 'draft' THEN
    IF (to_jsonb(NEW) - movable) IS DISTINCT FROM (to_jsonb(OLD) - movable) THEN
      RAISE EXCEPTION 'Document % is % and frozen; void it or issue a new one instead of editing.',
        coalesce(OLD.number, OLD.id::text), OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION di.guard_document_line() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status FROM di.document WHERE id = NEW.document_id;
  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Lines can only change while the document is a draft (it is %).', parent_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- audit

CREATE OR REPLACE FUNCTION di.audit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  act text;
BEGIN
  act := CASE
    WHEN TG_OP = 'INSERT' THEN 'insert'
    WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN 'soft_delete'
    WHEN NEW.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL THEN 'restore'
    ELSE 'update' END;
  INSERT INTO di.audit_log (tenant_id, actor, agent, action, entity, entity_id, before, after)
  VALUES (
    NEW.tenant_id,
    di.current_actor(),
    nullif(current_setting('di.agent', true), ''),
    act,
    TG_TABLE_NAME,
    NEW.id,
    CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END,
    to_jsonb(NEW)
  );
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- wire triggers, RLS

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['tenant', 'customer', 'contact', 'attachment', 'tax_code', 'product', 'package',
    'package_item', 'document_sequence', 'template', 'document', 'document_line', 'payment',
    'payment_allocation', 'entity_def', 'field_def', 'workflow_def'];
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

-- The trigger order is alphabetical: di_guard runs before di_touch.
DROP TRIGGER IF EXISTS di_guard ON di.document;
CREATE TRIGGER di_guard BEFORE UPDATE ON di.document FOR EACH ROW EXECUTE FUNCTION di.guard_document();
DROP TRIGGER IF EXISTS di_guard ON di.document_line;
CREATE TRIGGER di_guard BEFORE INSERT OR UPDATE ON di.document_line FOR EACH ROW EXECUTE FUNCTION di.guard_document_line();

ALTER TABLE di.audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS di_tenant_isolation ON di.audit_log;
CREATE POLICY di_tenant_isolation ON di.audit_log USING (tenant_id = di.current_tenant()) WITH CHECK (tenant_id = di.current_tenant());
DROP TRIGGER IF EXISTS di_no_delete ON di.audit_log;
CREATE TRIGGER di_no_delete BEFORE DELETE ON di.audit_log FOR EACH ROW EXECUTE FUNCTION di.forbid_delete();
DROP TRIGGER IF EXISTS di_no_truncate ON di.audit_log;
CREATE TRIGGER di_no_truncate BEFORE TRUNCATE ON di.audit_log FOR EACH STATEMENT EXECUTE FUNCTION di.forbid_delete();

-- ---------------------------------------------------------------- the agent role

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'di_app') THEN
    CREATE ROLE di_app NOLOGIN;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'di_app role could not be created; agents will run without role separation';
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'di_app') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA di FROM di_app;
    GRANT USAGE ON SCHEMA di TO di_app;
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA di TO di_app;
    REVOKE UPDATE ON di.audit_log FROM di_app;
    REVOKE INSERT ON di.tenant FROM di_app;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA di TO di_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA di TO di_app;
    -- Lets a non-superuser owner SET ROLE di_app; a no-op for superusers.
    EXECUTE format('GRANT di_app TO %I', current_user);
  END IF;
EXCEPTION WHEN insufficient_privilege OR invalid_grant_operation THEN
  RAISE NOTICE 'di_app grants incomplete: %', SQLERRM;
END $$;
