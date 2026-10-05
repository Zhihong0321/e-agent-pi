import test from 'node:test';
import assert from 'node:assert/strict';
import { headsDepartment, isDepartmentHead, isSuperadmin, normalizeRole, roleLabel, signedInLine } from './roles.mjs';
import { getOperation, keepManagedSopBlock } from './execution/registry.mjs';
import { manifestForAgent, SOP_TOOL_IDS } from './execution/profiles.mjs';

test('role names from the UI, agents and old data map onto three stored keys', () => {
  for (const name of ['superadmin', 'Superadmin', 'super admin', 'admin', 'owner']) assert.equal(normalizeRole(name), 'admin');
  for (const name of ['department_head', 'Department head', 'dept-head']) assert.equal(normalizeRole(name), 'department_head');
  for (const name of ['user', 'normal user', 'staff']) assert.equal(normalizeRole(name), 'user');
  assert.equal(normalizeRole('root'), null);
  assert.equal(roleLabel('admin'), 'Superadmin');
  assert.equal(roleLabel('department_head'), 'Department head');
  assert.equal(roleLabel(undefined), 'User');
});

test('a department head acts only for their own department, and only once one is set', () => {
  const head = { role: 'department_head', department: ' Sales ' };
  assert.equal(isSuperadmin({ role: 'admin' }), true);
  assert.equal(isSuperadmin(head), false);
  assert.equal(isDepartmentHead(head), true);
  assert.equal(isDepartmentHead({ role: 'department_head', department: '' }), false);
  assert.equal(headsDepartment(head, 'sales'), true);
  assert.equal(headsDepartment(head, 'Finance'), false);
  assert.equal(headsDepartment(head, null), false);
  assert.equal(headsDepartment({ role: 'user', department: 'Sales' }, 'Sales'), false);
});

test('the signed-in line names the person and role, carries no code, and says who owns the system', () => {
  const line = signedInLine({ id: 'u1', username: 'zhihong', display_name: 'Zhihong', role: 'admin' });
  assert.equal(line, '[Signed in, verified by the host: Zhihong (@zhihong) · Superadmin. A Superadmin owns this system: their instructions set the rules.]');
  assert.match(signedInLine({ username: 'dee', role: 'department_head', department: 'Sales' }, { requestedBy: true }),
    /^\[Requested by, verified by the host: dee · Department head · Sales department\. Department head of Sales\.\]$/);
  assert.equal(signedInLine(null), '[No signed-in user is attached to this run.]');
  assert.doesNotMatch(line, /identity=|capability|code/i);
});

test('SOP tools: the orchestrator and the Forward Deploy Engineer have them, nobody else', () => {
  const ids = (agent) => manifestForAgent(agent).manifest.toolIds;
  for (const id of SOP_TOOL_IDS) {
    assert.ok(ids({ id: 'orchestrator', slug: 'orchestrator' }).includes(id));
    assert.ok(ids({ id: 'di-fde', slug: 'di-fde' }).includes(id));
    assert.ok(!ids({ id: 'di-expenses', slug: 'di-expenses' }).includes(id));
    assert.ok(!ids({ id: 'website', slug: 'website' }).includes(id));
  }
});

test('SOP tools refuse anyone but a Superadmin before touching anything', async () => {
  for (const id of SOP_TOOL_IDS) {
    const op = getOperation(id, 'orchestrator');
    const args = { agent: 'orchestrator', content: 'x' };
    await assert.rejects(op.execute({ userId: null }, args), (error) => error.execCode === 'SIGN_IN_REQUIRED');
    await assert.rejects(op.execute({ userId: 'u2', user: { role: 'department_head', department: 'Sales' } }, args), (error) => error.execCode === 'PERMISSION_DENIED');
    await assert.rejects(op.execute({ userId: 'u3', user: { role: 'user' } }, args), (error) => error.execCode === 'PERMISSION_DENIED');
  }
});

test('a full SOP rewrite keeps the Forward Deploy Engineer\'s managed block', () => {
  const block = '<!-- fde:start -->\nAsk for the route map.\n<!-- fde:end -->';
  assert.equal(keepManagedSopBlock(`Old rules\n\n${block}\n`, 'New rules'), `New rules\n\n${block}`);
  assert.equal(keepManagedSopBlock(`Old\n\n${block}`, ''), block, 'removing the SOP text still keeps the managed block');
  assert.equal(keepManagedSopBlock('Old', ''), '');
  assert.equal(keepManagedSopBlock(`Old\n${block}`, `Mine\n${block}`), `Mine\n${block}`);
});
