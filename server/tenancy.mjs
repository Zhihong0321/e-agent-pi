// Tenancy kernel: the only place a request, run or session is turned into a tenant id.
// Rule: an operation runs for exactly one tenant, named by the caller's identity. Nothing here
// (or anywhere else) may fall back to a process-wide default; a missing tenant is an error.
// This module imports nothing from the host or the database at load time, so any layer can use it.

let operatorTenant = '';

/** Boot only: records the bootstrap company the platform operator acts on when it names none. */
export function setOperatorTenant(id) {
  operatorTenant = present(id);
}

/** The operator's default company. Use only through tenantForRequest / tenantOfSession. */
export function operatorTenantId() {
  if (!operatorTenant) throw new Error('Document Intelligence is not ready');
  return operatorTenant;
}

export class TenantRequired extends Error {
  constructor(message = 'Company tenant is required') {
    super(message);
    this.name = 'TenantRequired';
    this.status = 400;
  }
}

const present = (id) => (typeof id === 'string' && id.trim() ? id.trim() : '');

/** The tenant of a signed-in user. */
export function tenantOf(user) {
  const id = present(user?.company_tenant_id);
  if (!id) throw new TenantRequired();
  return id;
}

/** The tenant of an execution context (chat run, delegated task, scheduled run). */
export function tenantFromRun(ctx) {
  const id = present(ctx?.companyId);
  if (!id) throw new TenantRequired('This run has no company tenant');
  return id;
}

/** Validates a tenant id that must already be known (e.g. read from a stored plan or schedule). */
export function requireTenant(id, what = 'operation') {
  const value = present(id);
  if (!value) throw new TenantRequired(`${what} has no company tenant`);
  return value;
}

/**
 * Tenant for a request that is either a signed-in user or the platform operator (owner
 * credential). The operator is a platform identity: it acts on the tenant it names with
 * `X-Tenant-Id`, else on the operator tenant. Only call this from operator-authenticated
 * entry points; a user request never reaches the operator tenant.
 */
export function tenantForRequest(req, user) {
  if (user) return tenantOf(user);
  const named = present(req?.headers?.['x-tenant-id']);
  return named || operatorTenantId();
}

/** The tenant that owns a chat session: its owner's company, or the operator tenant for owner-token chats. */
export async function tenantOfSession(sessionId) {
  const { getPool } = await import('./db.mjs');
  const { rows } = await getPool().query(
    `SELECT s.user_id, u.company_tenant_id FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
    [sessionId],
  );
  if (!rows[0]) throw new TenantRequired('Session not found');
  return tenantOfOwner(rows[0].user_id, rows[0].company_tenant_id);
}

/**
 * The tenant for a row already joined to its owner: the owner's company, or the operator tenant
 * when the row has no owner (an owner-credential chat). An owner with no company is an error.
 */
export function tenantOfOwner(userId, ownerCompanyId) {
  if (!userId) return operatorTenantId();
  return requireTenant(ownerCompanyId, 'session owner');
}
