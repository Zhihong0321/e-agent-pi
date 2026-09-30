// Owner-only service. Never registered as an agent tool or SECURITY DEFINER SQL.
import { createHash } from 'node:crypto';
import { DiError } from './common.mjs';
import { seedTenantTx } from './seed.mjs';

// Children precede parents. Names are constants, never request data.
const DATA = ['form_submission','form_version','form','payment_allocation','payment',
  'document_line','document','attachment','package_item','package','product','contact','customer','company_member'];
const CONFIG = ['template','workflow_def','tax_code'];
const SNAPSHOT = [...DATA,...CONFIG,'document_sequence','company_profile','onboarding_progress','field_def','entity_def'];

async function snapshot(tx, tenantId) {
  const out = {};
  for (const table of SNAPSHOT) {
    out[table] = (await tx.query(`SELECT * FROM di.${table} WHERE tenant_id=$1 ORDER BY id`, [tenantId])).rows;
  }
  return out;
}
const digest = (data, restoreDefaults) => createHash('sha256').update(JSON.stringify({ data, restoreDefaults })).digest('hex');

export async function previewCompanyReset(db, tenantId, restoreDefaults = false) {
  return db.transaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const data = await snapshot(tx, tenantId);
    if (!data.company_profile.length) throw new DiError('Company not found');
    return {
      tenant_id: tenantId, company_name: data.company_profile[0].name,
      fingerprint: digest(data, restoreDefaults), restore_defaults: restoreDefaults,
      counts: Object.fromEntries([...DATA,...(restoreDefaults ? CONFIG : [])].map(t => [t, data[t].length])),
      confirmation: `RESET ${tenantId}`,
      preserved: ['Schema and migrations','Tenant and access controls','Custom field definitions','Audit history','Recovery snapshot'],
      files: 'Uploaded files and generated PDFs remain on disk for recovery; their business-record links are removed. This is a data reset, not secure file erasure.',
    };
  });
}

export async function resetCompany(db, tenantId, { fingerprint, confirmation, restore_defaults = false } = {}) {
  if (confirmation !== `RESET ${tenantId}` || !fingerprint) throw new DiError('Preview and confirm the company reset first');
  return db.transaction(async tx => {
    // Lock all touched tables before taking the snapshot. This also blocks public form
    // submissions and direct SQL writers. Trigger changes roll back on any failure.
    await tx.query("SET LOCAL lock_timeout = '10s'");
    await tx.query(`LOCK TABLE ${[...SNAPSHOT,'audit_log'].sort().map(t => `di.${t}`).join(',')} IN ACCESS EXCLUSIVE MODE`);
    await tx.query("SELECT set_config('di.tenant_id',$1,true),set_config('di.actor','owner',true),set_config('di.agent','company-reset',true)", [tenantId]);
    const data = await snapshot(tx, tenantId);
    if (digest(data, restore_defaults) !== fingerprint) throw new DiError('Data changed since the preview. Preview the reset again.', { code: 'conflict' });
    const backup = (await tx.query('INSERT INTO di.reset_backup (tenant_id,actor,snapshot) VALUES ($1,$2,$3) RETURNING id', [tenantId,'owner',JSON.stringify(data)])).rows[0];
    for (const table of [...DATA,...(restore_defaults ? CONFIG : []),'onboarding_progress']) {
      await tx.query(`ALTER TABLE di.${table} DISABLE TRIGGER di_no_delete`);
      await tx.query(`DELETE FROM di.${table} WHERE tenant_id=$1`, [tenantId]);
      await tx.query(`ALTER TABLE di.${table} ENABLE TRIGGER di_no_delete`);
    }
    await tx.query(`UPDATE di.document_sequence SET next_number=1,current_year=NULL WHERE tenant_id=$1`, [tenantId]);
    await tx.query(`UPDATE di.company_profile SET name='',legal_name=NULL,reg_no=NULL,tin=NULL,sst_no=NULL,
      msic_code=NULL,business_activity=NULL,business_type=NULL,customer_type=NULL,country=NULL,timezone=NULL,
      language='en',address='{}',phone=NULL,email=NULL,website=NULL,currency='',logo_url=NULL,bank_details=NULL,
      payment_terms_days=NULL,payment_instructions=NULL,tax_status=NULL,invoice_reference=NULL,
      settings='{}',evidence='{}',revision=revision+1 WHERE tenant_id=$1`, [tenantId]);
    await seedTenantTx(tx, tenantId);
    await tx.query(`INSERT INTO di.audit_log (tenant_id,actor,agent,action,entity,entity_id,after)
      VALUES ($1,'owner','company-reset','reset','company_profile',$2,$3)`,
      [tenantId, data.company_profile[0].id, JSON.stringify({ backup_id: backup.id, restore_defaults })]);
    return { ok: true, backup_id: backup.id, minimum_ready: false, form_url: '/company-profile/',
      files_retained_for_recovery: true };
  });
}
