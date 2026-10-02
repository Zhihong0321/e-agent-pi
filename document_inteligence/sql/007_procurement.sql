-- Procurement: the buying side. Suppliers, the quotations and invoices they send us (kept as
-- evidence), our own purchase orders, and the goods that arrive against them.
--
--   * A purchase order is a draft until an admin issues it. Issuing takes the next gap-free
--     number (PO-yyyy-nnnn) in the same transaction and freezes the order: after that only
--     its status, the quantities received and the stored PDF move. Cancelling is a status.
--   * What a supplier sent us (supplier_document) is evidence: the content never changes, only
--     its status, its link to a PO and its payment fields. A mistake is voided and re-recorded.
--   * A goods receipt is insert-only, and a PO line can never be received beyond what was ordered.
--   * Same safety as 001: RLS per tenant, no DELETE/TRUNCATE, audit trigger, di_app grants.

CREATE TABLE IF NOT EXISTS di.supplier (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  code          text NOT NULL,                               -- S-0001
  name          text NOT NULL,
  reg_no        text,
  tin           text,
  sst_no        text,
  contact_name  text,
  email         text,
  phone         text,
  address       jsonb NOT NULL DEFAULT '{}',
  payment_terms_days integer CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 3650),
  bank_details  text,
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
CREATE INDEX IF NOT EXISTS di_supplier_name_idx ON di.supplier (tenant_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS di.purchase_order (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  number        text,                                        -- PO-2026-0001, assigned at issue
  supplier_id   uuid NOT NULL REFERENCES di.supplier(id),
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'issued', 'partially_received', 'received', 'cancelled')),
  order_date    date NOT NULL DEFAULT current_date,
  expected_date date,
  ship_to       text,
  payment_terms_days integer CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 3650),
  currency      text NOT NULL DEFAULT 'MYR',
  subtotal      numeric(14,2) NOT NULL DEFAULT 0,
  tax_total     numeric(14,2) NOT NULL DEFAULT 0,
  total         numeric(14,2) NOT NULL DEFAULT 0,
  notes         text,
  issued_at     timestamptz,
  issued_by     text,
  cancelled_at  timestamptz,
  cancelled_by  text,
  cancel_reason text,
  pdf_path      text,                                        -- /files/<id>/<name> once issued
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text,
  UNIQUE (tenant_id, number)
);
CREATE INDEX IF NOT EXISTS di_purchase_order_status_idx ON di.purchase_order (tenant_id, status, expected_date);

CREATE TABLE IF NOT EXISTS di.purchase_order_line (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  po_id         uuid NOT NULL REFERENCES di.purchase_order(id),
  line_no       integer NOT NULL,
  sku           text,
  description   text NOT NULL,
  unit          text NOT NULL DEFAULT 'unit',
  quantity      numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_price    numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  tax_rate      numeric(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0),
  subtotal      numeric(14,2) NOT NULL,
  tax_amount    numeric(14,2) NOT NULL DEFAULT 0,
  total         numeric(14,2) NOT NULL,
  received_qty  numeric(12,3) NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text
);
CREATE UNIQUE INDEX IF NOT EXISTS di_purchase_order_line_no_idx ON di.purchase_order_line (po_id, line_no) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS di.goods_receipt (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  po_id         uuid NOT NULL REFERENCES di.purchase_order(id),
  received_on   date NOT NULL,
  received_by   text,
  note          text,
  lines         jsonb NOT NULL DEFAULT '[]',                 -- [{ line_no, description, quantity }]
  file_path     text,                                        -- delivery order photo or PDF
  file_name     text,
  file_sha256   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text
);
CREATE INDEX IF NOT EXISTS di_goods_receipt_po_idx ON di.goods_receipt (tenant_id, po_id);

CREATE TABLE IF NOT EXISTS di.supplier_document (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  number        text NOT NULL,                               -- our own reference: SQ-2026-0001 / SI-2026-0001
  doc_type      text NOT NULL CHECK (doc_type IN ('quotation', 'invoice')),
  supplier_id   uuid NOT NULL REFERENCES di.supplier(id),
  supplier_ref  text NOT NULL,                               -- the number the supplier printed on it
  doc_date      date NOT NULL,
  valid_until   date,                                        -- quotations
  due_date      date,                                        -- invoices
  currency      text NOT NULL DEFAULT 'MYR',
  subtotal      numeric(14,2) NOT NULL DEFAULT 0,
  tax_total     numeric(14,2) NOT NULL DEFAULT 0,
  total         numeric(14,2) NOT NULL CHECK (total >= 0),
  lines         jsonb NOT NULL DEFAULT '[]',                 -- [{ description, quantity, unit, unit_price, tax_rate, total }]
  status        text NOT NULL,
  po_id         uuid REFERENCES di.purchase_order(id),       -- quotation -> the PO made from it; invoice -> the PO it bills
  file_path     text,
  file_name     text,
  file_mime     text,
  file_sha256   text,
  note          text,
  paid_on       date,
  paid_amount   numeric(14,2),
  payment_ref   text,
  paid_by       text,
  dispute_reason text,
  custom        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text DEFAULT di.current_actor(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text,
  UNIQUE (tenant_id, number),
  CHECK ((doc_type = 'quotation' AND status IN ('received', 'accepted', 'rejected', 'converted'))
      OR (doc_type = 'invoice' AND status IN ('unpaid', 'paid', 'disputed', 'void')))
);
CREATE INDEX IF NOT EXISTS di_supplier_document_ref_idx ON di.supplier_document (tenant_id, supplier_id, lower(supplier_ref));
CREATE INDEX IF NOT EXISTS di_supplier_document_sha_idx ON di.supplier_document (tenant_id, file_sha256);
CREATE INDEX IF NOT EXISTS di_supplier_document_po_idx ON di.supplier_document (tenant_id, po_id);

-- ---------------------------------------------------------------- guards

-- A draft is freely editable. Issuing freezes it: only the status, receiving, cancelling and
-- the stored PDF can move, and a cancelled or fully received order never goes backwards.
CREATE OR REPLACE FUNCTION di.guard_purchase_order() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  movable text[] := ARRAY['status', 'cancelled_at', 'cancelled_by', 'cancel_reason', 'pdf_path',
    'updated_at', 'updated_by'];
BEGIN
  IF OLD.status <> 'draft' THEN
    IF (to_jsonb(NEW) - movable) IS DISTINCT FROM (to_jsonb(OLD) - movable) THEN
      RAISE EXCEPTION 'Purchase order % is % and frozen; cancel it and draft a new one instead.', coalesce(OLD.number, 'draft'), OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'draft' OR OLD.status = 'cancelled' OR (OLD.status = 'received' AND NEW.status <> 'received') THEN
      RAISE EXCEPTION 'Purchase order % cannot go from % to %.', coalesce(OLD.number, 'draft'), OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Lines belong to a draft; once the order is issued only the received quantity moves, and never
-- past what was ordered.
CREATE OR REPLACE FUNCTION di.guard_purchase_order_line() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  po_state text;
  movable text[] := ARRAY['received_qty', 'updated_at', 'updated_by'];
BEGIN
  SELECT status INTO po_state FROM di.purchase_order WHERE id = NEW.po_id;
  IF TG_OP = 'INSERT' THEN
    IF po_state <> 'draft' THEN
      RAISE EXCEPTION 'Lines can only be added to a draft purchase order.' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF po_state <> 'draft' AND (to_jsonb(NEW) - movable) IS DISTINCT FROM (to_jsonb(OLD) - movable) THEN
      RAISE EXCEPTION 'Lines of an issued purchase order are frozen; only the received quantity changes.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.received_qty > NEW.quantity THEN
      RAISE EXCEPTION 'Cannot receive % of "%": only % were ordered.', NEW.received_qty, NEW.description, NEW.quantity
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.received_qty <> OLD.received_qty AND po_state NOT IN ('issued', 'partially_received', 'received') THEN
      RAISE EXCEPTION 'Goods can only be received against an issued purchase order.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- A receipt is evidence of what arrived: insert-only (soft delete aside), against an issued order.
CREATE OR REPLACE FUNCTION di.guard_goods_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  movable text[] := ARRAY['deleted_at', 'deleted_by', 'updated_at', 'updated_by'];
  po_state text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO po_state FROM di.purchase_order WHERE id = NEW.po_id;
    IF po_state NOT IN ('issued', 'partially_received') THEN
      RAISE EXCEPTION 'Goods can only be received against an issued purchase order that is not yet complete.' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF (to_jsonb(NEW) - movable) IS DISTINCT FROM (to_jsonb(OLD) - movable) THEN
    RAISE EXCEPTION 'A goods receipt cannot be edited.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- What a supplier sent is frozen. Status, the link to a PO, the due date, the payment fields and
-- notes can move; to fix a wrong figure, void the document and record it again.
CREATE OR REPLACE FUNCTION di.guard_supplier_document() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  movable text[] := ARRAY['status', 'po_id', 'due_date', 'paid_on', 'paid_amount', 'payment_ref', 'paid_by',
    'dispute_reason', 'note', 'deleted_at', 'deleted_by', 'updated_at', 'updated_by'];
BEGIN
  IF (to_jsonb(NEW) - movable) IS DISTINCT FROM (to_jsonb(OLD) - movable) THEN
    RAISE EXCEPTION 'A recorded supplier document is evidence and cannot be edited; void it and record it again.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.doc_type = 'invoice' AND OLD.status IN ('paid', 'void') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Supplier invoice % is % and final.', OLD.number, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- wire triggers, RLS

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['supplier', 'purchase_order', 'purchase_order_line', 'goods_receipt', 'supplier_document'];
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
DROP TRIGGER IF EXISTS di_guard ON di.purchase_order;
CREATE TRIGGER di_guard BEFORE UPDATE ON di.purchase_order FOR EACH ROW EXECUTE FUNCTION di.guard_purchase_order();
DROP TRIGGER IF EXISTS di_guard ON di.purchase_order_line;
CREATE TRIGGER di_guard BEFORE INSERT OR UPDATE ON di.purchase_order_line FOR EACH ROW EXECUTE FUNCTION di.guard_purchase_order_line();
DROP TRIGGER IF EXISTS di_guard ON di.goods_receipt;
CREATE TRIGGER di_guard BEFORE INSERT OR UPDATE ON di.goods_receipt FOR EACH ROW EXECUTE FUNCTION di.guard_goods_receipt();
DROP TRIGGER IF EXISTS di_guard ON di.supplier_document;
CREATE TRIGGER di_guard BEFORE UPDATE ON di.supplier_document FOR EACH ROW EXECUTE FUNCTION di.guard_supplier_document();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'di_app') THEN
    GRANT SELECT, INSERT, UPDATE ON di.supplier, di.purchase_order, di.purchase_order_line, di.goods_receipt, di.supplier_document TO di_app;
    GRANT EXECUTE ON FUNCTION di.guard_purchase_order(), di.guard_purchase_order_line(), di.guard_goods_receipt(), di.guard_supplier_document() TO di_app;
  END IF;
EXCEPTION WHEN insufficient_privilege OR invalid_grant_operation THEN
  RAISE NOTICE 'di_app grants for procurement incomplete: %', SQLERRM;
END $$;
