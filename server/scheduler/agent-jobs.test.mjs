import test,{mock} from 'node:test';import assert from 'node:assert/strict';
let session=null,messages=[],accepted=[],reads=[];
const agent={id:'research',name:'Research AI',engine:'pi',modelId:'saved-model'};
const pool={query:async(sql,params)=>{reads.push({sql,params});return {rows:sql.includes("role='assistant'")?messages.filter(m=>m.role==='assistant'):[{id:'recovered-run',status:'done'}]};}};
mock.module('../db.mjs',{namedExports:{getPool:()=>pool,getSession:async()=>session,createSession:async input=>(session={...input}),insertMessage:async input=>messages.push(input)}});
mock.module('../catalog.mjs',{namedExports:{getAgent:async id=>id===agent.id?agent:null}});
mock.module('../execution/profiles.mjs',{namedExports:{manifestForAgent:a=>({manifest:{toolIds:['research_tool']},agentRow:a})}});
mock.module('../execution/runner.mjs',{namedExports:{acceptChatRun:async input=>{accepted.push(input);return {run:{id:'accepted-run'}};},waitForChatRun:async()=>({status:'done',outcome:{summary:'Saved scheduled output'}})}});
mock.module('../execution/store.mjs',{namedExports:{getChatRun:async id=>({id,status:'done'})}});
const {runScheduledAgent,recoverScheduledRun}=await import('./agent-jobs.mjs');
test('scheduled AI adapter preserves target model, owner, company, prompt and stable deduplication key',async()=>{
 const input={occurrence:{id:'occurrence-1'},schedule:{title:'Report',company_id:'company-a'},action:{config:{agent_id:'research',prompt:'Summarize company research'}},user:{id:'alice'},onAccepted:async value=>assert.deepEqual(value,{runId:'accepted-run',sessionId:'schedule:occurrence-1'})};
 await runScheduledAgent(input);await runScheduledAgent(input);
 assert.equal(session.agentId,'research');assert.equal(session.userId,'alice');assert.equal(session.modelId,'saved-model');
 assert.equal(messages.filter(m=>m.role==='user').length,1);assert.equal(messages.filter(m=>m.role==='assistant').length,1);
 assert.equal(messages.find(m=>m.role==='assistant').content,'Saved scheduled output');
 assert.equal(accepted[0].profile,agent);assert.equal(accepted[0].modelId,'saved-model');assert.equal(accepted[0].prompt,input.action.config.prompt);assert.equal(accepted[0].user,input.user);assert.equal(accepted[0].chatContext.companyId,'company-a');assert.equal(accepted[0].submissionKey,accepted[1].submissionKey);
 await assert.rejects(runScheduledAgent({...input,action:{config:{agent_id:'missing'}}}),/no longer runnable/);
});
test('restart lookup finds an accepted execution even if linking its reference was interrupted',async()=>{
 assert.equal((await recoverScheduledRun({execution_ref:'linked-run'})).id,'linked-run');
 assert.equal((await recoverScheduledRun({id:'occurrence-1'})).id,'recovered-run');
 assert.deepEqual(reads.at(-1).params,['schedule:occurrence-1','schedule:occurrence-1']);
});
