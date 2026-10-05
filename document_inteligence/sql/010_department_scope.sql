-- Department heads approve their own department's purchase orders (server/roles.mjs).
-- The drafter's department is stamped on the PO; older POs stay Superadmin-only.
ALTER TABLE di.purchase_order ADD COLUMN IF NOT EXISTS department text;
CREATE INDEX IF NOT EXISTS di_purchase_order_department_idx
  ON di.purchase_order (tenant_id, lower(department)) WHERE deleted_at IS NULL;
