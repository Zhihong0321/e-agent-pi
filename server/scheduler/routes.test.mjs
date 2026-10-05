import test,{mock} from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';
mock.module('../../document_inteligence/host.mjs',{namedExports:{companyHostContext:()=>({tenantId:'company-a'})}});
const {handleSchedulerRoutes}=await import('./routes.mjs');const {ensureSchedulerSchema,setSchedulerPool}=await import('./store.mjs');
test('schedule HTTP routes require account auth, reject cross-site mutations, and retain URL identity',async()=>{
 const pg=new PGlite();await ensureSchedulerSchema(pg);setSchedulerPool({query:(...args)=>pg.query(...args),connect:async()=>({query:(...args)=>pg.query(...args),release(){}})});
 const user={id:'alice',role:'admin',active:true,company_tenant_id:'company-a'};
 async function call(method,path,body={},overrides={}){let response;await handleSchedulerRoutes({method,headers:overrides.headers||{}},{},new URL(path,'https://example.test'),{user:overrides.user===null?null:user,readBody:async()=>JSON.stringify(body),json:(_res,status,data)=>{response={status,data};}});return response;}
 try {
  assert.equal((await call('GET','/api/schedules',{}, {user:null})).status,401);
  assert.equal((await call('POST','/api/schedules',{}, {headers:{'sec-fetch-site':'cross-site'}})).status,403);
  const create=title=>call('POST','/api/schedules',{title,preset:'reminder',timing:{kind:'timed',date:'2099-10-15',time:'09:00'},company_id:'forged-company',owner_user_id:'forged-user'});
  const a=await create('First'),b=await create('Second');assert.equal(a.status,201);assert.equal(a.data.schedule.company_id,'company-a');assert.equal(a.data.schedule.owner_user_id,'alice');
  const update=await call('PATCH','/api/schedules/'+a.data.schedule.id,{schedule_id:b.data.schedule.id,title:'Updated first',expected_revision:1});assert.equal(update.status,200);assert.equal(update.data.schedule.id,a.data.schedule.id);
  assert.equal((await call('GET','/api/schedules/'+b.data.schedule.id)).data.schedule.title,'Second');
  assert.equal((await call('PATCH','/api/schedules/'+a.data.schedule.id,{title:'Stale',expected_revision:1})).status,409);
  assert.equal((await call('GET','/api/schedules')).data.schedules.length,2);
 } finally {setSchedulerPool(null);await pg.close();}
});
