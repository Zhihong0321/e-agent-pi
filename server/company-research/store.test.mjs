import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { ResearchStore } from './store.mjs';
import { reconcile, evidenceRecord } from './core.mjs';

const CO = 'company-a', OTHER = 'company-b';
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
    const first = await store.enqueue(seed, false, {}, CO);
    assert.equal((await store.enqueue(seed, false, {}, CO)).id, first.id);
    const forced = await store.enqueue(seed, true, {}, CO); assert.notEqual(forced.id, first.id);
    assert.notEqual((await store.enqueue(seed, false, {}, OTHER)).id, first.id, 'another company never gets this company\'s cached dossier');
    const claimed = await store.claim(); assert.equal(claimed.id, first.id);
    const second = await store.claim(); assert.equal(second.id, forced.id);
    await store.claim(); // the other company's queued dossier
    assert.equal(await store.claim(), undefined);
    const e = evidenceRecord({ id: 'E1', url: seed.website, tier: 3, text: 'Acme Solar offers solar installation.', lane: 'C' });
    const run = { lane: 'G2', status: 'ok', findings: { facts: [{ field: 'sells', value: 'solar installation', evidence_id: 'E1', quote: e.text }] } };
    await store.evidence(first.id, e); await store.run(first.id, run);
    const input = { seed, identity: { status: 'locked' }, evidence: [e], runs: [run], startedAt: '2026-10-02T00:00:00.000Z', webState: 'active' };
    const clock = new Date('2026-10-02T00:01:00.000Z');
    const result = reconcile(input, clock);
    await store.finish(first.id, { ...input, result, status: 'partial' });
    const row = await store.get(first.id, CO); assert.equal(row.status, 'partial'); assert.equal(row.result.business.sells.value, 'solar installation');
    const replay = await store.replayInput(first.id, CO); assert.deepEqual(reconcile(replay, clock), result);
    assert.equal((await store.events(first.id, 0, CO)).at(-1).data.status, 'partial');
    await store.evidence(second.id, e); await store.run(second.id, run);
    await db.query("UPDATE company_research_dossiers SET lease_until=now()-interval '1 minute' WHERE id=$1", [second.id]);
    assert.equal((await store.claim()).id, second.id);
    assert.equal((await db.query('SELECT * FROM company_research_evidence WHERE dossier_id=$1', [second.id])).rows.length, 0);
    await store.fail(second.id, 'test failure'); assert.equal((await store.get(second.id, CO)).status, 'failed');
    assert.equal(await store.get(first.id, OTHER), null);
    assert.equal((await store.list({ status: 'all', companyId: OTHER })).items.every((item) => item.id !== first.id), true);
    await assert.rejects(store.get(first.id), /Company tenant is required/);
    await assert.rejects(store.list({ status: 'all' }), /Company tenant is required/);
    await assert.rejects(store.replayInput(first.id, OTHER), /no completed replay input/);
    await assert.rejects(store.publish(first.id, '<p>x</p>', 'Acme', OTHER), /Dossier not found/);
    assert.notEqual((await store.enqueue({ ...seed, phone: '012-345 6789' }, false, {}, CO)).id, first.id);
  } finally { await db.close(); }
});

test('recovered leases fence stale workers from evidence, findings, completion and failure', async () => {
  const db = new PGlite();
  const store = new ResearchStore({ query: (sql, params) => params ? db.query(sql, params) : db.exec(sql).then(r => r.at(-1)) });
  try {
    await store.migrate();
    const seed = { name: 'Acme Solar', website: 'https://acme.example/' };
    const first = await store.enqueue(seed, false, {}, CO);
    assert.equal((await store.enqueue(seed, false, {}, CO)).id, first.id); // Names/websites cache without a place id.
    const old = await store.claim();
    const e = evidenceRecord({ id: 'E1', url: seed.website, text: 'Acme Solar installation', tier: 3, lane: 'C' });
    await store.evidence(first.id, e, old.lease_token);
    await db.query("UPDATE company_research_dossiers SET lease_until=now()-interval '1 minute' WHERE id=$1", [first.id]);
    assert.equal(await store.heartbeat(first.id, old.lease_token), false);
    const current = await store.claim();
    assert.notEqual(current.lease_token, old.lease_token);
    assert.equal((await db.query('SELECT id FROM company_research_evidence')).rows.length, 0);
    await assert.rejects(store.evidence(first.id, e, old.lease_token), /lease lost/);
    await assert.rejects(store.run(first.id, { lane: 'G1' }, old.lease_token), /lease lost/);
    await assert.rejects(store.event(first.id, { type: 'stale' }, old.lease_token), /lease lost/);
    await assert.rejects(store.finish(first.id, { status: 'complete' }, old.lease_token), /lease lost/);
    assert.equal(await store.fail(first.id, 'stale failure', old.lease_token), false);
    assert.equal((await store.get(first.id, CO)).status, 'running');
    await store.evidence(first.id, e, current.lease_token);
    assert.equal(await store.heartbeat(first.id, current.lease_token), true);
    assert.equal(await store.release(first.id, old.lease_token), false);
    assert.equal(await store.release(first.id, current.lease_token), true);
    assert.equal(await store.heartbeat(first.id, current.lease_token), false);
    const restarted = await store.claim();
    assert.equal(restarted.id, first.id);
    assert.notEqual(restarted.lease_token, current.lease_token);
    assert.equal(await store.fail(first.id, 'current failure', restarted.lease_token), true);
    assert.equal((await store.get(first.id, CO)).error, 'current failure');
  } finally { await db.close(); }
});
