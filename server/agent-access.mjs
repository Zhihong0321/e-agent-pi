// Which agents a company user may use: ticked for them AND able to run inside a company.
// Platform agents work on the operator's own repos and infrastructure, so no company login may
// use them, whatever the user_agents table says.
import { getPool } from './db.mjs';
import { isPlatformAgent } from './paths.mjs';

/** Agent ids assigned to a user, minus platform agents. */
export async function assignedAgentIds(userId, pool = getPool()) {
  const rows = (await pool.query('SELECT agent_id FROM user_agents WHERE user_id=$1', [userId])).rows;
  return rows.map((row) => row.agent_id).filter((id) => !isPlatformAgent(id));
}

/** True when the agent is assigned to the user and is not a platform agent. */
export async function userAssignedAgent(userId, agentId, pool = getPool()) {
  if (isPlatformAgent(agentId)) return false;
  return (await pool.query('SELECT 1 FROM user_agents WHERE user_id=$1 AND agent_id=$2', [userId, agentId])).rows.length > 0;
}
