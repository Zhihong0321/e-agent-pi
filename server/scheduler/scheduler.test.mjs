import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import {ensureSchedulerSchema,setSchedulerPool} from './store.mjs';
import {setSchedulerCatalog} from './actions.mjs';
import {createSchedule,listCompanySchedules,getSchedule,updateScheduleService,pauseScheduleService,resumeScheduleService,cancelScheduleService,getScheduleHistoryService} from './service.mjs';
import {computeOccurrences,localToUtc,validateTimingRule} from './timing.mjs';
import {manifestForAgent,SCHEDULER_TOOL_IDS} from '../execution/profiles.mjs';
import {getOperation} from '../execution/registry.mjs';
import {createSchedulerWorker} from './worker.mjs';
const owner={id:'alice',role:'user',active:true,company_tenant_id:'company-a'};
const ctx={companyId:'company-a',userId:owner.id,user:owner};
const agents=[{id:'research',name:'Research AI',engine:'pi'},{id:'scheduler',name:'Scheduler AI'}];
const future={kind:'timed',date:'2099-10-15',time:'09:00'};
function pgPool(pg) {
 let tail=Promise.resolve();
 async function acquire(){const prior=tail;let release;tail=new Promise(resolve=>release=resolve);await prior;return release;}
 return {async query(...args){const release=await acquire();try{return await pg.query(...args);}finally{release();}},async connect(){const release=await acquire();return {query:(...args)=>pg.query(...args),release};}};
}
test('timezone-aware cron, weekly and monthly rules validate and produce future occurrences',()=>{
 assert.equal(localToUtc('2026-10-05','09:00','Asia/Kuala_Lumpur').toISOString(),'2026-10-05T01:00:00.000Z');
 assert.throws(()=>localToUtc('2026-02-30','09:00','Asia/Kuala_Lumpur'),/Invalid date/);
 assert.throws(()=>localToUtc('2026-03-08','02:30','America/New_York'),/nonexistent/);
 assert.throws(()=>validateTimingRule({kind:'cron',expression:'* * * * * *'}),/five-field/);
 assert.throws(()=>validateTimingRule({kind:'cron',expression:'99 * * * *'}));
 assert.throws(()=>validateTimingRule({kind:'daily',time:'09:00',startDate:'2026-02-30'}));
 assert.throws(()=>validateTimingRule({kind:'daily',time:'09:00',startDate:'2026-10-20',endDate:'2026-10-01'}));
 const from=new Date('2026-10-05T01:00:00Z');
 assert.equal(computeOccurrences({kind:'cron',expression:'0 9 * * 1'},'Asia/Kuala_Lumpur',1,from)[0].nominalDueAt,'2026-10-12T01:00:00.000Z');
 assert.equal(computeOccurrences({kind:'weekly',time:'09:00',daysOfWeek:[1]},'Asia/Kuala_Lumpur',1,from)[0].date,'2026-10-12');
 assert.deepEqual(computeOccurrences({kind:'monthly',time:'09:00',dayOfMonth:31},'Asia/Kuala_Lumpur',2,new Date('2026-02-01Z')).map(o=>o.date),['2026-03-31','2026-05-31']);
 const dst=computeOccurrences({kind:'daily',time:'09:00'},'America/New_York',2,new Date('2026-03-07T00:00:00Z'));
 assert.deepEqual(dst.map(o=>o.nominalDueAt),['2026-03-07T14:00:00.000Z','2026-03-08T13:00:00.000Z']);
 assert.equal(computeOccurrences({kind:'cron',expression:'0 9 * * *',endDate:'2026-10-05'},'Asia/Kuala_Lumpur',3,new Date('2026-10-06Z')).length,0);
});
test('durable scheduler persistence, access controls, dispatch and recovery',async t=>{
 const pg=new PGlite(),pool=pgPool(pg);await ensureSchedulerSchema(pg);setSchedulerPool(pool);
 setSchedulerCatalog({listAgents:async()=>agents,getAgent:async id=>agents.find(a=>a.id===id)});
 let runs=[],emails=[],lookup=async()=>owner;
 const worker=(overrides={})=>createSchedulerWorker({pool,userLookup:id=>lookup(id),getRun:async()=>null,
  runAgentJob:async input=>{runs.push(input);await input.onAccepted({runId:'run-'+input.occurrence.id,sessionId:'session-'+input.occurrence.id});return {status:'done',outcome:{summary:'Job result'}};},
  sendEmail:async input=>{emails.push(input);return {accepted:true};},...overrides});
 const create=(extra={})=>createSchedule(ctx,{title:'Test schedule',preset:'reminder',timing:future,...extra});
 const due=async schedule=>{await pool.query('UPDATE schedules SET next_due_at=$2 WHERE id=$1',[schedule.id,new Date(Date.now()-1000)]);};
 const history=async id=>(await getScheduleHistoryService(ctx,{schedule_id:id})).occurrences;
 const run=async w=>{await w.tick();await w.idle();};
 try {
  await t.test('company isolation, private visibility and owner permissions',async()=>{
   const {schedule}=await create({visibility:'private'});
   const bob={...ctx,userId:'bob',user:{id:'bob',role:'user',active:true}};
   assert.equal((await listCompanySchedules(bob)).schedules.length,0);
   await assert.rejects(getSchedule({...ctx,companyId:'company-b',user:{...owner,company_tenant_id:'company-b'}},schedule.id),e=>e.code==='NOT_FOUND');
   await assert.rejects(updateScheduleService(bob,{schedule_id:schedule.id,title:'No'}),e=>e.code==='NOT_FOUND');
   assert.equal((await listCompanySchedules({...bob,user:{...bob.user,role:'admin'}})).schedules.length,1);
  });
  await t.test('Scheduler AI tools expose every scheduling action and persist through the native handler',async()=>{
   const profile=manifestForAgent({id:'scheduler',slug:'scheduler',toolProfile:'assistant'});
   for(const id of SCHEDULER_TOOL_IDS) assert.ok(profile.manifest.toolIds.includes(id),id);
   assert.deepEqual((await getOperation('schedule_agents').execute()).agents.map(a=>a.id),['research']);
   const created=await getOperation('schedule_create').execute({...ctx,tx:pg},{title:'Native AI scheduled job',preset:'agent_job',timing:future,action:{agent_id:'research',prompt:'Native instructions'}});
   assert.equal(created.action.config.agent_id,'research');assert.equal(created.schedule.owner_user_id,'alice');
  });
  await t.test('reject stale edits, invalid agent IDs and unconfirmed email without partial records',async()=>{
   const {schedule}=await create();
   await assert.rejects(updateScheduleService(ctx,{schedule_id:schedule.id,expected_revision:99,title:'No'}),e=>e.code==='CONFLICT');
   const before=(await pool.query('SELECT count(*)::int n FROM schedules')).rows[0].n;
   await assert.rejects(create({preset:'agent_job',action:{agent_id:'missing',prompt:'Hi'}}),/existing runnable/);
   await assert.rejects(create({preset:'agent_job',action:{agent_id:'scheduler',prompt:'Hi'}}),/cannot schedule itself/);
   await assert.rejects(create({preset:'email_reminder',action:{to:['test@eternalgy.me'],subject:'Test',text:'Hi'}}),/confirm/);
   assert.equal((await pool.query('SELECT count(*)::int n FROM schedules')).rows[0].n,before);
  });
  await t.test('pause, update, resume and cancel preserve revisions and action payload',async()=>{
   const {schedule}=await create();
   assert.equal((await pauseScheduleService(ctx,{schedule_id:schedule.id,expected_revision:1})).revision,2);
   await due(schedule);const w=worker();await run(w);assert.equal((await history(schedule.id)).filter(o=>o.status==='done').length,0);
   await updateScheduleService(ctx,{schedule_id:schedule.id,expected_revision:2,action:{message:'Updated reminder'}});
   assert.equal((await resumeScheduleService(ctx,{schedule_id:schedule.id,expected_revision:3})).revision,4);
   await due(schedule);await run(w);
   assert.ok((await history(schedule.id)).some(o=>o.result==='Updated reminder'&&o.status==='done'));
   assert.equal((await getSchedule(ctx,schedule.id)).status,'completed');
   await cancelScheduleService(ctx,{schedule_id:schedule.id,expected_revision:4});
   await assert.rejects(resumeScheduleService(ctx,{schedule_id:schedule.id}),/cannot be resumed/);
  });
  await t.test('two workers cannot dispatch the same reminder twice',async()=>{
   const {schedule}=await create({note:'Remember the meeting'});await due(schedule);
   const a=worker(),b=worker();await Promise.all([a.tick(),b.tick()]);await Promise.all([a.idle(),b.idle()]);
   const done=(await history(schedule.id)).filter(o=>o.status==='done');assert.equal(done.length,1);assert.equal(done[0].attempts,1);assert.equal(done[0].delivery_receipt.channel,'workspace');
  });
  await t.test('cron dispatch selects exact agent, saves run reference and advances next due without overlap',async()=>{
   const {schedule}=await create({preset:'agent_job',timing:{kind:'cron',expression:'* * * * *'},action:{agent_id:'research',prompt:'Write weekly summary'}});
   await due(schedule);runs=[];const w=worker();await run(w);await run(w);
   assert.equal(runs.length,1);assert.equal(runs[0].action.config.agent_id,'research');assert.equal(runs[0].user.id,owner.id);assert.equal(runs[0].schedule.company_id,ctx.companyId);
   const completed=(await history(schedule.id)).find(o=>o.status==='done');assert.ok(completed.execution_ref);assert.ok(completed.session_id);assert.equal(completed.result,'Job result');
   assert.ok(new Date((await getSchedule(ctx,schedule.id)).next_due_at)>new Date());
  });
  await t.test('revoked owners block dispatch',async()=>{
   const {schedule}=await create();await due(schedule);lookup=async()=>({...owner,active:false});await run(worker());lookup=async()=>owner;
   assert.ok((await history(schedule.id)).some(o=>o.status==='blocked'));
  });
  await t.test('missed jobs are visible and never replay a backlog',async()=>{
   const {schedule}=await create();await pool.query('UPDATE schedules SET next_due_at=$2 WHERE id=$1',[schedule.id,new Date(Date.now()-3600000)]);
   await run(worker());assert.ok((await history(schedule.id)).some(o=>o.status==='missed'));
  });
  await t.test('email network uncertainty is recorded without resend',async()=>{
   const {schedule}=await create({preset:'email_reminder',action:{to:['test@eternalgy.me'],subject:'Test',text:'Hi',confirm:true}});await due(schedule);
   let attempts=0;const w=worker({sendEmail:async()=>{attempts++;throw Error('Network timeout');}});await run(w);await run(w);
   assert.equal(attempts,1);assert.ok((await history(schedule.id)).some(o=>o.status==='blocked'&&/uncertain/.test(o.error)));
  });
  await t.test('restart reconciles accepted AI run without dispatching it again',async()=>{
   const {schedule,action}=await create({preset:'agent_job',action:{agent_id:'research',prompt:'Hi'}});
   const occurrence=(await history(schedule.id))[0];
   await pool.query("UPDATE schedule_occurrences SET status='dispatched',claimed_at=$2,execution_ref='existing-run',snapshot=$3::jsonb WHERE id=$1",[occurrence.id,new Date(Date.now()-180000),JSON.stringify({schedule,action})]);
   await pool.query('UPDATE schedules SET next_due_at=NULL WHERE id=$1',[schedule.id]);runs=[];
   await run(worker({getRun:async()=>({status:'done',outcome:{summary:'Recovered result'}})}));
   assert.equal(runs.length,0);assert.equal((await history(schedule.id))[0].result,'Recovered result');
  });
  await t.test('restart never resends an email whose delivery started',async()=>{
   const {schedule,action}=await create({preset:'email_reminder',action:{to:['test@eternalgy.me'],subject:'Test',text:'Hi',confirm:true}});
   const occurrence=(await history(schedule.id))[0];await pool.query("UPDATE schedule_occurrences SET status='dispatched',claimed_at=$2,snapshot=$3::jsonb WHERE id=$1",[occurrence.id,new Date(Date.now()-180000),JSON.stringify({schedule,action})]);
   emails=[];await run(worker());assert.equal(emails.length,0);assert.equal((await history(schedule.id))[0].status,'blocked');
  });
 }finally{setSchedulerPool(null);await pg.close();}
});
