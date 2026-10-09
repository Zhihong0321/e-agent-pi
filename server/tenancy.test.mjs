import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeAccess } from './route-access.mjs';
import { agentWorkspace, isPlatformAgent } from './paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = '1739a61f-08a2-4112-b7f9-601111e8b949';
const B = '9baf99c3-0085-4532-b023-b2a5bbb47329';

test('a route nobody listed is operator-only', () => {
  for (const route of ['/api/metrics', '/api/debug', '/api/git', '/api/host', '/api/skills',
    '/api/mcp', '/api/blueprints', '/api/models/test', '/api/host', '/api/something-new', '/api/agents/orchestrator', '/api/ads-research/jobs']) {
    assert.equal(routeAccess(route, 'GET'), 'operator', route);
  }
  assert.equal(routeAccess('/api/model', 'POST'), 'operator');
  assert.equal(routeAccess('/api/agents', 'POST'), 'operator');
});

test('user routes are the ones company users need', () => {
  for (const [route, method] of [['/api/chat', 'POST'], ['/api/messages', 'GET'], ['/api/sessions', 'GET'], ['/api/sessions/abc', 'PATCH'],
    ['/api/agents', 'GET'], ['/api/models', 'GET'], ['/api/demo/state', 'GET'], ['/api/schedules', 'GET'], ['/api/media-kit', 'GET'],
    ['/api/execution/runs', 'GET'], ['/api/company-research/dossiers', 'GET'], ['/api/files', 'GET'], ['/api/files/raw', 'GET']]) {
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

async function sources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'test') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sources(full));
    else if (/\.mjs$/.test(entry.name) && !/\.test\.mjs$|live-eval\.mjs$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('no code reads a process-wide default company', async () => {
  const allowedOperator = new Set(['server/tenancy.mjs', 'document_inteligence/host.mjs']);
  const offenders = [];
  for (const file of [...await sources(path.join(ROOT, 'server')), ...await sources(path.join(ROOT, 'document_inteligence'))]) {
    const rel = path.relative(ROOT, file).replaceAll('\\', '/');
    const text = await readFile(file, 'utf8');
    if (/companyHostContext/.test(text)) offenders.push(`${rel}: companyHostContext`);
    if (/\boperatorTenantId\b/.test(text) && !allowedOperator.has(rel)) offenders.push(`${rel}: operatorTenantId`);
    if (/state\.tenantId/.test(text)) offenders.push(`${rel}: state.tenantId`);
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
