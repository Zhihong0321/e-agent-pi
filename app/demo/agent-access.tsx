import { useEffect, useState } from "react";

type Assignments = { users: { id: string; username: string; display_name: string }[]; agents: { id: string; name: string }[]; assignments: { user_id: string; agent_id: string }[] };

/** Admin-only: tick which specialists each login in this company may use. */
export function AgentAccessPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [data, setData] = useState<Assignments>({ users: [], agents: [], assignments: [] });
  useEffect(() => { void fetch('/api/demo/user-agents', { credentials: 'include' }).then(async response => {
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    setData(result);
  }).catch(error => onNotice(error.message)); }, [onNotice]);
  const toggle = async (userId: string, agentId: string, enabled: boolean) => {
    try {
      const response = await fetch('/api/demo/user-agents', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, agentId, enabled }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setData(current => ({ ...current, assignments: [...current.assignments.filter(row => row.user_id !== userId || row.agent_id !== agentId), ...(enabled ? [{ user_id: userId, agent_id: agentId }] : [])] }));
    } catch (error) { onNotice(error instanceof Error ? error.message : 'Assignment failed'); }
  };
  return <section><h2>Agent access</h2>{data.users.map(user => <fieldset key={user.id}><legend>{user.display_name || user.username} ({user.username})</legend>
    {data.agents.map(agent => <label key={agent.id}><input type="checkbox" aria-label={`${user.username}: ${agent.name}`} checked={data.assignments.some(row => row.user_id === user.id && row.agent_id === agent.id)} onChange={event => void toggle(user.id, agent.id, event.target.checked)}/>{agent.name}</label>)}
  </fieldset>)}</section>;
}
