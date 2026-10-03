import { companyHostContext } from '../document_inteligence/host.mjs';
import { withContext } from '../document_inteligence/core/db.mjs';
import { financialAuditLog } from '../document_inteligence/core/audit-log.mjs';

export async function listDbAudit(options, user) {
  if (user?.role !== 'admin') throw new Error('Admin access required');
  const ctx = companyHostContext();
  return withContext(ctx.db, { ...ctx, actor: user.username, agent: 'db-log' },
    tx => financialAuditLog(tx, ctx.tenantId, options));
}
