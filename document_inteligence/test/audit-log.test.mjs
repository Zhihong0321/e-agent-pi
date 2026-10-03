import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrate, pgliteAdapter, withContext } from '../core/db.mjs';
import { auditChanges, financialAuditLog } from '../core/audit-log.mjs';
import { runTool } from '../core/actions.mjs';

test('financial history records creators, edits and line changes; isolates tenants and survives rollback', async () => {
  const pg = new PGlite();
  const db = pgliteAdapter(pg);
  try {
    await migrate(db);
    const a = (await db.query("INSERT INTO di.tenant(name) VALUES ('A') RETURNING id")).rows[0].id;
    const b = (await db.query("INSERT INTO di.tenant(name) VALUES ('B') RETURNING id")).rows[0].id;
    const as = (tenantId, actor, fn) => withContext(db, { tenantId, actor, agent: 'di-documents' }, fn);
    const invoice = await as(a, 'alice', async tx => (await tx.query("INSERT INTO di.document(doc_type,number,total,notes) VALUES ('invoice','INV-001',100,'Original') RETURNING id")).rows[0].id);
    await as(b, 'bob', tx => tx.query("INSERT INTO di.document(doc_type,number,total) VALUES ('invoice','INV-PRIVATE',999)"));
    await as(a, 'alice', tx => tx.query("INSERT INTO di.document_line(document_id,description,unit_price) VALUES ($1,'Service',100)", [invoice]));
    await as(a, 'carol', tx => tx.query("UPDATE di.document SET total=150, notes=NULL WHERE id=$1", [invoice]));
    await as(a, 'carol', tx => tx.query("UPDATE di.document SET total=total WHERE id=$1", [invoice]));
    const read = options => as(a, 'admin', tx => financialAuditLog(tx, a, options));
    let history = await read();
    assert.equal(history.entries.length, 3, 'no-op updates and unrelated tenant/company events are excluded');
    const edit = history.entries.find(row => row.action === 'update');
    assert.equal(edit.actor, 'carol');
    assert.deepEqual(edit.changes.total, { from: 100, to: 150 });
    assert.deepEqual(edit.changes.notes, { from: 'Original', to: null });
    assert.equal(history.entries.find(row => row.entity === 'document' && row.action === 'insert').actor, 'alice');
    assert.equal(history.entries.find(row => row.entity === 'document_line').reference, 'INV-001');
    assert.equal((await read({ search: 'INV-001' })).entries.length, 3);
    assert.equal((await read({ actor: 'carol', action: 'update' })).entries.length, 1);
    const first = await read({ limit: 1 });
    assert.ok(first.nextCursor);
    const second = await read({ limit: 1, before: first.nextCursor });
    assert.notEqual(first.entries[0].id, second.entries[0].id);
    await assert.rejects(as(a, 'carol', async tx => {
      await tx.query('UPDATE di.document SET total=200 WHERE id=$1', [invoice]);
      throw new Error('cancel transaction');
    }), /cancel transaction/);
    assert.equal((await read()).entries.length, 3);
    await assert.rejects(db.query("UPDATE di.audit_log SET actor='forged' WHERE id=$1", [edit.id]), /cannot be edited/);
    await assert.rejects(db.query('DELETE FROM di.audit_log WHERE id=$1', [edit.id]), /delete|Delete|DELETE/);
    await assert.rejects(as(a, 'forged', tx => tx.query("INSERT INTO di.audit_log(tenant_id,actor,action,entity) VALUES ($1,'forged','insert','document')", [a])), /record triggers/);
    await assert.rejects(read({ entity: 'media_kit_asset' }), /Invalid record type/);
    await assert.rejects(read({ before: '1 OR true' }), /Invalid cursor/);
    // Non-identity tools must also inherit the trusted UI/session actor.
    const customer = await as(a, 'alice', async tx => (await tx.query("INSERT INTO di.customer(code,name) VALUES ('CUS-AUDIT','Audit customer') RETURNING id")).rows[0].id);
    await runTool({ db, tenantId: () => a, who: { id: 'dave', username: 'dave' } }, {
      agent: 'di-documents', tool: 'create_draft', args: { doc_type: 'invoice', customer, lines: [] },
    });
    history = await read({ actor: 'dave' });
    assert.ok(history.entries.some(entry => entry.action === 'insert' && entry.entity === 'document'));
    assert.equal(history.entries[0].actorUserId, 'dave');
  } finally { await pg.close(); }
});

test('diff includes removed JSON fields and values without audit metadata noise', () => {
  assert.deepEqual(auditChanges({ total: 10, custom: { old: 1 }, notes: 'old', updated_at: 'a' },
    { total: 20, custom: { next: 2 }, updated_at: 'b' }), {
    total: { from: 10, to: 20 }, custom: { from: { old: 1 }, to: { next: 2 } }, notes: { from: 'old', to: null },
  });
});
