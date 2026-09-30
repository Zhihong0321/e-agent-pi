import { hasApiAuth } from './auth.mjs';
import { companyHostContext } from '../document_inteligence/host.mjs';
import { withContext } from '../document_inteligence/core/db.mjs';
import { getCompanyProfile } from '../document_inteligence/core/company.mjs';
import { listCompanyMembers } from '../document_inteligence/core/members.mjs';
import { findCustomers } from '../document_inteligence/core/records.mjs';

export async function loadDemoState(ctx = companyHostContext()) {
  return withContext(ctx.db, { ...ctx, agent: 'demo-view' }, async (tx) => {
    const profile = await getCompanyProfile(tx);
    const members = await listCompanyMembers(tx);
    const customers = await findCustomers(tx, { limit: 30 });
    const invoices = (await tx.query(
      `SELECT d.id, d.number, d.status, d.total, d.currency, d.created_at, c.name AS customer
         FROM di.document d LEFT JOIN di.customer c ON c.id=d.customer_id AND c.tenant_id=di.current_tenant()
        WHERE d.tenant_id=di.current_tenant() AND d.doc_type='invoice' AND d.deleted_at IS NULL
        ORDER BY d.created_at DESC LIMIT 50`,
    )).rows;
    const company = Object.fromEntries(profile.fields.map(({ key }) => [key, profile.company[key]]));
    return { profile: { company, fields: profile.fields, readiness: profile.readiness }, members: members.members, customers: customers.customers, invoices };
  });
}

export async function handleDemoState(req, res) {
  const reply = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'GET') return reply(405, { error: 'Method not allowed' });
  if (!hasApiAuth(req)) return reply(401, { error: 'Unlock Settings to use the live demo.' });
  try { return reply(200, await loadDemoState()); }
  catch { return reply(503, { error: 'Live company records are unavailable. Try again shortly.' }); }
}
