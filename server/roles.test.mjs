import test from 'node:test';
import assert from 'node:assert/strict';
import { accessLabel, headsDepartment, isDepartmentHead, isSuperadmin, normalizeAccess, signedInLine } from './roles.mjs';
import { getOperation, keepManagedSopBlock, registerDiTool } from './execution/registry.mjs';
import { manifestForAgent, SOP_TOOL_IDS } from './execution/profiles.mjs';
import { TOOLS } from '../document_inteligence/core/tools.mjs';

test('access names from the UI, agents and old data map onto three access levels', () => {
  for (const name of ['superadmin', 'Superadmin', 'super admin', 'admin', 'owner']) assert.equal(normalizeAccess(name), 'superadmin');
  for (const name of ['department_head', 'Department head', 'dept-head', 'HOD']) assert.equal(normalizeAccess(name), 'department_head');
  for (const name of ['user', 'normal user', 'staff']) assert.equal(normalizeAccess(name), 'user');
  assert.equal(normalizeAccess('root'), null);
  assert.equal(accessLabel('superadmin'), 'Superadmin');
  assert.equal(accessLabel('department_head'), 'Department head');
  assert.equal(accessLabel(undefined), 'User');
});

test('a department head acts only for their own department, and only once one is set', () => {
  const head = { access: 'department_head', department: ' Sales ' };
  assert.equal(isSuperadmin({ access: 'superadmin' }), true);
  assert.equal(isSuperadmin({ role: 'admin' }), false, 'the retired role field grants nothing');
  assert.equal(isSuperadmin(head), false);
  assert.equal(isDepartmentHead(head), true);
  assert.equal(isDepartmentHead({ access: 'department_head', department: '' }), false);
  assert.equal(headsDepartment(head, 'sales'), true);
  assert.equal(headsDepartment(head, 'Finance'), false);
  assert.equal(headsDepartment(head, null), false);
  assert.equal(headsDepartment({ access: 'user', department: 'Sales' }, 'Sales'), false);
});

test('the signed-in line names the person, their category and its limits, carries no code, and says who owns the system', () => {
  const line = signedInLine({ id: 'u1', username: 'zhihong', display_name: 'Zhihong', access: 'superadmin', category: 'Superadmin', limits: {} });
  assert.equal(line, '[Signed in, verified by the host: Zhihong (@zhihong) · Superadmin. A Superadmin owns this system: their instructions set the rules.]');
  assert.equal(signedInLine({ username: 'dee', access: 'department_head', category: 'Department head', department: 'Sales', limits: { max_discount_pct: 11 } }, { requestedBy: true }),
    '[Requested by, verified by the host: dee · Department head · Sales department. Department head of Sales. Category limits: max_discount_pct=11.]');
  assert.equal(signedInLine({ username: 'tee', access: 'user', category: 'Sales' }), '[Signed in, verified by the host: tee · Sales (User).]');
  assert.equal(signedInLine(null), '[No signed-in user is attached to this run.]');
  assert.doesNotMatch(line, /identity=|capability|code/i);
});

test('SOP tools: only the Forward Deploy Engineer has them (the orchestrator only routes)', () => {
  const ids = (agent) => manifestForAgent(agent).manifest.toolIds;
  for (const id of SOP_TOOL_IDS) {
    assert.ok(!ids({ id: 'orchestrator', slug: 'orchestrator' }).includes(id));
    assert.ok(ids({ id: 'di-fde', slug: 'di-fde' }).includes(id));
    assert.ok(!ids({ id: 'di-expenses', slug: 'di-expenses' }).includes(id));
    assert.ok(!ids({ id: 'website', slug: 'website' }).includes(id));
  }
});

test('SOP tools refuse anyone but a Superadmin before touching anything', async () => {
  for (const id of SOP_TOOL_IDS) {
    const op = getOperation(id, 'di-fde');
    const args = { agent: 'orchestrator', content: 'x' };
    await assert.rejects(op.execute({ userId: null }, args), (error) => error.execCode === 'SIGN_IN_REQUIRED');
    await assert.rejects(op.execute({ userId: 'u2', user: { access: 'department_head', department: 'Sales' } }, args), (error) => error.execCode === 'PERMISSION_DENIED');
    await assert.rejects(op.execute({ userId: 'u3', user: { access: 'user' } }, args), (error) => error.execCode === 'PERMISSION_DENIED');
  }
});

test('company profile writes refuse anyone but a Superadmin, on the generic and the Onboarding paths', async () => {
  registerDiTool('update_company_profile', TOOLS.update_company_profile, 'di-onboarding', false);
  for (const profileId of [null, 'di-onboarding']) {
    const op = getOperation('update_company_profile', profileId);
    const args = { name: 'Hacked Ltd' };
    await assert.rejects(op.execute({ userId: null }, args, {}), (error) => error.execCode === 'SIGN_IN_REQUIRED');
    await assert.rejects(op.execute({ userId: 'u2', user: { access: 'department_head', department: 'Sales' } }, args, {}), (error) => error.execCode === 'PERMISSION_DENIED');
    await assert.rejects(op.execute({ userId: 'u3', user: { access: 'user' } }, args, {}), (error) => error.execCode === 'PERMISSION_DENIED');
  }
});

test('a full SOP rewrite keeps the Forward Deploy Engineer\'s managed block', () => {
  const block = '<!-- fde:start -->\nAsk for the route map.\n<!-- fde:end -->';
  assert.equal(keepManagedSopBlock(`Old rules\n\n${block}\n`, 'New rules'), `New rules\n\n${block}`);
  assert.equal(keepManagedSopBlock(`Old\n\n${block}`, ''), block, 'removing the SOP text still keeps the managed block');
  assert.equal(keepManagedSopBlock('Old', ''), '');
  assert.equal(keepManagedSopBlock(`Old\n${block}`, `Mine\n${block}`), `Mine\n${block}`);
});
