import { useCallback, useEffect, useState, type FormEvent } from 'react';
import './schedules.css';

type Agent = { id: string; name: string };
type Timing = { kind: string; date?: string; time?: string; daysOfWeek?: number[]; dayOfMonth?: number; expression?: string };
type Config = { agent_id?: string; agent_name?: string; prompt?: string; message?: string; to?: string[]; subject?: string; text?: string };
type Schedule = { id: string; title: string; note: string; preset: string; status: string; visibility: string; owner_user_id: string;
  timezone: string; next_due_at: string | null; revision: number; timing_rule: Timing; action?: { config: Config };
  last_run?: { status: string; due_at: string; error?: string; result?: string } };
type Occurrence = { id: string; nominal_due_at: string; status: string; result?: string; error?: string; session_id?: string; execution_ref?: string };
type Preview = { interpretedTimezone: string; previewOccurrences: { nominalDueAt: string; localFormatted: string }[]; warnings: string[] };
type Draft = { title: string; note: string; preset: string; visibility: string; timezone: string; kind: string; date: string; time: string;
  weekday: string; monthday: string; expression: string; agent: string; prompt: string; to: string; subject: string; text: string; confirm: boolean };
const emptyDraft = (): Draft => ({ title: '', note: '', preset: 'agent_job', visibility: 'company', timezone: 'Asia/Kuala_Lumpur',kind: 'timed',
  date: new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur'}).format(new Date()),time:'09:00',weekday:'1',monthday:'1',expression:'0 9 * * 1',
  agent:'',prompt:'',to:'',subject:'',text:'',confirm:false });
const labels: Record<string,string> = { note:'Note',reminder:'Workspace reminder',email_reminder:'Email reminder',agent_job:'AI job' };
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url,{credentials:'include',...init,headers:{'Content-Type':'application/json',...init?.headers}});
  const data = await response.json();
  if(!response.ok) throw new Error(data.error || 'Could not load schedules');
  return data as T;
}
function dateLabel(value: string | null | undefined, timezone: string) {
  return value ? new Intl.DateTimeFormat('en-GB',{timeZone:timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(value)) : 'No upcoming run';
}
function ruleLabel(rule: Timing) {
  if(rule.kind === 'cron') return `Cron · ${rule.expression}`;
  if(rule.kind === 'daily') return `Every day at ${rule.time}`;
  if(rule.kind === 'weekly') return `Weekly · ${rule.daysOfWeek?.map(day=>['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day%7]).join(', ')} at ${rule.time}`;
  if(rule.kind === 'monthly') return `Monthly · day ${rule.dayOfMonth} at ${rule.time}`;
  return `Once · ${rule.date} ${rule.time || 'all day'}`;
}

export function SchedulesPanel({ user }: { user: { id: string; role: string } }) {
  const [schedules,setSchedules] = useState<Schedule[]>([]), [agents,setAgents] = useState<Agent[]>([]);
  const [status,setStatus] = useState('all'), [preset,setPreset] = useState('all');
  const [error,setError] = useState(''), [notice,setNotice] = useState(''), [loading,setLoading] = useState(true), [busy,setBusy] = useState(false);
  const [formOpen,setFormOpen] = useState(false), [editing,setEditing] = useState<Schedule | null>(null), [draft,setDraft] = useState(emptyDraft);
  const [preview,setPreview] = useState<Preview | null>(null), [selected,setSelected] = useState<Schedule | null>(null), [history,setHistory] = useState<Occurrence[]>([]);
  const load = useCallback(async () => {
    const data=await request<{schedules:Schedule[]}>(`/api/schedules?status=${status}&preset=${preset}&limit=200`);
    setSchedules(data.schedules);setLoading(false);
  },[status,preset]);
  useEffect(()=>{const controller=new AbortController();const read=()=>request<{schedules:Schedule[]}>(`/api/schedules?status=${status}&preset=${preset}&limit=200`,{signal:controller.signal}).then(data=>{setSchedules(data.schedules);setLoading(false);}).catch(err=>{if(!controller.signal.aborted){setError(err.message);setLoading(false);}});void read();const timer=window.setInterval(()=>void read(),15000);return()=>{controller.abort();clearInterval(timer);};},[status,preset]);
  useEffect(()=>{void request<{agents:Agent[]}>('/api/schedules/agents').then(data=>setAgents(data.agents)).catch(err=>setError(err.message));},[]);
  useEffect(()=>{if(!selected)return;let stopped=false;const read=()=>request<{occurrences:Occurrence[]}>(`/api/schedules/${encodeURIComponent(selected.id)}/history`).then(data=>{if(!stopped)setHistory(data.occurrences);}).catch(err=>{if(!stopped)setError(err.message);});void read();const timer=window.setInterval(()=>void read(),10000);return()=>{stopped=true;clearInterval(timer);};},[selected]);
  const change = (key: keyof Draft,value: string | boolean) => {setDraft(prev=>({...prev,[key]:value}));setPreview(null);};
  const body = () => {
    const timing: Timing = draft.kind === 'cron' ? {kind:'cron',expression:draft.expression}
      : draft.kind === 'daily' ? {kind:'daily',time:draft.time}
      : draft.kind === 'weekly' ? {kind:'weekly',time:draft.time,daysOfWeek:[Number(draft.weekday)]}
      : draft.kind === 'monthly' ? {kind:'monthly',time:draft.time,dayOfMonth:Number(draft.monthday)}
      : {kind:'timed',date:draft.date,time:draft.time};
    const action = draft.preset === 'agent_job' ? {agent_id:draft.agent,prompt:draft.prompt}
      : draft.preset === 'email_reminder' ? {to:draft.to.split(',').map(v=>v.trim()).filter(Boolean),subject:draft.subject,text:draft.text,confirm:draft.confirm}
      : {message:draft.note || draft.title};
    return {title:draft.title,note:draft.note,preset:draft.preset,visibility:draft.visibility,timezone:draft.timezone,timing,action};
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();setBusy(true);setError('');
    try {
      if(!preview) {setPreview(await request<Preview>('/api/schedules/preview',{method:'POST',body:JSON.stringify(body())}));return;}
      if(!preview.previewOccurrences.length || preview.warnings.length) throw new Error('Adjust the timing before activating this schedule');
      await request(editing ? `/api/schedules/${encodeURIComponent(editing.id)}` : '/api/schedules',
        {method:editing?'PATCH':'POST',body:JSON.stringify({...body(),...(editing?{expected_revision:editing.revision}:{})})});
      setFormOpen(false);setEditing(null);setPreview(null);setDraft(emptyDraft());setNotice(editing?'Schedule updated.':'Schedule activated.');await load();
    }catch(err){setError(err instanceof Error?err.message:'Could not save schedule');}finally{setBusy(false);}
  };
  const edit = (schedule: Schedule) => {
    const config=schedule.action?.config || {},timing=schedule.timing_rule;
    setDraft({...emptyDraft(),title:schedule.title,note:schedule.note,preset:schedule.preset,visibility:schedule.visibility,timezone:schedule.timezone,
      kind:timing.kind==='date'?'timed':timing.kind,date:timing.date || emptyDraft().date,time:timing.time || '09:00',weekday:String(timing.daysOfWeek?.[0] ?? 1),
      monthday:String(timing.dayOfMonth || 1),expression:timing.expression || '0 9 * * 1',agent:config.agent_id || '',prompt:config.prompt || '',
      to:config.to?.join(', ') || '',subject:config.subject || '',text:config.text || '',confirm:false});
    setEditing(schedule);setPreview(null);setFormOpen(true);setError('');
  };
  const mutate = async (schedule: Schedule,action: string) => {
    setBusy(true);setError('');try{await request(`/api/schedules/${encodeURIComponent(schedule.id)}/${action}`,{method:'POST',body:JSON.stringify({expected_revision:schedule.revision})});await load();setNotice(`Schedule ${action==='pause'?'paused':action==='resume'?'resumed':'cancelled'}.`);}catch(err){setError(err instanceof Error?err.message:'Schedule change failed');}finally{setBusy(false);}
  };
  const activeCount=schedules.filter(s=>s.status==='active').length;
  return <section className="schedules-panel" aria-label="Schedules">
    <div className="schedule-toolbar"><div><strong>{activeCount} active</strong><span>AI jobs, reminders, and cron schedules</span></div><div className="schedule-actions"><button onClick={()=>void load().catch(err=>setError(err.message))}>Refresh</button><button className="demo-primary" onClick={()=>{setDraft(emptyDraft());setEditing(null);setPreview(null);setFormOpen(true);setError('');}}>+ New schedule</button></div></div>
    {error&&<p className="schedule-error" role="alert">{error}</p>}{notice&&<p className="schedule-notice" role="status">{notice}</p>}
    {formOpen&&<form className="schedule-editor" onSubmit={submit}>
      <div className="schedule-section-head"><h2>{editing?'Edit schedule':'New schedule'}</h2><button type="button" onClick={()=>setFormOpen(false)}>Close</button></div>
      <div className="schedule-form-grid">
        <label>Title<input required maxLength={200} value={draft.title} onChange={e=>change('title',e.target.value)} placeholder="Weekly company report"/></label>
        <label>Type<select aria-label="Type" value={draft.preset} disabled={Boolean(editing)} onChange={e=>change('preset',e.target.value)}>{Object.entries(labels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        <label>Timing<select aria-label="Timing" value={draft.kind} onChange={e=>change('kind',e.target.value)}><option value="timed">One time</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="cron">Cron expression</option></select></label>
        <label>Timezone<input required value={draft.timezone} onChange={e=>change('timezone',e.target.value)}/></label>
        {draft.kind==='timed'&&<label>Date<input required type="date" value={draft.date} onChange={e=>change('date',e.target.value)}/></label>}
        {draft.kind!=='cron'&&<label>Time<input required type="time" value={draft.time} onChange={e=>change('time',e.target.value)}/></label>}
        {draft.kind==='weekly'&&<label>Day<select aria-label="Day" value={draft.weekday} onChange={e=>change('weekday',e.target.value)}>{['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((day,index)=><option key={day} value={index}>{day}</option>)}</select></label>}
        {draft.kind==='monthly'&&<label>Day of month<input required type="number" min={1} max={31} value={draft.monthday} onChange={e=>change('monthday',e.target.value)}/></label>}
        {draft.kind==='cron'&&<label className="schedule-wide">Cron expression<input required value={draft.expression} onChange={e=>change('expression',e.target.value)} placeholder="0 9 * * 1"/><small>Minute · hour · day · month · weekday. For example, 0 9 * * 1 runs Mondays at 9 AM in the selected timezone.</small></label>}
        <label>Visibility<select aria-label="Visibility" value={draft.visibility} onChange={e=>change('visibility',e.target.value)}><option value="company">Company</option><option value="private">Private</option></select></label>
        {draft.preset==='agent_job'&&<><label>AI agent<select aria-label="AI agent" required value={draft.agent} onChange={e=>change('agent',e.target.value)}><option value="">Select an agent</option>{agents.map(agent=><option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label><label className="schedule-wide">Instructions<textarea required maxLength={20000} rows={4} value={draft.prompt} onChange={e=>change('prompt',e.target.value)} placeholder="What should this agent do when the schedule runs?"/></label></>}
        <label className="schedule-wide">{draft.preset==='reminder'?'Reminder message':'Note'}<textarea rows={2} maxLength={4000} value={draft.note} onChange={e=>change('note',e.target.value)}/>{draft.preset==='reminder'&&<small>The reminder appears here in its run history when due.</small>}</label>
        {draft.preset==='email_reminder'&&<><label className="schedule-wide">Recipients<input required value={draft.to} onChange={e=>change('to',e.target.value)} placeholder="name@example.com"/><small>Email addresses, separated by commas.</small></label><label className="schedule-wide">Email subject<input required maxLength={200} value={draft.subject} onChange={e=>change('subject',e.target.value)}/></label><label className="schedule-wide">Email message<textarea required rows={4} value={draft.text} onChange={e=>change('text',e.target.value)}/></label><label className="schedule-confirm schedule-wide"><input type="checkbox" required checked={draft.confirm} onChange={e=>change('confirm',e.target.checked)}/>I authorize sending this message to these recipients at the previewed times.</label></>}
      </div>
      {preview&&<div className="schedule-preview"><strong>Next occurrences · {preview.interpretedTimezone}</strong><ol>{preview.previewOccurrences.map(item=><li key={item.nominalDueAt}>{item.localFormatted}</li>)}</ol>{!preview.previewOccurrences.length&&<p>No future occurrences. Adjust the timing.</p>}{preview.warnings.map(warning=><p key={warning}>{warning}</p>)}</div>}
      <div className="schedule-editor-footer"><small>{preview?'Review the timing and action above before activation.':'Preview the interpreted timing before saving.'}</small><button className="demo-primary" disabled={busy}>{busy?'Working…':preview?(editing?'Save changes':'Activate schedule'):'Preview schedule'}</button></div>
    </form>}
    <div className="schedule-filters"><label>Status<select value={status} onChange={e=>setStatus(e.target.value)}>{['all','active','paused','completed','cancelled'].map(value=><option key={value} value={value}>{value==='all'?'All statuses':value}</option>)}</select></label><label>Type<select value={preset} onChange={e=>setPreset(e.target.value)}><option value="all">All types</option>{Object.entries(labels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label></div>
    {loading?<p role="status">Loading schedules…</p>:!schedules.length?<div className="schedule-empty"><h2>No schedules yet</h2><p>Create an AI job, a reminder, or a cron schedule to see its next run and results here.</p></div>:<div className="schedule-list">{schedules.map(schedule=>{
      const canEdit=user.role==='admin'||user.id===schedule.owner_user_id;
      return <article className="schedule-card" key={schedule.id}><div className="schedule-card-main"><div className="schedule-card-heading"><h2>{schedule.title}</h2><span className={`schedule-badge ${schedule.status}`}>{schedule.status}</span></div><p className="schedule-kind">{labels[schedule.preset] || schedule.preset}{schedule.action?.config.agent_name?` · ${schedule.action.config.agent_name}`:''} · {schedule.visibility}</p><p>{ruleLabel(schedule.timing_rule)}</p><strong className="schedule-next">{dateLabel(schedule.next_due_at,schedule.timezone)}</strong><small>{schedule.timezone}</small>{schedule.note&&<p className="schedule-note">{schedule.note}</p>}{schedule.last_run&&<p className="schedule-last">Last occurrence: {schedule.last_run.status} · {dateLabel(schedule.last_run.due_at,schedule.timezone)}{schedule.last_run.error&&<span className="schedule-error">{schedule.last_run.error}</span>}</p>}</div><div className="schedule-card-buttons"><button onClick={()=>{setSelected(schedule);setHistory([]);}}>History</button>{canEdit&&['active','paused'].includes(schedule.status)&&<><button disabled={busy} onClick={()=>edit(schedule)}>Edit</button><button disabled={busy} onClick={()=>void mutate(schedule,schedule.status==='active'?'pause':'resume')}>{schedule.status==='active'?'Pause':'Resume'}</button><button disabled={busy} onClick={()=>void mutate(schedule,'cancel')}>Cancel</button></>}</div></article>;
    })}</div>}
    {selected&&<section className="schedule-history" aria-label="Schedule history"><div className="schedule-section-head"><div><h2>{selected.title}</h2><p>Run history · {selected.timezone}</p></div><button onClick={()=>setSelected(null)}>Close history</button></div>{!history.length?<p>No occurrences recorded yet.</p>:history.map(item=><article key={item.id}><div><strong>{dateLabel(item.nominal_due_at,selected.timezone)}</strong><span className={`schedule-badge ${item.status}`}>{item.status}</span></div>{item.result&&<p className="schedule-result">{item.result}</p>}{item.error&&<p className="schedule-error">{item.error}</p>}{item.session_id&&<a href={`/demo?area=logs&sessionId=${encodeURIComponent(item.session_id)}`}>Open AI transcript</a>}</article>)}</section>}
  </section>;
}
