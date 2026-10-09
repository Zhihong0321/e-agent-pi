// Exercises real login/session attribution, the DI HTTP handler, invoice tools,
// database triggers and the DB Log API against an isolated PostgreSQL engine.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import http from 'node:http';
import { PGlite } from '@electric-sql/pglite';

test('invoice creation and editing through authenticated HTTP produce exact DB Log history', async t => {
  const postgres = new PGlite();
  let tail = Promise.resolve();
  const acquire = async () => {
    const previous = tail;
    let release;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    return release;
  };
  const query = async (sql, params) => {
    const result = params?.length ? await postgres.query(sql, params) : (await postgres.exec(sql)).at(-1);
    return { rows: result?.rows || [], rowCount: result?.affectedRows ?? result?.rows?.length ?? 0 };
  };
  const pool = {
    query: async (sql, params) => { const release = await acquire(); try { return await query(sql, params); } finally { release(); } },
    connect: async () => { const release = await acquire(); return { query, release }; },
    end: async () => {},
  };
  await postgres.exec('CREATE TABLE agents (id TEXT PRIMARY KEY)');
  mock.module('pg', { defaultExport: { Pool: class { constructor() { return pool; } } } });
  const db = await import('./db.mjs');
  const users = await import('./users.mjs');
  const di = await import('../document_inteligence/host.mjs');
  const { demoObservability } = await import('./demo-observability.mjs');
  const oldUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://localhost/invoice-audit-fixture';
  let host;
  try {
    await db.connectDb();
    await di.ensureDocumentIntelligence({ pool, catalog: {
      seedSystemAgent: async () => {}, getMcpServer: async () => ({ id: 'mcp' }),
      updateMcpServer: async () => {}, attachAgentResources: async () => {},
    } });
    await pool.query(`INSERT INTO users(id,username,password_hash,display_name,role) VALUES
      ('audit-alice','audit_alice',$1,'Audit Alice','user'),
      ('audit-carol','audit_carol',$1,'Audit Carol','admin')`, [users.hashPassword('isolated-fixture-password')]);
    const tenantId = di.companyHostContext().tenantId;
    await pool.query(`UPDATE users SET company_tenant_id=$1 WHERE id LIKE 'audit-%'`, [tenantId]);
    const customer = (await pool.query(`INSERT INTO di.customer(tenant_id,code,name) VALUES ($1,'C-AUDIT','Audit Test Customer') RETURNING id`, [tenantId])).rows[0].id;
    host = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      try {
        if (url.pathname === '/api/internal/di') {
          let text = ''; for await (const chunk of req) text += chunk;
          const out = await di.handleDiRequest(req, JSON.parse(text), { workspace: () => process.cwd() });
          return send(out.status, out.body);
        }
        const user = await users.requestUser(req);
        if (!user) return send(401, { error: 'Please sign in' });
        const data = await demoObservability(url.pathname, url.searchParams, user);
        return data ? send(200, data) : send(403, { error: 'Admin access required' });
      } catch (err) { send(400, { error: err.message }); }
    });
    await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${host.address().port}`;
    const login = async username => users.loginUser({ headers: {}, socket: { remoteAddress: 'audit-fixture' } }, { username, password: 'isolated-fixture-password' });
    const alice = await login('audit_alice');
    const carol = await login('audit_carol');
    const aliceSession = await db.createSession({ agentId: 'di-documents', userId: alice.user.id });
    const carolSession = await db.createSession({ agentId: 'di-documents', userId: carol.user.id });
    const call = async (session, tool, args, headers = {}) => {
      const response = await fetch(`${base}/api/internal/di`, {
        method: 'POST', headers: { 'Content-Type': 'application/json',
          Authorization: `Bearer ${di.diTokenFor('di-documents', session.id)}`, 'X-DI-Session': session.id, ...headers },
        body: JSON.stringify({ agent: 'di-documents', tool, args }),
      });
      return { status: response.status, body: await response.json() };
    };
    const created = await call(aliceSession, 'create_draft', {
      doc_type: 'invoice', customer, reference: 'AUDIT-INVOICE-DEMO', notes: 'Original invoice',
      issue_date: '2026-10-03', due_date: '2026-11-03',
      lines: [{ description: 'Consulting', quantity: 2, unit_price: 100 }],
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const invoice = created.body.result.document;
    assert.equal(invoice.total, 200);
    const edited = await call(carolSession, 'update_draft', {
      document: invoice.id, set: { notes: 'Corrected invoice' },
      update_lines: [{ line_id: invoice.lines[0].id, unit_price: 150 }],
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.result.document.total, 300);
    const read = async login => {
      const response = await fetch(`${base}/api/demo/db-log?search=${invoice.id}`, {
        headers: login ? { cookie: `demo_session=${login.token}` } : {},
      });
      return { status: response.status, body: await response.json() };
    };
    const log = await read(carol);
    assert.equal(log.status, 200);
    const entries = log.body.entries;
    const creator = entries.find(entry => entry.entity === 'document' && entry.action === 'insert');
    assert.equal(creator.actor, 'audit_alice');
    assert.equal(creator.actorUserId, alice.user.id);
    const totalEdit = entries.find(entry => entry.entity === 'document' && entry.changes.total?.from === 200);
    assert.deepEqual(totalEdit.changes.total, { from: 200, to: 300 });
    assert.equal(totalEdit.actor, 'audit_carol');
    assert.equal(totalEdit.actorUserId, carol.user.id);
    const notesEdit = entries.find(entry => entry.changes.notes?.from === 'Original invoice');
    assert.deepEqual(notesEdit.changes.notes, { from: 'Original invoice', to: 'Corrected invoice' });
    const lineHistory = await fetch(`${base}/api/demo/db-log?entity=document_line`, { headers: { cookie: `demo_session=${carol.token}` } }).then(res => res.json());
    const priceEdit = lineHistory.entries.find(entry => entry.entityId === invoice.lines[0].id && entry.changes.unit_price?.from === 100);
    assert.deepEqual(priceEdit.changes.unit_price, { from: 100, to: 150 });
    assert.equal(priceEdit.actor, 'audit_carol');
    assert.equal((await read(alice)).status, 403);
    assert.equal((await read(null)).status, 401);
    const forged = await call(aliceSession, 'update_draft', { document: invoice.id, set: { notes: 'Forged' } }, { 'X-DI-Session': carolSession.id });
    assert.equal(forged.status, 401);
    await users.logoutUser({ headers: { cookie: `demo_session=${carol.token}` } });
    const revoked = await call(carolSession, 'update_draft', { document: invoice.id, set: { notes: 'After logout' } });
    assert.equal(revoked.status, 400);
    assert.match(revoked.body.error, /no active login/);
    t.diagnostic(JSON.stringify({
      environment: 'isolated PostgreSQL fixture; actual application HTTP handlers and invoice tools',
      invoiceId: invoice.id, invoiceStatus: 'draft', reference: 'AUDIT-INVOICE-DEMO',
      creator: { username: creator.actor, userId: creator.actorUserId },
      editor: { username: totalEdit.actor, userId: totalEdit.actorUserId },
      changes: { unit_price: priceEdit.changes.unit_price, total: totalEdit.changes.total, notes: notesEdit.changes.notes },
      accessChecks: { admin: 200, regularUser: 403, anonymous: 401, forgedSession: 401, loggedOut: 'refused' },
    }, null, 2));
  } finally {
    if (host) await new Promise(resolve => host.close(resolve));
    if (oldUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldUrl;
    await db.closeDb();
    await postgres.close();
  }
});
