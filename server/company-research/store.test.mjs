import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { ResearchStore } from './store.mjs';
import { reconcile, evidenceRecord } from './core.mjs';

test('Postgres migrations, queue leases, cache, evidence and replay work together', async () => {
  const db = new PGlite({ extensions: { pg_trgm } });
  const pool = { query: async (sql, params) => params ? db.query(sql, params) : (await db.exec(sql)).at(-1) };
  const store = new ResearchStore(pool);
  try {
    await store.migrate(); await store.migrate();
    assert.equal(store.trigrams, true);
    await store.importDirectory([{ id: 'directory-1', name: 'Acme Solar Sdn Bhd', phone: '011-2345 6789', url: 'https://newpages.com.my/acme' }]);
    assert.equal((await store.directoryCandidates({ name: 'Acme Solar' }))[0].id, 'directory-1');
    const seed = { name: 'Acme Solar', website: 'https://acme.example/', place_id: 'test-place' };
    const first = await store.enqueue(seed);
    assert.equal((await store.enqueue(seed)).id, first.id);
    const forced = await store.enqueue(seed, true); assert.notEqual(forced.id, first.id);
    const claimed = await store.claim(); assert.equal(claimed.id, first.id);
    const second = await store.claim(); assert.equal(second.id, forced.id);
    assert.equal(await store.claim(), undefined);
    const e = evidenceRecord({ id: 'E1', url: seed.website, tier: 3, text: 'Acme Solar offers solar installation.', lane: 'C' });
    const run = { lane: 'G2', status: 'ok', findings: { facts: [{ field: 'sells', value: 'solar installation', evidence_id: 'E1', quote: e.text }] } };
    await store.evidence(first.id, e); await store.run(first.id, run);
    const input = { seed, identity: { status: 'locked' }, evidence: [e], runs: [run], startedAt: '2026-10-02T00:00:00.000Z', webState: 'active' };
    const clock = new Date('2026-10-02T00:01:00.000Z');
    const result = reconcile(input, clock);
    await store.finish(first.id, { ...input, result, status: 'partial' });
    const row = await store.get(first.id); assert.equal(row.status, 'partial'); assert.equal(row.result.business.sells.value, 'solar installation');
    const replay = await store.replayInput(first.id); assert.deepEqual(reconcile(replay, clock), result);
    assert.equal((await store.events(first.id)).at(-1).data.status, 'partial');
    await store.evidence(second.id, e); await store.run(second.id, run);
    await db.query("UPDATE company_research_dossiers SET lease_until=now()-interval '1 minute' WHERE id=$1", [second.id]);
    assert.equal((await store.claim()).id, second.id);
    assert.equal((await db.query('SELECT * FROM company_research_evidence WHERE dossier_id=$1', [second.id])).rows.length, 0);
    await store.fail(second.id, 'test failure'); assert.equal((await store.get(second.id)).status, 'failed');
    assert.notEqual((await store.enqueue({ ...seed, phone: '012-345 6789' })).id, first.id);
  } finally { await db.close(); }
});
