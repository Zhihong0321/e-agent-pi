import { randomUUID } from 'node:crypto';
import { computeOccurrences } from './timing.mjs';

const terminal = new Set(['done','failed','cancelled','blocked']);
// Dependencies share the application's existing runner and email transport.
// No second AI runtime and no model call is needed for a fixed reminder.
export function createSchedulerWorker({ pool, runAgentJob, getRun, sendEmail, userLookup, log = () => {}, graceMs = 900000, intervalMs = 5000 }) {
  let timer = null, stopping = false, ticking = false;
  const active = new Map();
  async function transaction(work) {
    const tx = await pool.connect();
    try { await tx.query('BEGIN'); const result = await work(tx); await tx.query('COMMIT'); return result; }
    catch(error) { await tx.query('ROLLBACK'); throw error; }
    finally { tx.release(); }
  }
  async function finish(occurrence, status, { result = null, error = null, receipt = null } = {}) {
    await pool.query(`UPDATE schedule_occurrences SET status=$2,result=$3,error=$4,delivery_receipt=$5::jsonb,
      finished_at=NOW(),updated_at=NOW() WHERE id=$1 AND status IN ('claimed','dispatched')`,
      [occurrence.id,status,result,error,receipt ? JSON.stringify(receipt) : null]);
    await pool.query(`UPDATE schedules SET status='completed',updated_at=NOW()
      WHERE id=$1 AND status='active' AND next_due_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM schedule_occurrences WHERE schedule_id=$1 AND status IN ('claimed','dispatched'))`,[occurrence.schedule_id]);
  }
  async function claim(now) {
    return transaction(async tx => {
      const schedule = (await tx.query(`SELECT * FROM schedules s WHERE status='active' AND deleted_at IS NULL
        AND next_due_at <= $1 AND NOT EXISTS(SELECT 1 FROM schedule_occurrences o WHERE o.schedule_id=s.id AND o.status IN ('claimed','dispatched'))
        ORDER BY next_due_at LIMIT 1 FOR UPDATE SKIP LOCKED`,[now])).rows[0];
      if (!schedule) return null;
      const action = (await tx.query('SELECT * FROM schedule_actions WHERE schedule_id=$1 ORDER BY created_at LIMIT 1',[schedule.id])).rows[0];
      if (!action) throw new Error('Schedule has no action');
      const due = new Date(schedule.next_due_at);
      const recurring = !['date','timed'].includes(schedule.timing_rule.kind);
      const next = recurring ? computeOccurrences(schedule.timing_rule,schedule.timezone,1,new Date(now.getTime()+1))[0]?.nominalDueAt || null : null;
      const snapshot = { schedule, action };
      const occurrence = (await tx.query(`INSERT INTO schedule_occurrences(id,schedule_id,action_id,nominal_due_at,revision,status,snapshot,claimed_at,attempts)
        VALUES($1,$2,$3,$4,$5,'claimed',$6::jsonb,$7,1)
        ON CONFLICT(schedule_id,nominal_due_at) DO UPDATE SET status='claimed',revision=EXCLUDED.revision,
        snapshot=EXCLUDED.snapshot,claimed_at=EXCLUDED.claimed_at,attempts=schedule_occurrences.attempts+1,updated_at=NOW()
        WHERE schedule_occurrences.status IN ('scheduled','cancelled') RETURNING *`,
        [`occ_${randomUUID()}`,schedule.id,action.id,due,schedule.revision,JSON.stringify(snapshot),now])).rows[0];
      await tx.query('UPDATE schedules SET next_due_at=$2,updated_at=NOW() WHERE id=$1',[schedule.id,next]);
      if (!occurrence) return null;
      if (now-due > graceMs) {
        await tx.query("UPDATE schedule_occurrences SET status='missed',error='Missed its execution window; no backlog replay',finished_at=NOW() WHERE id=$1",[occurrence.id]);
        if(!next) await tx.query("UPDATE schedules SET status='completed' WHERE id=$1",[schedule.id]);
        return { ...occurrence, status: 'missed' };
      }
      return occurrence;
    });
  }
  async function execute(occurrence) {
    const { schedule, action } = occurrence.snapshot;
    try {
      const current = (await pool.query('SELECT status,revision FROM schedules WHERE id=$1',[schedule.id])).rows[0];
      if(current?.status !== 'active' || current.revision !== occurrence.revision) return finish(occurrence,'cancelled',{error:'Schedule changed before dispatch'});
      const user = await userLookup(schedule.owner_user_id);
      if(!user?.active || (user.company_tenant_id && user.company_tenant_id !== schedule.company_id)) return finish(occurrence,'blocked',{error:'Schedule owner is inactive or no longer belongs to this company'});
      if(schedule.preset !== 'note') {
        const authorization = (await pool.query(`SELECT authorized_scope,authorized_by_user_id FROM schedule_authorizations
          WHERE schedule_id=$1 AND action_id=$2 AND revision=$3 ORDER BY authorized_at DESC LIMIT 1`,[schedule.id,action.id,occurrence.revision])).rows[0];
        if(!authorization || JSON.stringify(authorization.authorized_scope.config) !== JSON.stringify(action.config)
          || JSON.stringify(authorization.authorized_scope.timing) !== JSON.stringify(schedule.timing_rule)
          || authorization.authorized_scope.timezone !== schedule.timezone
          || !(await userLookup(authorization.authorized_by_user_id))?.active) return finish(occurrence,'blocked',{error:'Activation authorization is missing or revoked'});
      }
      const dispatched = await pool.query("UPDATE schedule_occurrences SET status='dispatched',dispatched_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='claimed' RETURNING id",[occurrence.id]);
      if(!dispatched.rows.length) return;
      if(schedule.preset === 'note' || schedule.preset === 'reminder') {
        return finish(occurrence,'done',{result:action.config.message || schedule.note || schedule.title,
          receipt:{channel:'workspace',availableAt:new Date().toISOString()}});
      }
      if(schedule.preset === 'email_reminder') {
        const receipt = await sendEmail({...action.config,confirm:true});
        return finish(occurrence,'done',{result:'Email reminder sent',receipt});
      }
      const result = await runAgentJob({ occurrence, schedule, action, user,
        onAccepted: async ({runId,sessionId}) => pool.query('UPDATE schedule_occurrences SET execution_ref=$2,session_id=$3,updated_at=NOW() WHERE id=$1',[occurrence.id,runId,sessionId]) });
      return finish(occurrence,result.status === 'done' ? 'done' : result.status || 'failed',
        {result:result.outcome?.summary || null,error:result.error?.message || null});
    } catch(error) {
      // Never blindly resend an email after a timeout or a connection failure.
      const uncertain = schedule.preset === 'email_reminder' && !/rejected the email|requires|must|Provide/.test(error.message);
      await finish(occurrence,uncertain ? 'blocked' : 'failed',{error:uncertain ? `Delivery outcome uncertain; inspect before resending. ${error.message}` : error.message});
      log('warn',`schedule ${schedule.id}: ${error.message}`);
    }
  }
  async function recover(now) {
    const rows = (await pool.query(`SELECT * FROM schedule_occurrences WHERE status IN ('claimed','dispatched')
      AND claimed_at < $1`,[new Date(now.getTime()-120000)])).rows;
    for(const occurrence of rows) {
      if(active.has(occurrence.id)) continue;
      if(occurrence.snapshot?.schedule?.preset === 'agent_job') {
        const run = await getRun(occurrence);
        if(run && terminal.has(run.status)) await finish(occurrence,run.status,{result:run.outcome?.summary,error:run.error?.message});
        else if(!run || new Date(run.deadlineAt || run.deadline_at || 0) < now) await finish(occurrence,'blocked',{error:'Host restarted before AI completion was recorded; inspect before retrying'});
      } else if(occurrence.status === 'claimed') {
        // Dispatch has not started; this metadata-only state can be resumed.
        const reclaimed = await pool.query("UPDATE schedule_occurrences SET claimed_at=$2,updated_at=NOW() WHERE id=$1 AND status='claimed' AND claimed_at=$3 RETURNING id",[occurrence.id,now,occurrence.claimed_at]);
        if(reclaimed.rows.length) { const work=execute(occurrence).catch(error=>log('error',`schedule persistence: ${error.message}`)).finally(()=>active.delete(occurrence.id));active.set(occurrence.id,work); }
      } else await finish(occurrence,'blocked',{error:'Host restarted during delivery; outcome uncertain, inspect before resending'});
    }
  }
  async function tick(now = new Date()) {
    if(stopping || ticking) return;
    ticking = true;
    try {
      await recover(now);
      for(let i=0;i<10 && !stopping && active.size<3;i++) {
        const occurrence=await claim(now);
        if(!occurrence) break;
        if(occurrence.status==='missed') continue;
        const work=execute(occurrence).catch(error=>log('error',`schedule persistence: ${error.message}`)).finally(()=>active.delete(occurrence.id));active.set(occurrence.id,work);
      }
    } finally { ticking = false; }
  }
  return {
    tick, finish, recover,
    idle: () => Promise.allSettled([...active.values()]),
    start() { stopping=false; timer=setInterval(()=>{void tick().catch(error=>log('error',`scheduler tick: ${error.message}`));},intervalMs);timer.unref?.();void tick().catch(error=>log('error',`scheduler tick: ${error.message}`)); },
    stop() { stopping=true;clearInterval(timer); },
  };
}
