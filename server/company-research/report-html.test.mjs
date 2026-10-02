import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, renderDossier, evidenceRecord } from './core.mjs';

test('designed report escapes hostile content, links contact evidence and preserves unknowns', () => {
  const text = 'Acme Solar email sales@acme.example. We offer solar installation.';
  const e = evidenceRecord({ id: 'E1', url: 'https://acme.example/contact', tier: 3, lane: 'C', text });
  const d = reconcile({ seed: { name: 'Acme <script>alert(1)</script>', website: 'https://acme.example/' }, identity: { status: 'locked' }, evidence: [e], runs: [{ lane: 'G2', findings: { facts: [{ field: 'email', value: 'sales@acme.example', evidence_id: 'E1', quote: text }] } }], startedAt: '2026-10-02T00:00:00Z' }, new Date('2026-10-02T00:01:00Z'));
  d.people = [{ status: 'self_reported', value: { name: '<img src=x onerror=alert(1)>', role: 'Director' }, evidence: [{ id: 'E2', url: 'javascript:alert(1)', quote: '<script>alert(1)</script>' }] }];
  const html = renderDossier(d, 'html');
  assert.match(html, /Company intelligence report/);
  assert.match(html, /href="#source-2"/); // contact-only source indexed after person citation
  assert.match(html, /sales@acme\.example/);
  assert.match(html, /0%/);
  assert.match(html, /Not established/);
  assert.match(html, /does not establish a clean record/);
  assert.doesNotMatch(html, /<script|<img|href="javascript:/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /@media\(max-width:700px\)/);
  assert.match(html, /@media print/);
  assert.match(html, /noindex,nofollow/);
});
