import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrate, pgliteAdapter, withContext } from '../core/db.mjs';
import { seedTenant } from '../core/seed.mjs';
import { runTool } from '../core/actions.mjs';
import { previewCompanyReset, resetCompany } from '../core/reset.mjs';
import { companyDispatchGate } from '../../server/orchestrator.mjs';
import { handleCompanyProfile } from '../../server/company-profile.mjs';
import { handleDemoState, loadDemoState } from '../../server/demo-state.mjs';
import { readFile } from 'node:fs/promises';

test('company onboarding, concurrent updates, isolation and recoverable reset', async () => {
  const engine = new PGlite();
  const db = pgliteAdapter(engine);
  try {
    await migrate(db);
    const a = (await db.query("INSERT INTO di.tenant(name) VALUES ('My Company') RETURNING id")).rows[0].id;
    const b = (await db.query("INSERT INTO di.tenant(name) VALUES ('Other') RETURNING id")).rows[0].id;
    await seedTenant(db,a); await seedTenant(db,b);
    const call = (tool,args={},tenantId=a,agent='di-onboarding') => runTool({db,tenantId:()=>tenantId},{agent,tool,args});
    let p = await call('get_onboarding_status');
    assert.equal(p.company.name,''); assert.equal(p.readiness.minimum_ready,false);
    p = await call('update_company_profile',{name:'Real Company',country:'my',business_type:'services',business_activity:'Consulting',email:'hello@example.com',currency:'MYR',address:'1 Main Street',source:'invoice'});
    assert.equal(p.readiness.minimum_ready,false, 'extraction requires confirmation');
    p = await call('update_company_profile',{name:'Real Company',country:'MY',business_type:'services',business_activity:'Consulting',email:'hello@example.com',currency:'MYR',address:'1 Main Street',tax_status:'not_registered',expected_revision:p.company.revision});
    assert.equal(p.readiness.minimum_ready,true); assert.equal(p.readiness.invoice_profile_ready,true);
    assert.equal(p.company.address,'1 Main Street');
    const member = await call('save_company_member',{name:'Aisha Rahman',position:'Operations Manager',department:'Operations',email:'aisha@real.example',phone:'+60 12 345 6789'});
    assert.equal(member.member.department,'Operations');
    assert.equal((await call('list_company_members',{},a,'di-records')).members[0].position,'Operations Manager');
    await assert.rejects(call('save_company_member',{name:'Aisha R.',email:'AISHA@REAL.EXAMPLE'}),/already exists/);
    const revisedMember = await call('save_company_member',{id:member.member.id,position:'Head of Operations'});
    assert.equal(revisedMember.member.position,'Head of Operations');
    assert.deepEqual((await call('list_company_members',{},b)).members,[]);
    await call('save_company_member',{name:'Other Owner',department:'Management'},b);
    await assert.rejects(call('update_company_profile',{name:'Stale',expected_revision:1}),/changed/);
    await assert.rejects(call('update_company_profile',{name:'Web overwrite',source:'website'}),/confirmed/);
    await assert.rejects(call('update_company_profile',{website:'javascript:alert(1)'}),/http/);
    assert.equal((await call('get_company_profile',{},b)).company.name,'Other');
    await assert.rejects(withContext(db,{tenantId:a},tx=>tx.query('SELECT * FROM di.reset_backup')),/permission denied/);
    const customer = await call('save_customer',{name:'Demo Customer',billing_address:{line1:'Customer Road'}},a,'di-records');
    await call('update_company_profile',{payment_terms_days:30,payment_instructions:'Pay by transfer'});
    const draft = await call('create_draft',{doc_type:'invoice',customer:customer.customer.id,issue_date:'2026-09-01',lines:[{description:'Consulting',quantity:1,unit_price:100}]},a,'di-documents');
    assert.equal(String(draft.document.due_date).slice(0,10),'2026-10-01');
    await call('issue_document',{document:draft.document.id},a,'di-documents');
    await call('save_customer',{name:'Keep Me'},b,'di-records');
    const liveA=await loadDemoState({db,tenantId:a,asRole:true});
    const liveB=await loadDemoState({db,tenantId:b,asRole:true});
    assert.equal(liveA.profile.company.name,'Real Company');
    assert.equal(liveA.members[0].name,'Aisha Rahman');
    assert.equal(liveA.customers[0].name,'Demo Customer');
    assert.equal(liveA.invoices.length,1);
    assert.equal(liveB.invoices.length,0);
    assert.deepEqual(liveB.members.map(row=>row.name),['Other Owner']);
    await call('define_custom_field',{entity:'customer',key:'site',label:'Site',type:'text'});
    let preview=await previewCompanyReset(db,a);
    assert.equal(preview.counts.customer,1);
    assert.equal(preview.counts.company_member,1);
    await assert.rejects(resetCompany(db,a,{...preview,confirmation:'wrong'}),/confirm/);
    await call('update_company_profile',{phone:'12345'});
    await assert.rejects(resetCompany(db,a,preview),/changed/);
    preview=await previewCompanyReset(db,a);
    const result=await resetCompany(db,a,preview);
    assert.ok(result.backup_id);
    assert.equal((await call('find_customers')).customers.length,0);
    assert.deepEqual((await call('list_company_members')).members,[]);
    assert.equal((await call('list_company_members',{},b)).members.length,1);
    assert.equal((await call('find_customers',{},b)).customers.length,1);
    assert.equal((await call('get_onboarding_status')).readiness.minimum_ready,false);
    assert.equal((await db.query('SELECT count(*)::int n FROM di.field_def WHERE tenant_id=$1',[a])).rows[0].n,1);
    const snapshot=(await db.query('SELECT snapshot FROM di.reset_backup WHERE id=$1',[result.backup_id])).rows[0].snapshot;
    assert.equal(snapshot.customer[0].name,'Demo Customer');
    assert.equal(snapshot.company_member[0].name,'Aisha Rahman');
    await assert.rejects(db.query('DELETE FROM di.customer WHERE tenant_id=$1',[b]),/Hard delete/);
    preview=await previewCompanyReset(db,a,true);
    await resetCompany(db,a,preview);
    assert.equal((await db.query('SELECT count(*)::int n FROM di.template WHERE tenant_id=$1',[a])).rows[0].n,2);
    assert.deepEqual(await migrate(db),[]);
  } finally { await engine.close(); }
});

test('migration preserves existing company information and future tenants get profiles',async()=>{
  const engine=new PGlite(); const db=pgliteAdapter(engine);
  try {
    await db.exec(await readFile(new URL('../sql/001_core.sql',import.meta.url),'utf8'));
    await db.exec(await readFile(new URL('../sql/002_forms.sql',import.meta.url),'utf8'));
    const old=(await db.query("INSERT INTO di.tenant(name,legal_name,bank_details,address) VALUES ('Legacy','Legacy Ltd','Bank 123','{\"line1\":\"Old Road\"}') RETURNING id")).rows[0];
    await db.exec(await readFile(new URL('../sql/003_company_profile.sql',import.meta.url),'utf8'));
    const p=(await db.query('SELECT * FROM di.company_profile WHERE tenant_id=$1',[old.id])).rows[0];
    assert.equal(p.legal_name,'Legacy Ltd');assert.equal(p.bank_details,'Bank 123');assert.equal(p.address.line1,'Old Road');
    const next=(await db.query("INSERT INTO di.tenant(name) VALUES ('Future') RETURNING id")).rows[0];
    assert.equal((await db.query('SELECT name FROM di.company_profile WHERE tenant_id=$1',[next.id])).rows[0].name,'Future');
  } finally {await engine.close();}
});

test('orchestrator requires minimum setup but permits setup specialists and unrelated work',()=>{
  for(const id of ['di-records','di-documents','di-forms','di-intake']) assert.equal(companyDispatchGate({id},{minimum_ready:false}).ok,false);
  for(const id of ['di-onboarding','di-db','di-templates','website']) assert.equal(companyDispatchGate({id},{minimum_ready:false}).ok,true);
  assert.equal(companyDispatchGate({id:'di-documents'},{minimum_ready:true}).ok,true);
});

test('manual company profile and reset endpoints require owner authentication',async()=>{
  for(const [path,method,status] of [['/company-profile/','GET',302],['/company-profile/api/profile','GET',401],['/company-profile/api/reset','POST',401]]) {
    let got;
    await handleCompanyProfile({method,headers:{}},{writeHead:s=>{got=s;},end(){}},new URL(path,'http://localhost'),()=>{throw new Error('must not access database');});
    assert.equal(got,status);
  }
});

test('live demo records require owner authentication',async()=>{
  let status;
  await handleDemoState({method:'GET',headers:{}},{writeHead:s=>{status=s;},end(){}});
  assert.equal(status,401);
});
