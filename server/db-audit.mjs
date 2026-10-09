import { tenantContext } from '../document_inteligence/host.mjs';
import { withContext } from '../document_inteligence/core/db.mjs';
import { financialAuditLog } from '../document_inteligence/core/audit-log.mjs';

export async function listDbAudit(options, user) {
  if (user?.role !== 'admin') throw new Error('Admin access required');
  if (!user.company_tenant_id) throw new Error('Company tenant is required');
  const ctx = tenantContext(user.company_tenant_id);
  return withContext(ctx.db, { ...ctx, actor: user.username, agent: 'db-log' },
    tx => financialAuditLog(tx, ctx.tenantId, options));
}
