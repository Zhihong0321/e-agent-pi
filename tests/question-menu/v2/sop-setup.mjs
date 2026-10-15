// Setup for the SOP discount test: the Sales category, a Sales user and a Department head user (both created
// the way the /demo People page does, as the company's Superadmin), the company profile the document gate
// needs, one customer and one product with a known price. Usage: node tests/question-menu/v2/sop-setup.mjs <rep> <run-id>
import { randomBytes } from 'node:crypto';
import { makeClient, makeLogger, probe, loadFixtures, saveFixtures, runDir } from './lib.mjs';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const rep = Number(process.argv[2]); const runId = process.argv[3];
const f = loadFixtures(rep); const log = makeLogger(runId);
const pw = () => 'Sop-' + randomBytes(10).toString('hex');
f.users = { admin: 'sopowner', user: 'sopsales', head: 'sophead' };
f.logins.user ||= pw(); f.logins.head ||= pw();
saveFixtures(rep, f);
const out = {};
const admin = makeClient('sopowner', log);
const lg = await admin.login(f.users.admin, f.logins.admin, f.companyCode);
if (lg.status !== 200) throw new Error('owner login ' + lg.status);
const act = async (body) => { const r = await admin.post('/api/demo/action', body); if (r.status !== 200) throw new Error(JSON.stringify(body).slice(0, 120) + ' -> ' + r.status + ' ' + JSON.stringify(r.data)); return r.data.result; };

// Sales category: access user, NO limits (the SOP is the only rule under test).
const cat = await act({ action: 'category', category: { name: 'Sales', access: 'user' } });
out.category = cat; f.salesCategoryId = cat.category.id;
const sales = await act({ action: 'user', user: { name: 'SOP Sales', username: f.users.user, password: f.logins.user, category: 'Sales', department: 'Sales' } });
const head = await act({ action: 'user', user: { name: 'SOP Head', username: f.users.head, password: f.logins.head, category: 'Department head', department: 'Sales' } });
out.sales = sales.user; out.head = head.user; f.salesUserId = sales.user.id; f.headId = head.user.id;

// Same as a company gets in the product: the Superadmin's agents.
const a = await admin.get('/api/agents');
const ids = (a.data?.agents || a.data || []).map((x) => x.id);
for (const uid of [f.salesUserId, f.headId]) probe('set-agents', { userId: uid, agents: ids });
out.agentIds = ids;

// Company profile (the gate that blocks document drafts).
const state = (await admin.get('/api/demo/state')).data; let rev = state?.profile?.revision;
const COMPANY = 'SOP Discount Test 2026-10-15';
const set = { name: COMPANY, legal_name: COMPANY, reg_no: '202610150001', email: 'ops@sopdiscount.example', phone: '+60355501010', address: 'SOP test block, Petaling Jaya', country: 'MY',
  business_type: 'services', business_activity: 'Solar installation test company', tax_status: 'not_registered', currency: 'MYR', payment_terms_days: 30 };
for (const [key, value] of Object.entries(set)) { const p = await admin.post('/api/demo/action', { action: 'profile', key, value, revision: rev }); if (p.data?.result?.revision) rev = p.data.result.revision; else if (p.data?.revision) rev = p.data.revision; if (p.status !== 200) out['profile-' + key] = p.status + ' ' + JSON.stringify(p.data).slice(0, 160); }

out.customer = (await act({ action: 'customer', customer: { name: 'Bintang Hijau Sdn Bhd', email: 'accounts@bintanghijau.example', phone: '+60312345678', billing_address: { line1: '1 Jalan Test', city: 'Kuala Lumpur', country: 'MY' } } }));
f.customerId = out.customer.customer?.id || out.customer.id;
out.product = probe('sql', { q: `INSERT INTO di.product (tenant_id, sku, name, description, unit, unit_price, is_active) VALUES ($1,'SOLAR-5KW','Solar Panel Set 5kW','5kW rooftop solar panel set, supply only','set',1000.00,true) RETURNING id, sku, name, unit_price`, p: [f.tenantId] });
f.productId = out.product[0]?.id;
saveFixtures(rep, f);
writeFileSync(path.join(runDir(runId), 'setup.json'), JSON.stringify({ ...out, logins: undefined }, null, 1));
console.log(JSON.stringify(out, null, 1));
