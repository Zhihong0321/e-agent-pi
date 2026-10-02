import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceRecord, validateFindings, fact, reconcile, renderDossier } from './core.mjs';

test('ranges, mixed workforce, unnamed projects and month-only milestones stay visible without inventing values', () => {
  const text = '60+ Staff & contractors. 1.65 MWp Deployed solar PV. 2025 · MAR CIDB Certified — Grade G3.';
  const e = evidenceRecord({ id: 'E1', url: 'https://acme.example/', tier: 3, text });
  const observations = [
    { category: 'operating_scale', value: '60+ Staff & contractors', quote: '60+ Staff & contractors', evidence_id: 'E1' },
    { category: 'milestones', value: '2025 · MAR CIDB Certified — Grade G3', quote: '2025 · MAR CIDB Certified — Grade G3', evidence_id: 'E1' },
  ];
  assert.equal(validateFindings({ observations }, [e]).accepted, true);
  assert.equal(validateFindings({ observations: [{ ...observations[0], value: '60 employees' }] }, [e]).accepted, false);
  const d = reconcile({ seed: { name: 'Acme' }, identity: { status: 'locked' }, evidence: [e], runs: [{ lane: 'G3', status: 'ok', findings: { observations } }], startedAt: new Date().toISOString() });
  assert.equal(d.scale.headcount.value, null); assert.equal(d.observations.length, 2);
  const html = renderDossier(d, 'html');
  assert.match(html, /Operations, projects &amp; credentials|Operations, projects & credentials/);
  assert.match(html, /60\+ Staff &amp; contractors/); assert.match(html, /href="#source-1"/);
});

test('paired modern/legacy SSM forms agree but unpaired identifiers still conflict', () => {
  const modern = '202301029164', legacy = '1523087-A';
  const evidence = [evidenceRecord({ id: 'E1', url: 'https://acme.example/', tier: 3, text: `Reg No: ${modern} / ${legacy}` })];
  const claims = [modern, legacy].map(value => ({ field: 'ssm_no', value, evidence_id: 'E1', quote: evidence[0].text }));
  assert.equal(fact(claims, evidence).value, modern); assert.equal(fact(claims, evidence).status, 'self_reported');
  evidence[0].text = `Reg No: ${modern}. Another company: ${legacy}`;
  const separate = claims.map(claim => ({ ...claim, quote: evidence[0].text }));
  assert.equal(fact(separate, evidence).status, 'conflicting');
});

test('later findings remove obsolete missing-field notes but preserve conflict and verification notes', () => {
  const e = evidenceRecord({ id: 'E1', url: 'https://acme.example/', tier: 3, text: 'Acme sells solar installations. Gan is CEO. RM1,000,000 paid-up capital.' });
  const runs = [{ lane: 'G1', findings: { unknowns: ['people', 'buyers', 'paid_up_capital (not found)', 'paid_up_capital: conflicting sources', 'registered_address: not explicitly stated'] } }, { lane: 'G2', findings: { people: [{ name: 'Gan', role: 'CEO', quote: 'Gan is CEO.', evidence_id: 'E1' }], facts: [{ field: 'paid_up_capital', value: 'RM1,000,000', quote: 'RM1,000,000 paid-up capital.', evidence_id: 'E1' }] } }];
  const d = reconcile({ seed: { name: 'Acme' }, identity: { status: 'locked' }, evidence: [e], runs, startedAt: new Date().toISOString() });
  assert.equal(d.unknowns.includes('people'), false); assert.equal(d.unknowns.includes('paid_up_capital (not found)'), false);
  assert.ok(d.unknowns.includes('paid_up_capital: conflicting sources')); assert.ok(d.unknowns.includes('buyers'));
});

test('a matching directory does not downgrade a company-published value to unknown', () => {
  const evidence = [3, 2].map((tier, i) => evidenceRecord({ id: 'E' + i, tier, url: i ? 'https://directory.example/' : 'https://acme.example/', text: 'Acme Company' }));
  const out = fact(evidence.map(e => ({ field: 'legal_name', value: 'Acme Company', quote: e.text, evidence_id: e.id })), evidence);
  assert.equal(out.status, 'self_reported'); assert.equal(out.value, 'Acme Company');
});
