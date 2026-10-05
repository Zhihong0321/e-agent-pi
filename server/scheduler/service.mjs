import { randomUUID } from 'node:crypto';
import { validateTimezone, validateTimingRule, computeOccurrences, DEFAULT_TIMEZONE } from './timing.mjs';
import { validateAction } from './actions.mjs';
import { insertSchedule, insertScheduleAction, insertScheduleOccurrence, getScheduleById, listSchedules,
  updateSchedule, listScheduleOccurrences, scheduleTransaction } from './store.mjs';

const fail = (message, code) => Object.assign(new Error(message), { code, execCode: code });
function ensureContext(ctx) {
  if (!ctx?.companyId || !ctx?.userId || !ctx?.user || ctx.user.active === false) throw fail('Sign-in and company context required', 'PERMISSION_DENIED');
  if (ctx.user.id !== ctx.userId || (ctx.user.company_tenant_id && ctx.user.company_tenant_id !== ctx.companyId)) throw fail('Account does not belong to this company', 'PERMISSION_DENIED');
}
function checkAccess(schedule, ctx, write = false) {
  if (!schedule || schedule.company_id !== ctx.companyId) throw fail('Schedule not found', 'NOT_FOUND');
  const owner = schedule.owner_user_id === ctx.userId, admin = ctx.user.role === 'admin';
  if (schedule.visibility === 'private' && !owner && !admin) throw fail('Schedule not found', 'NOT_FOUND');
  if (write && !owner && !admin) throw fail('Only the owner or an admin can change this schedule', 'PERMISSION_DENIED');
}
function titleOf(value) {
  const title = String(value || '').trim();
  if (!title || title.length > 200) throw new Error('Title must contain 1–200 characters');
  return title;
}
function nextDue(timing, timezone, preset) {
  const due = computeOccurrences(timing, timezone, 1)[0]?.nominalDueAt || null;
  if (!due || (preset !== 'note' && new Date(due) <= new Date())) throw new Error('Choose a future execution time with at least one occurrence');
  if (preset !== 'note' && timing.kind === 'date' && timing.all_day) throw new Error('Jobs and reminders require an explicit time');
  return due;
}
export function previewSchedule({ timing, timezone = DEFAULT_TIMEZONE, preset = 'note' }) {
  const tz = validateTimezone(timezone), rule = validateTimingRule(timing, tz);
  return { valid: true, preset, interpretedTimezone: tz, timingRule: rule,
    previewOccurrences: computeOccurrences(rule, tz, 3),
    warnings: rule.kind === 'date' && rule.all_day && preset !== 'note' ? ['Choose an explicit time for a job or reminder.'] : [] };
}
async function authorize(tx, schedule, action, ctx) {
  if (schedule.preset === 'note') return;
  await tx.query(`INSERT INTO schedule_authorizations(id,schedule_id,action_id,revision,authorized_by_user_id,authorized_scope)
    VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [`auth_${randomUUID()}`,schedule.id,action.id,schedule.revision,ctx.userId,
    JSON.stringify({ timing: schedule.timing_rule, timezone: schedule.timezone, config: action.config })]);
}
export async function createSchedule(ctx, args, runner = null) {
  ensureContext(ctx);
  const title = titleOf(args.title), preset = args.preset || 'note', timezone = validateTimezone(args.timezone || DEFAULT_TIMEZONE);
  const note = String(args.note || '').trim().slice(0, 4000);
  const timing = validateTimingRule(args.timing, timezone);
  const actionConfig = await validateAction(preset, args.action, { title, note });
  const due = nextDue(timing, timezone, preset);
  return scheduleTransaction(runner, async tx => {
    const schedule = await insertSchedule(tx, { company_id: ctx.companyId, owner_user_id: ctx.userId, title, note, preset,
      visibility: args.visibility === 'private' ? 'private' : 'company', timezone, timing_rule: timing,
      start_time: due, next_due_at: due, source_session_id: ctx.sessionId || null, source_record_link: args.source_record_link || null });
    const action = await insertScheduleAction(tx, { schedule_id: schedule.id, action_type: preset, config: actionConfig });
    const occurrence = await insertScheduleOccurrence(tx, { schedule_id: schedule.id, action_id: action.id, nominal_due_at: due, revision: 1 });
    await authorize(tx, schedule, action, ctx);
    return { schedule: { ...schedule, action }, action, occurrences: [occurrence] };
  });
}
export async function getSchedule(ctx, id, runner = null) {
  ensureContext(ctx);
  const schedule = await getScheduleById(runner, id);
  checkAccess(schedule, ctx);
  return schedule;
}
export async function listCompanySchedules(ctx, args = {}, runner = null) {
  ensureContext(ctx);
  return { schedules: await listSchedules(runner, { ...args, companyId: ctx.companyId, userId: ctx.userId,
    isAdmin: ctx.user.role === 'admin', limit: Math.max(1, Math.min(Number(args.limit) || 100, 200)) }) };
}
export async function updateScheduleService(ctx, args, runner = null) {
  ensureContext(ctx);
  return scheduleTransaction(runner, async tx => {
    const existing = await getScheduleById(tx, args.schedule_id || args.id);
    checkAccess(existing, ctx, true);
    if (existing.status === 'cancelled') throw new Error('Cancelled schedules cannot be changed');
    await tx.query('SELECT id FROM schedules WHERE id=$1 FOR UPDATE', [existing.id]);
    const action = (await tx.query('SELECT * FROM schedule_actions WHERE schedule_id=$1 ORDER BY created_at LIMIT 1',[existing.id])).rows[0];
    const timezone = validateTimezone(args.timezone ?? existing.timezone);
    const timing = validateTimingRule(args.timing ?? existing.timing_rule, timezone);
    const title = args.title === undefined ? existing.title : titleOf(args.title);
    const note = args.note === undefined ? existing.note : String(args.note).slice(0,4000);
    const config = args.action === undefined ? action.config : await validateAction(existing.preset,args.action,{title,note});
    const due = existing.status === 'paused' ? existing.next_due_at : nextDue(timing,timezone,existing.preset);
    const schedule = await updateSchedule(tx,{id:existing.id,expectedRevision:args.expected_revision ?? existing.revision,updates:{title,note,timezone,timing_rule:timing,next_due_at:due,
      ...(args.visibility !== undefined ? {visibility:args.visibility === 'private' ? 'private' : 'company'} : {})}});
    await tx.query('UPDATE schedule_actions SET config=$2::jsonb,updated_at=NOW() WHERE id=$1',[action.id,JSON.stringify(config)]);
    await tx.query("UPDATE schedule_occurrences SET status='cancelled',finished_at=NOW(),updated_at=NOW() WHERE schedule_id=$1 AND status='scheduled'",[schedule.id]);
    if (due) await tx.query(`INSERT INTO schedule_occurrences(id,schedule_id,action_id,nominal_due_at,revision,status)
      VALUES($1,$2,$3,$4,$5,'scheduled') ON CONFLICT(schedule_id,nominal_due_at) DO UPDATE
      SET revision=EXCLUDED.revision,status='scheduled',finished_at=NULL WHERE schedule_occurrences.status IN ('scheduled','cancelled')`,
      [`occ_${randomUUID()}`,schedule.id,action.id,due,schedule.revision]);
    await authorize(tx,schedule,{...action,config},ctx);
    return {schedule:{...schedule,action:{...action,config}},revision:schedule.revision};
  });
}
async function changeStatus(ctx, { schedule_id, expected_revision }, status, runner) {
  ensureContext(ctx);
  return scheduleTransaction(runner, async tx => {
    const existing = await getScheduleById(tx,schedule_id);
    checkAccess(existing,ctx,true);
    if(existing.status === 'cancelled' && status !== 'cancelled') throw new Error('Cancelled schedules cannot be resumed');
    const due = status === 'active' ? nextDue(existing.timing_rule,existing.timezone,existing.preset) : status === 'cancelled' ? null : existing.next_due_at;
    const schedule = await updateSchedule(tx,{id:schedule_id,expectedRevision:expected_revision ?? existing.revision,updates:{status,next_due_at:due}});
    await tx.query("UPDATE schedule_occurrences SET status='cancelled',finished_at=NOW(),updated_at=NOW() WHERE schedule_id=$1 AND status='scheduled'",[schedule_id]);
    const action = (await tx.query('SELECT * FROM schedule_actions WHERE schedule_id=$1 ORDER BY created_at LIMIT 1',[schedule_id])).rows[0];
    if(status === 'active') await authorize(tx,schedule,action,ctx);
    return {schedule,status,revision:schedule.revision};
  });
}
export const pauseScheduleService = (ctx,args,runner=null) => changeStatus(ctx,args,'paused',runner);
export const resumeScheduleService = (ctx,args,runner=null) => changeStatus(ctx,args,'active',runner);
export const cancelScheduleService = (ctx,args,runner=null) => changeStatus(ctx,args,'cancelled',runner);
export async function getScheduleHistoryService(ctx,{schedule_id,limit=20},runner=null) {
  await getSchedule(ctx,schedule_id,runner);
  return {occurrences:await listScheduleOccurrences(runner,schedule_id,Math.max(1,Math.min(Number(limit)||20,100)))};
}
