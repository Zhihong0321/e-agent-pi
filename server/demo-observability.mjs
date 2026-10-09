import { chatLogs } from './chat-logs.mjs';
import { usageReport } from './usage.mjs';
import { listActivity } from './activity.mjs';
import { metricsPayload } from './metrics.mjs';
import { listDbAudit } from './db-audit.mjs';

export async function demoObservability(pathname, params, user, services = { chatLogs, usageReport, listActivity, metricsPayload, listDbAudit }) {
  if (!user) throw new Error('Please sign in');
  const options = Object.fromEntries(params);
  const isAdmin = user.role === 'admin';
  const userId = isAdmin ? undefined : user.id;
  const companyId = isAdmin ? user.company_tenant_id : undefined;
  if (isAdmin && !companyId) throw new Error('Company tenant is required');
  if (pathname === '/api/demo/db-log') return isAdmin ? services.listDbAudit(options, user) : null;
  if (pathname === '/api/demo/chat-logs') return services.chatLogs({ ...options, userId, companyId });
  if (pathname === '/api/demo/usage') return services.usageReport({ ...options, userId, companyId });
  if (pathname === '/api/demo/activity') return services.listActivity({ ...options, userId, isAdmin, companyId });
  if (pathname === '/api/demo/metrics' && isAdmin) return services.metricsPayload();
  return null;
}
