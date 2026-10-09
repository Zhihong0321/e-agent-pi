// Handlers that move files, tokens and agent grants across the company boundary.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { Writable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { handleFileSharing, fileSharingEnv } from './file-sharing.mjs';
import { publishFile } from './shared-files.mjs';
import { mediaAiEnv, mediaAiTenantFrom } from './media-ai/auth.mjs';
import { assignedAgentIds, userAssignedAgent } from './agent-access.mjs';
import { tenantForRequest, tenantOf, tenantFromRun, setOperatorTenant, TenantRequired } from './tenancy.mjs';

const A = '1739a61f-08a2-4112-b7f9-601111e8b949';
const B = '9baf99c3-0085-4532-b023-b2a5bbb47329';
const OP = 'd0ac1f92-0000-4000-8000-000000000000';
setOperatorTenant(OP);

function fakeRes() {
  const chunks = [];
  const res = new Writable({ write(chunk, _enc, done) { chunks.push(chunk); done(); } });
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  const end = res.end.bind(res);
  res.end = (data) => { if (data) chunks.push(Buffer.from(data)); end(); };
  res.text = () => Buffer.concat(chunks).toString('utf8');
  res.done = new Promise((resolve) => res.on('finish', resolve));
  return res;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tenant-files-'));
  const workspaceA = path.join(root, 'ws', A);
  await mkdir(workspaceA, { recursive: true });
  await writeFile(path.join(workspaceA, 'quote.txt'), 'alpha-only secret');
  const published = await publishFile({ root: path.join(root, 'files'), companyId: A, workspace: workspaceA, source: 'quote.txt' });
  const ctx = (user) => ({
    root: path.join(root, 'files'), publicUrl: 'https://app.test', user,
    authorized: (req) => req.headers.authorization === 'Bearer operator',
    readBody: async (req) => req.body,
    companyId: (req, who, named) => named || tenantForRequest(req, who),
    workspaceFor: async (_agent, tenantId) => (tenantId === A ? workspaceA : tenantId ? path.join(root, 'ws', tenantId) : path.join(root, 'ws', 'platform')),
  });
  return { root, published, ctx };
}

const get = (urlPath, headers = {}) => ({ req: { method: 'GET', headers }, url: new URL(urlPath, 'http://local') });

test('a shared file is readable only by its own company', async () => {
  const { published, ctx } = await fixture();
  const urlPath = new URL(published.url, 'http://local').pathname;
  const read = async (user, headers) => {
    const { req, url } = get(urlPath, headers);
    const res = fakeRes();
    await handleFileSharing(req, res, url, ctx(user));
    await res.done;
    return res;
  };
  const anonymous = await read(null);
  assert.equal(anonymous.status, 401);
  const owner = await read({ id: 'u1', company_tenant_id: A });
  assert.equal(owner.status, 200);
  assert.equal(owner.text(), 'alpha-only secret');
  const other = await read({ id: 'u2', company_tenant_id: B });
  assert.equal(other.status, 404, 'another company cannot read it, even with the exact link');
  const operatorNamingA = await read(null, { authorization: 'Bearer operator', 'x-tenant-id': A });
  assert.equal(operatorNamingA.text(), 'alpha-only secret');
  const operatorNamingB = await read(null, { authorization: 'Bearer operator', 'x-tenant-id': B });
  assert.equal(operatorNamingB.status, 404);
});

test('a run can publish only into the company its token was issued for', async () => {
  const { root, ctx } = await fixture();
  const share = async (agent, claimedTenant, token) => {
    const body = JSON.stringify({ agent, tenant: claimedTenant, path: 'quote.txt' });
    const req = { method: 'POST', headers: { authorization: `Bearer ${token}` }, body };
    const res = fakeRes();
    await handleFileSharing(req, res, new URL('/api/internal/files/share', 'http://local'), ctx(null));
    await res.done;
    return res;
  };
  const tokenA = fileSharingEnv('orchestrator', 8080, A).FILE_SHARE_TOKEN;
  const ok = await share('orchestrator', A, tokenA);
  assert.equal(ok.status, 200);
  const forged = await share('orchestrator', B, tokenA);
  assert.equal(forged.status, 401, "company A's token cannot publish as company B");
  const noTenant = await share('orchestrator', '', tokenA);
  assert.equal(noTenant.status, 401, 'dropping the tenant does not fall back to a shared folder');
  assert.ok(root);
});

test('media helper tokens are bound to one company', () => {
  const envA = mediaAiEnv('media-ai', {}, A);
  const reqA = { headers: { authorization: `Bearer ${envA.MEDIA_AI_TOKEN}` } };
  assert.equal(envA.MEDIA_AI_TENANT, A);
  assert.equal(mediaAiTenantFrom(reqA, A), A);
  assert.equal(mediaAiTenantFrom(reqA, B), null, 'a token cannot be reused for another company');
  assert.equal(mediaAiTenantFrom(reqA, ''), null);
  assert.deepEqual(mediaAiEnv('media-ai', {}, ''), {}, 'no company, no credentials');
  assert.deepEqual(mediaAiEnv('orchestrator', {}, A), {});
});

test('tenant resolution never falls back for a signed-in user', () => {
  assert.equal(tenantOf({ company_tenant_id: A }), A);
  assert.throws(() => tenantOf({ company_tenant_id: '' }), TenantRequired);
  assert.throws(() => tenantOf(null), TenantRequired);
  assert.throws(() => tenantFromRun({ companyId: null }), TenantRequired);
  // A user request ignores the operator header; the operator without a name gets the operator company.
  assert.equal(tenantForRequest({ headers: { 'x-tenant-id': B } }, { company_tenant_id: A }), A);
  assert.equal(tenantForRequest({ headers: {} }, null), OP);
  assert.equal(tenantForRequest({ headers: { 'x-tenant-id': B } }, null), B);
});

test('platform agents are never granted to a company login, whatever the table says', async () => {
  const grants = new Map([['u1', ['orchestrator', 'website', 'proposal', 'di-documents', 'ads-research']]]);
  const pool = {
    query: async (sql, params) => {
      if (sql.startsWith('SELECT agent_id')) return { rows: (grants.get(params[0]) || []).map((agent_id) => ({ agent_id })) };
      return { rows: (grants.get(params[0]) || []).includes(params[1]) ? [{}] : [] };
    },
  };
  assert.deepEqual(await assignedAgentIds('u1', pool), ['orchestrator', 'di-documents']);
  assert.equal(await userAssignedAgent('u1', 'di-documents', pool), true);
  assert.equal(await userAssignedAgent('u1', 'website', pool), false);
  assert.equal(await userAssignedAgent('u1', 'ads-research', pool), false);
  assert.equal(await userAssignedAgent('u2', 'orchestrator', pool), false);
});
