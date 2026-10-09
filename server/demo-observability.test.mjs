import test from 'node:test';
import assert from 'node:assert/strict';
import { demoObservability } from './demo-observability.mjs';

test('demo insights force account scope and reject privilege parameters', async () => {
  const services = Object.fromEntries(['chatLogs', 'usageReport', 'listActivity', 'metricsPayload'].map(name => [name, async options => options || { metrics: true }]));
  const params = new URLSearchParams({ userId: 'someone-else', isAdmin: 'true', search: 'receipt' });
  for (const path of ['/api/demo/chat-logs', '/api/demo/usage', '/api/demo/activity']) {
    const data = await demoObservability(path, params, { id: 'me', role: 'user' }, services);
    assert.equal(data.userId, 'me');
    if (path.endsWith('/activity')) assert.equal(data.isAdmin, false);
    const admin = await demoObservability(path, params, { id: 'admin', role: 'admin', company_tenant_id: 'co-a' }, services);
    assert.equal(admin.userId, undefined);
  }
  assert.equal(await demoObservability('/api/demo/metrics', params, { id: 'me', role: 'user' }, services), null);
  assert.deepEqual(await demoObservability('/api/demo/metrics', params, { id: 'admin', role: 'admin', company_tenant_id: 'co-a' }, services), { metrics: true });
  await assert.rejects(demoObservability('/api/demo/usage', params, null, services), /Please sign in/);
});

test('DB Log is admin-only and never accepts caller-provided account scope', async () => {
  let calls = 0;
  const services = { listDbAudit: async (options, user) => { calls++; return { options, user }; } };
  const params = new URLSearchParams({ userId: 'admin', isAdmin: 'true', search: 'INV-001' });
  assert.equal(await demoObservability('/api/demo/db-log', params, { id: 'me', role: 'user' }, services), null);
  assert.equal(calls, 0);
  const admin = { id: 'real-admin', role: 'admin', company_tenant_id: 'co-a' };
  const result = await demoObservability('/api/demo/db-log', params, admin, services);
  assert.equal(result.user, admin);
  assert.equal(result.options.search, 'INV-001');
});
