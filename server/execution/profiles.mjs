// Agent profiles for the execution system: resolve a catalog agent into the
// frozen manifest an attempt runs with. A profile is configuration, never a
// second executor. Profile edits take effect on the next attempt by design.
import { externalToolIdsForProfile, manifestFor } from './registry.mjs';
import { manifestRevisionOf } from './contracts.mjs';
import { agentWorkspace } from '../paths.mjs';

export const EXECUTOR_VERSION = 'v2';

/** Slugs whose internal MCP proxies are replaced by native tools. */
export const RETIRED_INTERNAL_MCP_SLUGS = new Set(['document-intelligence', 'orchestrator-dispatch']);

export const DEFAULT_LIMITS = {
  chat: {
    durationMs: envInt('EXEC_CHAT_RUN_MS', 300_000),
    modelTurns: envInt('EXEC_CHAT_MODEL_TURNS', 40),
    toolCalls: envInt('EXEC_CHAT_TOOL_CALLS', 60),
  },
  task: {
    durationMs: envInt('EXEC_TASK_RUN_MS', 600_000),
    modelTurns: envInt('EXEC_TASK_MODEL_TURNS', 60),
    toolCalls: envInt('EXEC_TASK_TOOL_CALLS', 120),
  },
};

function envInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Built-in control tools every migrated profile gets (finish_run is added by the worker bridge). */
const BASE_CONTROL_TOOLS = ['list_specialists', 'get_company_setup', 'task_status', 'submit_plan', 'stop_task'];

/**
 * Resolve the manifest for a profile.
 * @param {{ id: string, slug?: string, toolProfile?: string, thinkingLevel?: string, mcp?: object[], skills?: object[] }} agent
 * @param {{ peopleTools?: boolean, controlTools?: boolean, extraToolIds?: string[] }} opts
 */
export function resolveProfileManifest(agent, opts = {}) {
  const toolIds = [];
  if (opts.peopleTools) toolIds.push('count_user_accounts', 'list_people', 'create_person', 'update_person');
  if (opts.controlTools) toolIds.push(...BASE_CONTROL_TOOLS);
  for (const id of opts.extraToolIds || []) toolIds.push(id);

  const mcpServers = (agent.mcp || []).filter((server) => !RETIRED_INTERNAL_MCP_SLUGS.has(server.slug));
  const externalIds = externalToolIdsForProfile(agent.id);
  const tools = manifestFor([...toolIds, ...externalIds], agent.id);
  const manifest = { profileId: agent.id, revision: 1, toolIds: [...toolIds, ...externalIds], tools, mcpServers };
  manifest.revision = manifestRevisionOf(manifest);
  return {
    agentId: agent.id,
    agentRow: agent,
    slug: agent.slug || agent.id,
    name: agent.name,
    toolProfile: agent.toolProfile || 'coding',
    thinkingLevel: agent.thinkingLevel || null,
    modelId: agent.modelId || null,
    workspace: agent.workspace || agentWorkspace(agent),
    toolIds,
    mcpServers,
    manifest,
    revision: manifest.revision,
    limits: DEFAULT_LIMITS,
  };
}

export const SCHEDULER_TOOL_IDS = [
  'schedule_agents',
  'schedule_preview',
  'schedule_create',
  'schedule_list',
  'schedule_update',
  'schedule_pause',
  'schedule_resume',
  'schedule_cancel',
  'schedule_history',
];

/**
 * Manifest rules per agent: the orchestrator gets people + control (planning)
 * operations; Document Intelligence agents get their native DI tools; every
 * migrated profile gets finish_run through the worker bridge.
 */
export function manifestForAgent(agent) {
  const id = String(agent?.id || '');
  const slug = String(agent?.slug || '');
  const isOrchestrator = id === 'orchestrator' || slug === 'orchestrator';
  const isDi = id.startsWith('di-');
  const isScheduler = id === 'scheduler' || slug === 'scheduler';
  return resolveProfileManifest(agent, {
    peopleTools: isOrchestrator,
    controlTools: isOrchestrator,
    extraToolIds: isDi ? diToolIdsFor(id) : isScheduler ? SCHEDULER_TOOL_IDS : [],
  });
}

let diToolIdLookup = () => [];
export function setDiToolIdProvider(fn) {
  diToolIdLookup = fn || diToolIdLookup;
}
function diToolIdsFor(agentId) {
  try {
    return diToolIdLookup(agentId);
  } catch {
    return [];
  }
}
