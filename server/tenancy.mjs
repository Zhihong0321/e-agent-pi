// Tenancy kernel: the only place a request, run or session is turned into a company id.
// Rule: an operation runs for exactly one company, named by the caller's identity. Nothing here
// (or anywhere else) may fall back to a default company; a missing company is an error.
// This module imports nothing from the host or the database at load time, so any layer can use it.

export class TenantRequired extends Error {
  constructor(message = 'Company tenant is required') {
    super(message);
    this.name = 'TenantRequired';
    this.status = 400;
  }
}

const present = (id) => (typeof id === 'string' && id.trim() ? id.trim() : '');

/** The company of a signed-in user. */
export function tenantOf(user) {
  const id = present(user?.company_tenant_id);
  if (!id) throw new TenantRequired();
  return id;
}

/** The company of an execution context (chat run, delegated task, scheduled run). */
export function tenantFromRun(ctx) {
  const id = present(ctx?.companyId);
  if (!id) throw new TenantRequired('This run has no company tenant');
  return id;
}

/** Validates a company id that must already be known (e.g. read from a stored plan or schedule). */
export function requireTenant(id, what = 'operation') {
  const value = present(id);
  if (!value) throw new TenantRequired(`${what} has no company tenant`);
  return value;
}

/**
 * Company for a request. A signed-in user acts for their own company. The platform operator
 * (owner credential, no login) names the company it acts for with `X-Tenant-Id`; without it the
 * request is refused. Only call this from operator-authenticated entry points for the operator.
 */
export function tenantForRequest(req, user) {
  if (user) return tenantOf(user);
  const named = present(req?.headers?.['x-tenant-id']);
  if (!named) throw new TenantRequired();
  return named;
}

/** The company that owns a chat session: its owner's company, or the one stored on an owner-credential session. */
export async function tenantOfSession(sessionId) {
  const { getPool } = await import('./db.mjs');
  const { rows } = await getPool().query(
    `SELECT COALESCE(u.company_tenant_id, s.company_tenant_id) AS company_tenant_id
       FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
    [sessionId],
  );
  if (!rows[0]) throw new TenantRequired('Session not found');
  return requireTenant(rows[0].company_tenant_id, 'session');
}
