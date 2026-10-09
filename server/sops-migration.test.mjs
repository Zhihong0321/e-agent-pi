// The SOP scope migration and queries run against real Postgres (PGlite), starting from the
// old one-row-per-agent shape that production has.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const holder = { pool: null };
mock.module('./db.mjs', { namedExports: { getPool: () => holder.pool } });
mock.module('./paths.mjs', {
  namedExports: {
    agentWorkspace: ({ slug }, tenantId) => `/tmp/sop-migration/${tenantId || 'platform'}/${slug}`,
    isPlatformAgent: () => false,
  },
});
const sops = await import(`./sops.mjs?migration=${Date.now()}`);

async function oldShapeDb() {
  const pglite = new PGlite();
  holder.pool = {
    query: async (sql, params) => {
      const result = params?.length ? await pglite.query(sql, params) : (await pglite.exec(sql)).at(-1);
      return { rows: result?.rows || [], rowCount: result?.affectedRows ?? result?.rows?.length ?? 0 };
    },
  };
  await holder.pool.query(`CREATE TABLE agents (id TEXT PRIMARY KEY, slug TEXT, name TEXT)`);
  await holder.pool.query(`INSERT INTO agents VALUES ('di-documents','di-documents','Docs'),('orchestrator','orchestrator','Orch')`);
  await holder.pool.query(`CREATE TABLE agent_sops (
    agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE, id TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL, created_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await holder.pool.query(`INSERT INTO agent_sops (agent_id, id, content) VALUES ('di-documents','old-1','# Existing platform rules')`);
  return holder.pool;
}

const A = '1739a61f-08a2-4112-b7f9-601111e8b949';
const B = '9baf99c3-0085-4532-b023-b2a5bbb47329';

test('the migration keeps existing SOPs as the platform default and is safe to run twice', async () => {
  const pool = await oldShapeDb();
  await sops.ensureSopSchema();
  await sops.ensureSopSchema();
  const row = (await pool.query(`SELECT agent_id, company_id, content FROM agent_sops`)).rows;
  assert.deepEqual(row, [{ agent_id: 'di-documents', company_id: null, content: '# Existing platform rules' }]);
  assert.equal((await sops.getAgentSop('di-documents', A)).content, '# Existing platform rules', 'a company starts from the default');
});

test('after the migration each company has its own version and the default is untouched', async () => {
  const pool = await oldShapeDb();
  await sops.ensureSopSchema();
  await sops.saveAgentSop('di-documents', '# Alpha rules', 'alpha-admin', A);
  await sops.saveAgentSop('di-documents', '# Beta rules', 'beta-admin', B);
  await sops.saveAgentSop('di-documents', '# Alpha rules v2', 'alpha-admin', A);
  assert.equal((await sops.getAgentSop('di-documents', A)).content, '# Alpha rules v2');
  assert.equal((await sops.getAgentSop('di-documents', B)).content, '# Beta rules');
  assert.equal((await sops.getAgentSop('di-documents')).content, '# Existing platform rules');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM agent_sops')).rows[0].n, 3, 'one row per agent and company');
  assert.equal(await sops.clearAgentSop('di-documents', null, A), true);
  assert.equal((await sops.getAgentSop('di-documents', A)).content, '# Existing platform rules');
  assert.equal((await sops.getAgentSop('di-documents', B)).content, '# Beta rules');
  assert.notEqual(await sops.sopFingerprint('di-documents', B), '');
});

test('two platform defaults for one agent are refused by the database', async () => {
  await oldShapeDb();
  await sops.ensureSopSchema();
  await assert.rejects(() => holder.pool.query(`INSERT INTO agent_sops (agent_id, id, content) VALUES ('di-documents','dup','x')`), /unique|duplicate/i);
});
