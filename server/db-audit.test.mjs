import test from 'node:test';
import assert from 'node:assert/strict';
import { listDbAudit } from './db-audit.mjs';

test('DB Log refuses non-admins and admins without a company', async () => {
  await assert.rejects(listDbAudit({}, { role: 'user', company_tenant_id: 'co-a' }), /Admin access required/);
  await assert.rejects(listDbAudit({}, { role: 'admin' }), /Company tenant is required/);
});
