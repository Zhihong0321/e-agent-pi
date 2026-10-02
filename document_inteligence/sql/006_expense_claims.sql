-- Expense claims: what employees spent, the receipts that prove it, and the monthly
-- submission (batch) the claims are grouped into by a company-chosen cut-off day.
--
--   * A claim is one expense with its receipts. Its number (EXP-yyyy-nnnn) is taken when it
--     is filed, in the same transaction, so numbers have no gaps. Withdrawing a claim sets a
--     status: nothing is ever deleted.
--   * A monthly submission (expense_batch) is open until an admin closes it. A closed batch
--     is frozen by trigger: its claims and receipts can no longer change, and only the
--     stored report link may be filled in afterwards.
--   * Receipts are evidence: insert-only, and a receipt can't be added to a closed batch.
--   * Same safety as 001: RLS per tenant, no DELETE/TRUNCATE, audit trigger, di_app grants.

CREATE TABLE IF NOT EXISTS di.expense_setting (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  cutoff_day    integer NOT NULL DEFAULT 10 CHECK (cutoff_day BETWEEN 1 AND 28),
  currency      text NOT NULL DEFAULT 'MYR',
  receipt_required boolean NOT NULL DEFAULT true,
  max_claim_age_days integer NOT NULL DEFAULT 90 CHECK (max_claim_age_days > 0),
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text,
  UNIQUE (tenant_id)
);

CREATE TABLE IF NOT EXISTS di.expense_batch (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  period_key    text NOT NULL CHECK (period_key ~ '^[0-9]{4}-[0-9]{2}$'),   -- month of the cut-off date
  period_start  date NOT NULL,        -- first filing day this submission covers
  cutoff_date   date NOT NULL,        -- last filing day this submission covers
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at     timestamptz,
  closed_by     text,
  claim_count   integer,              -- totals frozen at close
  total_claimed numeric(14,2),
  total_approved numeric(14,2),
  report_path   text,                 -- /files/<id>/<name> of the final report
  notes         text,
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text
);
CREATE UNIQUE INDEX IF NOT EXISTS di_expense_batch_period_idx
  ON di.expense_batch (tenant_id, period_key) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS di.expense_claim (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  number        text NOT NULL,                       -- EXP-2026-0001, assigned at filing
  batch_id      uuid REFERENCES di.expense_batch(id),
  claimant_user_id   text,                           -- host users.id when the claimant has a login
  claimant_member_id uuid REFERENCES di.company_member(id),
  claimant_name  text NOT NULL,                      -- snapshot: stays right if the person is renamed
  claimant_email text,
  expense_date  date NOT NULL,
  merchant      text NOT NULL,
  category      text NOT NULL,
  description   text,
  currency      text NOT NULL DEFAULT 'MYR',
  amount        numeric(12,2) NOT NULL CHECK (amount > 0),
  tax_amount    numeric(12,2) CHECK (tax_amount IS NULL OR tax_amount >= 0),
  payment_method text CHECK (payment_method IS NULL OR payment_method IN
                  ('cash', 'personal_card', 'company_card', 'bank_transfer', 'e_wallet', 'other')),
  status        text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected', 'withdrawn')),
  no_receipt_reason text,
  submitted_at  timestamptz NOT NULL DEFAULT now(),  -- the filing time; decides the monthly submission
  reviewed_by   text,
  reviewed_at   timestamptz,
  review_note   text,
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text,
  UNIQUE (tenant_id, number)
);
CREATE INDEX IF NOT EXISTS di_expense_claim_batch_idx ON di.expense_claim (tenant_id, batch_id, status);
CREATE INDEX IF NOT EXISTS di_expense_claim_user_idx ON di.expense_claim (tenant_id, claimant_user_id);
CREATE INDEX IF NOT EXISTS di_expense_claim_dupe_idx ON di.expense_claim (tenant_id, lower(claimant_name), expense_date, amount);

CREATE TABLE IF NOT EXISTS di.expense_receipt (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  claim_id      uuid NOT NULL REFERENCES di.expense_claim(id),
  file_path     text NOT NULL,                       -- /files/<id>/<name> in shared storage
  name          text NOT NULL,
  mime          text NOT NULL,
  bytes         integer NOT NULL,
  sha256        text NOT NULL,
  extracted     jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text
);
CREATE INDEX IF NOT EXISTS di_expense_receipt_claim_idx ON di.expense_receipt (tenant_id, claim_id);
CREATE INDEX IF NOT EXISTS di_expense_receipt_sha_idx ON di.expense_receipt (tenant_id, sha256);

-- ---------------------------------------------------------------- guards

-- Once a monthly submission is closed, only the stored report link may be filled in.
CREATE OR REPLACE FUNCTION di.guard_expense_batch() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  movable text[] := ARRAY['report_path', 'updated_at', 'updated_by'];
BEGIN
  IF OLD.status = 'closed' AND (to_jsonb(NEW) - movable) IS DISTINCT FROM (to_jsonb(OLD) - movable) THEN
    RAISE EXCEPTION 'Monthly submission % is closed and frozen.', OLD.period_key
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- A claim in a closed submission is frozen, nothing can be filed into one, and the
-- number and filing time never change.
CREATE OR REPLACE FUNCTION di.guard_expense_claim() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_status text;
  current_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.batch_id IS NOT NULL THEN
      SELECT status INTO current_status FROM di.expense_batch WHERE id = OLD.batch_id;
      IF current_status = 'closed' THEN
        RAISE EXCEPTION 'Claim % is in a closed monthly submission and cannot change.', OLD.number
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW.number IS DISTINCT FROM OLD.number OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
      RAISE EXCEPTION 'A claim number and filing time never change.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.batch_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.batch_id IS DISTINCT FROM OLD.batch_id) THEN
    SELECT status INTO target_status FROM di.expense_batch WHERE id = NEW.batch_id;
    IF target_status = 'closed' THEN
      RAISE EXCEPTION 'That monthly submission is closed; claims can no longer be added to it.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Receipts are evidence: insert-only (soft delete aside), never into a closed submission.
CREATE OR REPLACE FUNCTION di.guard_expense_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  movable text[] := ARRAY['deleted_at', 'deleted_by', 'updated_at', 'updated_by'];
  batch_state text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT b.status INTO batch_state
      FROM di.expense_claim c JOIN di.expense_batch b ON b.id = c.batch_id WHERE c.id = NEW.claim_id;
    IF batch_state = 'closed' THEN
      RAISE EXCEPTION 'That monthly submission is closed; receipts can no longer be added.'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF (to_jsonb(NEW) - movable) IS DISTINCT FROM (to_jsonb(OLD) - movable) THEN
    RAISE EXCEPTION 'A stored receipt cannot be edited.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- wire triggers, RLS

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['expense_setting', 'expense_batch', 'expense_claim', 'expense_receipt'];
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
DROP TRIGGER IF EXISTS di_guard ON di.expense_batch;
CREATE TRIGGER di_guard BEFORE UPDATE ON di.expense_batch FOR EACH ROW EXECUTE FUNCTION di.guard_expense_batch();
DROP TRIGGER IF EXISTS di_guard ON di.expense_claim;
CREATE TRIGGER di_guard BEFORE INSERT OR UPDATE ON di.expense_claim FOR EACH ROW EXECUTE FUNCTION di.guard_expense_claim();
DROP TRIGGER IF EXISTS di_guard ON di.expense_receipt;
CREATE TRIGGER di_guard BEFORE INSERT OR UPDATE ON di.expense_receipt FOR EACH ROW EXECUTE FUNCTION di.guard_expense_receipt();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'di_app') THEN
    GRANT SELECT, INSERT, UPDATE ON di.expense_setting, di.expense_batch, di.expense_claim, di.expense_receipt TO di_app;
    GRANT EXECUTE ON FUNCTION di.guard_expense_batch(), di.guard_expense_claim(), di.guard_expense_receipt() TO di_app;
  END IF;
EXCEPTION WHEN insufficient_privilege OR invalid_grant_operation THEN
  RAISE NOTICE 'di_app grants for expense claims incomplete: %', SQLERRM;
END $$;
