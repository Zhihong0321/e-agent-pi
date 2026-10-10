import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { routeAccess } from './route-access.mjs';
import { agentWorkspace, isPlatformAgent } from './paths.mjs';
import * as kernel from './tenancy.mjs';
import { tenantForRequest, tenantOf, requireTenant, TenantRequired } from './tenancy.mjs';
import { migrate, pgliteAdapter } from '../document_inteligence/core/db.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = '1739a61f-08a2-4112-b7f9-601111e8b949';
const B = '9baf99c3-0085-4532-b023-b2a5bbb47329';

test('the kernel exports no process-wide default company', () => {
  assert.equal('operatorTenantId' in kernel, false);
  assert.equal('setOperatorTenant' in kernel, false);
  assert.equal('tenantOfOwner' in kernel, false);
});

test('an operator request with no company is refused, never served from a default', () => {
  assert.throws(() => tenantForRequest({ headers: {} }, null), TenantRequired);
  assert.equal(tenantForRequest({ headers: { 'x-tenant-id': B } }, null), B);
});

test('a signed-in user is always scoped to their own company, whatever header they send', () => {
  assert.equal(tenantForRequest({ headers: { 'x-tenant-id': B } }, { company_tenant_id: A }), A);
  assert.throws(() => tenantForRequest({ headers: {} }, { company_tenant_id: '' }), TenantRequired);
  assert.throws(() => tenantOf({ company_tenant_id: null }), TenantRequired);
});

test('a row with no owner and no stored company has no tenant', () => {
  assert.throws(() => requireTenant(null, 'chat'), TenantRequired);
  assert.throws(() => requireTenant('  ', 'chat'), TenantRequired);
});

test('a fresh database has no company', async () => {
  const db = pgliteAdapter(new PGlite());
  await migrate(db);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM di.tenant')).rows[0].n, 0);
});

test('a route nobody listed is operator-only', () => {
  for (const route of ['/api/metrics', '/api/debug', '/api/git', '/api/host', '/api/skills',
    '/api/mcp', '/api/blueprints', '/api/models/test', '/api/host', '/api/something-new', '/api/agents/orchestrator']) {
    assert.equal(routeAccess(route, 'GET'), 'operator', route);
  }
  assert.equal(routeAccess('/api/model', 'POST'), 'operator');
  assert.equal(routeAccess('/api/agents', 'POST'), 'operator');
});

test('user routes are the ones company users need', () => {
  for (const [route, method] of [['/api/chat', 'POST'], ['/api/messages', 'GET'], ['/api/sessions', 'GET'], ['/api/sessions/abc', 'PATCH'],
    ['/api/agents', 'GET'], ['/api/models', 'GET'], ['/api/demo/state', 'GET'], ['/api/schedules', 'GET'], ['/api/media-kit', 'GET'],
    ['/api/execution/runs', 'GET'], ['/api/company-research/dossiers', 'GET'], ['/api/files', 'GET'], ['/api/files/raw', 'GET'], ['/api/ads-research/jobs', 'POST']]) {
    assert.equal(routeAccess(route, method), 'user', `${method} ${route}`);
  }
});

test('public routes are login, health, form links and token-checked worker bridges', () => {
  for (const route of ['/api/health', '/api/auth/login', '/api/demo/login', '/api/forms/x/y', '/api/internal/execution/tool',
    '/api/internal/files/share', '/api/internal/media-ai', '/api/stock']) {
    assert.equal(routeAccess(route, 'POST'), 'public', route);
  }
  assert.equal(routeAccess('/demo', 'GET'), 'public');
  assert.equal(routeAccess('/files/abc/x.pdf', 'GET'), 'public');
});

test('a company agent has no workspace without a company, and one per company with it', () => {
  assert.throws(() => agentWorkspace({ id: 'orchestrator', slug: 'orchestrator' }), /company tenant/);
  assert.throws(() => agentWorkspace({ id: 'di-expenses', slug: 'di-expenses' }, ''), /company tenant/);
  const a = agentWorkspace({ id: 'orchestrator', slug: 'orchestrator' }, A);
  const b = agentWorkspace({ id: 'orchestrator', slug: 'orchestrator' }, B);
  assert.notEqual(a, b);
  assert.ok(a.includes(A) && !a.includes(B));
  assert.throws(() => agentWorkspace({ id: 'orchestrator', slug: 'orchestrator' }, '../x'), /Invalid company tenant/);
});

test('a platform agent keeps one workspace whatever company asks', () => {
  assert.equal(isPlatformAgent('website'), true);
  assert.equal(agentWorkspace({ id: 'proposal', slug: 'proposal' }), agentWorkspace({ id: 'proposal', slug: 'proposal' }, A));
  assert.equal(isPlatformAgent('di-documents'), false);
  assert.equal(isPlatformAgent('orchestrator'), false);
});

const PURGE = [
  /host company|host tenant|companyhostcontext|hostcompany|host scope|host-scoped|operator tenant|operatortenant|setoperatortenant|bootstrap (company|tenant)|ensuredefaulttenant|default tenant|ensurepeopletenant|apex solar|d0ac1f92|state\.tenantid/i,
  /My Company/,
];
const SKIP_DIRS = new Set(['node_modules', 'archive', 'test-results']);
const SKIP_FILES = new Set(['prompt-remove-host-company.md', 'document_inteligence/sql/003_company_profile.sql', 'server/tenancy.test.mjs']);
const RECORDED_RUNS = ['tests/multitenant/evidence/', 'document_inteligence/test-results/'];

async function textFiles(dir, rel = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await textFiles(path.join(dir, entry.name), relPath));
    else if (/\.(mjs|ts|tsx|md|json|sql|sh)$/.test(entry.name) && !SKIP_FILES.has(relPath) && !RECORDED_RUNS.some((p) => relPath.startsWith(p))) out.push(relPath);
  }
  return out;
}

test('no code, test, doc or graft node names a default company', async () => {
  const offenders = [];
  for (const rel of await textFiles(ROOT)) {
    const lines = (await readFile(path.join(ROOT, rel), 'utf8')).split('\n');
    lines.forEach((line, i) => { if (PURGE.some((re) => re.test(line))) offenders.push(`${rel}:${i + 1}`); });
  }
  assert.deepEqual(offenders, []);
});

test('every API call the company-facing screens make is open to a signed-in company user', async () => {
  const screens = [
    ...(await readdir(path.join(ROOT, 'app', 'demo'))).filter((f) => /\.tsx?$/.test(f)).map((f) => path.join('app', 'demo', f)),
    'app/media-kit.tsx', 'app/db-log.tsx',
  ];
  const blocked = [];
  for (const file of screens) {
    const text = await readFile(path.join(ROOT, file), 'utf8');
    for (const match of text.matchAll(/["'`](\/api\/[a-zA-Z0-9_/-]*)/g)) {
      const route = match[1];
      if (routeAccess(route, 'GET') === 'operator' || routeAccess(route, 'POST') === 'operator') blocked.push(`${file}: ${route}`);
    }
  }
  assert.deepEqual(blocked, []);
});
