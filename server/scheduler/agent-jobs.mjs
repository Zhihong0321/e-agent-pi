import { createSession, getSession, insertMessage, getPool } from '../db.mjs';
import { getAgent } from '../catalog.mjs';
import { manifestForAgent } from '../execution/profiles.mjs';
import { acceptChatRun, waitForChatRun } from '../execution/runner.mjs';
import { getChatRun } from '../execution/store.mjs';

export async function runScheduledAgent({ occurrence, schedule, action, user, onAccepted }) {
  const agent = await getAgent(action.config.agent_id);
  if(!agent || agent.engine === 'agy' || agent.id === 'scheduler') throw new Error('The selected AI agent is no longer runnable');
  const id = `schedule:${occurrence.id}`;
  let session = await getSession(id);
  if(!session) {
    session = await createSession({id,title:`Scheduled: ${schedule.title}`,agentId:agent.id,userId:user.id,engine:'pi',modelId:agent.modelId});
    await insertMessage({sessionId:id,role:'user',content:action.config.prompt,modelId:agent.modelId});
  }
  const { run } = await acceptChatRun({session,profile:agent,user,prompt:action.config.prompt,images:[],
    modelId:agent.modelId,submissionKey:`schedule:${occurrence.id}`,manifest:manifestForAgent(agent),chatContext:{companyId:schedule.company_id}});
  await onAccepted({runId:run.id,sessionId:session.id});
  const settled=await waitForChatRun(run.id);
  if(!settled || !['done','failed','cancelled','blocked'].includes(settled.status)) throw new Error('Scheduled AI run did not settle before its deadline');
  const saved = await getPool().query("SELECT 1 FROM messages WHERE session_id=$1 AND role='assistant' LIMIT 1",[id]);
  if(!saved.rows.length) await insertMessage({sessionId:id,role:'assistant',content:settled.outcome?.summary || settled.error?.message || '',modelId:agent.modelId});
  return settled;
}
export async function recoverScheduledRun(occurrence) {
  if(occurrence.execution_ref) return getChatRun(occurrence.execution_ref);
  return (await getPool().query('SELECT * FROM execution_runs WHERE session_id=$1 AND submission_key=$2',
    [`schedule:${occurrence.id}`,`schedule:${occurrence.id}`])).rows[0] || null;
}
