// Financial audit history comes from transactional database triggers, never chat output.
export const FINANCIAL_ENTITIES = ['document', 'document_line', 'payment', 'payment_allocation',
  'purchase_order', 'purchase_order_line', 'goods_receipt', 'supplier_document',
  'expense_claim', 'expense_receipt', 'expense_batch', 'expense_setting', 'tax_code',
  'product', 'package', 'package_item', 'supplier'];
const NOISE = new Set(['updated_at', 'updated_by', 'created_at', 'created_by', 'tenant_id', 'id']);

export function auditChanges(before, after) {
  return Object.fromEntries([...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
    .filter(key => !NOISE.has(key) && JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null))
    .map(key => [key, { from: before?.[key] ?? null, to: after?.[key] ?? null }]));
}

export async function financialAuditLog(tx, tenantId, { entity, action, actor, search, before, limit = 50 } = {}) {
  if (entity && !FINANCIAL_ENTITIES.includes(entity)) throw new Error('Invalid record type');
  if (action && !['insert', 'update', 'soft_delete', 'restore'].includes(action)) throw new Error('Invalid action');
  if (before && !/^\d+$/.test(String(before))) throw new Error('Invalid cursor');
  const size = Math.max(1, Math.min(Math.floor(Number(limit)) || 50, 100));
  const { rows } = await tx.query(`
    WITH history AS (
      SELECT a.*, coalesce(a.after->>'number', a.before->>'number', d.number, p.number, c.number,
        a.after->>'period_key', a.before->>'period_key', a.entity_id::text) AS reference
      FROM di.audit_log a
      LEFT JOIN di.document d ON d.tenant_id = a.tenant_id AND d.id::text = coalesce(a.after->>'document_id', a.before->>'document_id')
      LEFT JOIN di.purchase_order p ON p.tenant_id = a.tenant_id AND p.id::text = coalesce(a.after->>'po_id', a.before->>'po_id')
      LEFT JOIN di.expense_claim c ON c.tenant_id = a.tenant_id AND c.id::text = coalesce(a.after->>'claim_id', a.before->>'claim_id')
      WHERE a.tenant_id = $1 AND a.entity = ANY($2::text[])
        AND ($3::text IS NULL OR a.entity = $3) AND ($4::text IS NULL OR a.action = $4)
        AND ($5::text IS NULL OR a.actor ILIKE '%' || $5 || '%')
        AND ($6::bigint IS NULL OR a.id < $6)
        AND (a.action <> 'update' OR
          (coalesce(a.before, '{}'::jsonb) - ARRAY['updated_at','updated_by','created_at','created_by']) IS DISTINCT FROM
          (coalesce(a.after, '{}'::jsonb) - ARRAY['updated_at','updated_by','created_at','created_by']))
    ) SELECT * FROM history WHERE ($7::text IS NULL OR reference ILIKE '%' || $7 || '%' OR entity_id::text = $7)
      ORDER BY id DESC LIMIT $8`,
  [tenantId, FINANCIAL_ENTITIES, entity || null, action || null, actor || null, before || null, search || null, size + 1]);
  const entries = rows.slice(0, size).map(row => ({
    id: String(row.id), at: row.at, actor: row.actor, actorUserId: row.actor_user_id, agent: row.agent, action: row.action,
    entity: row.entity, entityId: row.entity_id, reference: row.reference,
    changes: auditChanges(row.before, row.after),
  }));
  return { entries, nextCursor: rows.length > size ? entries.at(-1).id : null };
}
