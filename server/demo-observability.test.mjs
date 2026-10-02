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
    const admin = await demoObservability(path, params, { id: 'admin', role: 'admin' }, services);
    assert.equal(admin.userId, undefined);
  }
  assert.equal(await demoObservability('/api/demo/metrics', params, { id: 'me', role: 'user' }, services), null);
  assert.deepEqual(await demoObservability('/api/demo/metrics', params, { id: 'admin', role: 'admin' }, services), { metrics: true });
  await assert.rejects(demoObservability('/api/demo/usage', params, null, services), /Please sign in/);
});
