let catalog = {};
export function setSchedulerCatalog(value) { catalog = value || {}; }
export async function schedulableAgents() {
  return (await catalog.listAgents?.() || []).filter(agent => agent.id !== 'scheduler' && agent.engine !== 'agy')
    .map(agent => ({ id: agent.id, name: agent.name, modelId: agent.modelId }));
}
export async function validateAction(preset, action = {}, { title, note } = {}) {
  if (preset === 'note') return {};
  if (preset === 'reminder') return { message: String(action.message || note || title).trim().slice(0, 4000) };
  if (preset === 'email_reminder') {
    const { validateEmailRequest } = await import('../ee-mail.mjs');
    return validateEmailRequest({ ...action });
  }
  if (preset !== 'agent_job') throw new Error('Choose note, reminder, email_reminder, or agent_job');
  const agent = await catalog.getAgent?.(String(action.agent_id || ''));
  if (!agent || agent.id === 'scheduler' || agent.engine === 'agy') throw new Error('Choose an existing runnable AI agent; Scheduler AI cannot schedule itself');
  const prompt = String(action.prompt || '').trim();
  if (!prompt || prompt.length > 20000) throw new Error('AI job instructions must contain 1–20000 characters');
  return { agent_id: agent.id, agent_name: agent.name, prompt };
}
