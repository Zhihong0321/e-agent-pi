// Canonical operation registry. Every internal business operation the model can
// call is defined ONCE here: schema, access policy, effect classification and
// the real handler. Callers cannot pass module paths, SQL or handler names —
// the registry resolves approved operation ids to handlers.
// The same definitions generate the worker tool manifest (JSON schemas), so an
// authenticated frontend route and an agent tool call share one handler path.
import { z } from 'zod';
import { managePeopleCore, listPeople, countUserAccounts } from '../people-service.mjs';
import { updateCompanyProfile } from '../../document_inteligence/core/company.mjs';
import {
  previewSchedule,
  createSchedule,
  listCompanySchedules,
  updateScheduleService,
  pauseScheduleService,
  resumeScheduleService,
  cancelScheduleService,
  getScheduleHistoryService,
} from '../scheduler/service.mjs';
import { schedulableAgents } from '../scheduler/actions.mjs';
import { getAgent } from '../catalog.mjs';
import { clearAgentSop, getAgentSop, saveAgentSop } from '../sops.mjs';
import { agentWorkspace } from '../paths.mjs';
import { isSuperadmin, normalizeRole } from '../roles.mjs';
import { ToolManifestEntrySchema } from './contracts.mjs';

const operations = new Map();
const operationVariants = new Map(); // operation id -> Map(profile id, definition)
const externalToolsByProfile = new Map();

export function externalToolIdsForProfile(profileId) {
  return [...(externalToolsByProfile.get(String(profileId)) || [])];
}

/** Register host-owned MCP tools as ordinary canonical operations. */
export function registerExternalMcpTools({ binding, tools, profileIds = [] }) {
  for (const tool of tools || []) {
    const id = tool.name || `${binding.slug}__${tool.mcpTool}`;
    registerOperation({
      id,
      description: tool.description || `${binding.slug}.${tool.mcpTool}`,
      effect: 'external',
      timeoutMs: binding.timeoutMs || 60_000,
      profileIds,
      inputSchema: z.record(z.string(), z.unknown()).optional().default({}),
      mcpServer: binding.slug,
      mcpTool: tool.mcpTool,
      access: { user: true },
      async execute(ctx, args, services) {
        const adapter = services.mcpAdapter;
        if (!adapter?.callExternal) throw Object.assign(new Error(`MCP ${binding.slug} adapter is unavailable`), { execCode: 'EXTERNAL_ERROR' });
        const scopedBinding = {
          ...binding,
          scope: `company:${ctx.companyId || 'none'}:user:${ctx.userId || 'none'}`,
        };
        const response = await adapter.callExternal(scopedBinding, tool.mcpTool, args);
        if (!response?.ok) throw Object.assign(new Error(response?.error?.message || 'External MCP call failed'), { execCode: response?.error?.code || 'EXTERNAL_ERROR' });
        return { ...(response.data && typeof response.data === 'object' ? response.data : { value: response.data }), effects: response.effects || [] };
      },
    });
    for (const profileId of profileIds) {
      const ids = externalToolsByProfile.get(String(profileId)) || new Set();
      ids.add(id);
      externalToolsByProfile.set(String(profileId), ids);
    }
  }
}

export function registerOperation(def) {
  const op = { version: 1, timeoutMs: 30_000, sameTx: false, access: {}, ...def };
  if (!op.id || typeof op.execute !== 'function') throw new Error(`Operation ${op.id || '(unnamed)'} needs an id and execute`);
  if (!op.inputSchema) throw new Error(`Operation ${op.id} needs an inputSchema`);
  const profiles = Array.isArray(op.profileIds) ? op.profileIds : null;
  if (profiles?.length) {
    let variants = operationVariants.get(op.id);
    if (!variants) operationVariants.set(op.id, variants = new Map());
    for (const profile of profiles) variants.set(profile, op);
    // Preserve the first canonical definition for generic lookup/tests.
    if (!operations.has(op.id)) operations.set(op.id, op);
  } else {
    operations.set(op.id, op);
  }
  return op;
}

export function getOperation(id, profileId = null) {
  const key = String(id || '');
  return (profileId && operationVariants.get(key)?.get(profileId)) || operations.get(key) || null;
}

export function listOperations() {
  return [...operations.values()];
}

/** Small explicit manifest for a profile: only permitted operations. */
export function manifestFor(toolIds, profileId = null) {
  const tools = [];
  for (const id of toolIds || []) {
    const op = getOperation(id, profileId);
    if (!op) throw new Error(`Profile references unknown operation: ${id}`);
    tools.push({
      id: op.id,
      description: op.description,
      kind: op.effect === 'external' ? 'external' : op.effect === 'control' ? 'control' : op.effect,
      inputSchema: z.toJSONSchema(op.inputSchema, { io: 'input' }),
      ...(op.mcpServer ? { mcpServer: op.mcpServer, mcpTool: op.mcpTool } : {}),
    });
  }
  return tools;
}

function requireUser(ctx) {
  if (!ctx.userId) throw Object.assign(new Error('Sign-in required: the host attached no signed-in user to this run. If the person is signed in, report this as a system fault.'), { execCode: 'SIGN_IN_REQUIRED' });
  if (ctx.user && ctx.user.active === false) throw Object.assign(new Error('Current login is no longer active'), { execCode: 'PERMISSION_DENIED' });
}

function requireAdmin(ctx) {
  requireUser(ctx);
  if (!isSuperadmin(ctx.user)) throw Object.assign(new Error('This operation needs a Superadmin login'), { execCode: 'PERMISSION_DENIED' });
}

const roleInput = z.enum(['superadmin', 'department_head', 'user', 'admin']).optional()
  .describe('Superadmin only: superadmin, department_head (needs a department) or user')
  .transform((value) => (value === undefined ? undefined : normalizeRole(value)));

// ---------------------------------------------------------------- people family

registerOperation({
  id: 'count_user_accounts',
  description: 'Count the company people and their workspace logins for this company: total people, how many have logins, contact-only people, active logins and admins. Use it for questions like "how many accounts do we have".',
  effect: 'read',
  timeoutMs: 10_000,
  access: { user: true },
  inputSchema: z.object({}).describe('No arguments'),
  async execute(ctx) {
    return countUserAccounts(ctx.companyId);
  },
});

registerOperation({
  id: 'list_people',
  description: 'List this company\'s people: contact-only people and people with workspace logins, with name, position, department, email, phone, location and login status.',
  effect: 'read',
  timeoutMs: 15_000,
  access: { user: true },
  inputSchema: z.object({}).describe('No arguments'),
  async execute(ctx) {
    return listPeople(ctx.companyId);
  },
});

const personFields = {
  name: z.string().max(300).optional().describe('Full name (required for a new person)'),
  position: z.string().max(300).optional(),
  department: z.string().max(300).optional(),
  email: z.string().max(300).optional().describe('Business email'),
  phone: z.string().max(300).optional(),
  location: z.string().max(300).optional(),
  notes: z.string().max(2000).optional(),
};

registerOperation({
  id: 'create_person',
  description: 'Add a company person (contact-only by default). Login access can only be enabled by an admin login and needs username AND password. Never invent credentials; ask the user.',
  effect: 'local_write',
  sameTx: true,
  timeoutMs: 15_000,
  access: { user: true },
  inputSchema: z.object({
    ...personFields,
    name: z.string().max(300).describe('Full name'),
    username: z.string().max(64).optional().describe('Admin only: login username'),
    password: z.string().max(256).optional().describe('Admin only: initial password; never repeat it back'),
    role: roleInput,
    login_enabled: z.boolean().optional(),
  }),
  async execute(ctx, args) {
    requireUser(ctx);
    if (args.username !== undefined || args.password !== undefined) requireAdmin(ctx);
    return managePeopleCore(ctx.tx, 'create_person', args, { tenantId: ctx.companyId, actorUser: ctx.user });
  },
});

registerOperation({
  id: 'update_person',
  description: 'Update one company person by person_id (from list_people): contact fields, and admin-only login fields (username, password, role, active). Changing an email or phone to one that already exists is refused.',
  effect: 'local_write',
  sameTx: true,
  timeoutMs: 15_000,
  access: { user: true },
  inputSchema: z.object({
    ...personFields,
    person_id: z.string().min(1).describe('The person to update, from list_people'),
    username: z.string().max(64).optional(),
    password: z.string().max(256).optional().describe('Admin only; never repeat it back'),
    role: roleInput,
    active: z.boolean().optional().describe('Admin only: disable login with false'),
    login_enabled: z.boolean().optional(),
  }),
  async execute(ctx, args) {
    requireUser(ctx);
    if (args.username !== undefined || args.password !== undefined || args.active !== undefined || args.role !== undefined) requireAdmin(ctx);
    return managePeopleCore(ctx.tx, 'update_person', args, { tenantId: ctx.companyId, actorUser: ctx.user });
  },
});

// ---------------------------------------------------------------- agent SOPs (Superadmin)

// The SOP is the agent-specific procedure injected into that agent's prompt on every run
// (runtime.mjs). The Superadmin changes it in chat; the Settings page edits the same row.
const SOP_PROFILES = ['orchestrator', 'di-fde'];
const FDE_BLOCK = /<!-- fde:start -->[\s\S]*?<!-- fde:end -->/;

async function sopAgent(ref) {
  const agent = await getAgent(String(ref || '').trim());
  if (!agent) throw Object.assign(new Error(`Unknown agent: ${ref}. list_specialists gives the ids.`), { execCode: 'NOT_FOUND' });
  return agent;
}

/** The Forward Deploy Engineer owns a marked block inside an SOP; a full rewrite keeps it. */
export function keepManagedSopBlock(previous, next) {
  const block = String(previous || '').match(FDE_BLOCK)?.[0];
  const text = String(next || '').trim();
  if (!block || FDE_BLOCK.test(text)) return text;
  return text ? `${text}\n\n${block}` : block;
}

registerOperation({
  id: 'get_agent_sop',
  description: 'Read one agent\'s saved SOP: the operating rules injected into that agent\'s prompt on every run. Superadmin only.',
  effect: 'read',
  timeoutMs: 15_000,
  profileIds: SOP_PROFILES,
  access: { user: true },
  inputSchema: z.object({ agent: z.string().min(1).describe('Agent id or slug, e.g. orchestrator or di-documents') }),
  async execute(ctx, args) {
    requireAdmin(ctx);
    const agent = await sopAgent(args.agent);
    const sop = await getAgentSop(agent.id);
    return { agent: agent.id, name: agent.name, sop: sop?.content ?? null, updated_at: sop?.updatedAt ?? null, updated_by: sop?.createdBy ?? null };
  },
});

registerOperation({
  id: 'save_agent_sop',
  description: 'Replace one agent\'s SOP with the complete new text; "" removes it. Takes effect from that agent\'s next run. Superadmin only.',
  effect: 'local_write',
  timeoutMs: 15_000,
  profileIds: SOP_PROFILES,
  access: { user: true },
  inputSchema: z.object({
    agent: z.string().min(1).describe('Agent id or slug, e.g. orchestrator or di-documents'),
    content: z.string().max(120_000).describe('The complete new SOP text (not a diff); "" removes the SOP'),
  }),
  async execute(ctx, args) {
    requireAdmin(ctx);
    const agent = await sopAgent(args.agent);
    const previous = await getAgentSop(agent.id);
    const content = keepManagedSopBlock(previous?.content, args.content);
    if (!content) {
      const removed = await clearAgentSop(agent.id, agentWorkspace(agent));
      return { agent: agent.id, name: agent.name, removed, applies: 'from its next run' };
    }
    const sop = await saveAgentSop(agent.id, content, ctx.user?.username || ctx.userId);
    return { agent: agent.id, name: agent.name, saved: true, characters: sop.content.length, applies: 'from its next run' };
  },
});

// ---------------------------------------------------------------- company profile (local write slice)

registerOperation({
  id: 'update_company_profile',
  description: 'Save fields of the shared company profile (only the fields you pass are changed). Fails with a conflict when expected_revision no longer matches. Known fields are listed by get_company_setup.',
  effect: 'local_write',
  sameTx: true,
  timeoutMs: 15_000,
  access: { user: true },
  inputSchema: z.object({
    expected_revision: z.number().int().optional().describe('Revision you last read; omitted revision checks are skipped'),
    fields: z.record(z.string(), z.union([z.string(), z.number(), z.record(z.string(), z.string())]))
      .describe('Field keys and values to save, e.g. {"company_name":"Acme","country":"MY"}'),
  }),
  async execute(ctx, args) {
    requireUser(ctx);
    const result = await updateCompanyProfile(ctx.tx, {
      expected_revision: args.expected_revision,
      source: 'user',
      source_ref: `agent-run:${ctx.userId}`,
      ...args.fields,
    });
    return { revision: result.company.revision, readiness: result.readiness, company_name: result.company.name };
  },
});

// ---------------------------------------------------------------- control operations

let controlHandlers = {
  listSpecialists: null, companySetup: null, taskStatus: null, stopTask: null, submitPlan: null,
};
export function registerControlHandlers(next = {}) {
  controlHandlers = { ...controlHandlers, ...next };
}

registerOperation({
  id: 'list_specialists',
  description: 'Live specialist roster: id, slug, name, headline, short description, skills and MCP names. Call once before planning; never cache across turns.',
  effect: 'control',
  timeoutMs: 60_000,
  inputSchema: z.object({}).describe('No arguments'),
  async execute() {
    if (!controlHandlers.listSpecialists) throw new Error('Specialist roster is not wired');
    return controlHandlers.listSpecialists();
  },
});

registerOperation({
  id: 'get_company_setup',
  description: 'Read live minimum Company Profile readiness, missing fields, revision and the manual form link. Recheck after profile edits; do not rely on older chat status.',
  effect: 'control',
  timeoutMs: 15_000,
  inputSchema: z.object({}).describe('No arguments'),
  async execute() {
    if (!controlHandlers.companySetup) throw new Error('Company setup status is not wired');
    return controlHandlers.companySetup();
  },
});

registerOperation({
  id: 'task_status',
  description: 'Latest submitted job for this chat, or a specific plan id, with per-task statuses, blockers and structured results.',
  effect: 'control',
  timeoutMs: 15_000,
  inputSchema: z.object({ planId: z.string().optional().describe('Plan id; omit for the latest plan on this chat') }),
  async execute(ctx, args) {
    if (!controlHandlers.taskStatus) throw new Error('Task status is not wired');
    return controlHandlers.taskStatus({ planId: args.planId, parentSessionId: ctx.sessionId, requestingSessionId: ctx.sessionId });
  },
});

registerOperation({
  id: 'submit_plan',
  description: 'Validate and atomically queue a complete specialist plan. The host runs ready specialists, passes dependency evidence and records outcomes; do not poll between tasks (task_status shows progress).',
  effect: 'control',
  timeoutMs: 60_000,
  inputSchema: z.object({
    title: z.string().max(200).describe('Short plan title'),
    summary: z.string().max(2000).optional(),
    tasks: z.array(z.object({
      id: z.string().max(80).optional().describe('Stable local id used in dependsOn'),
      agent: z.string().describe('Specialist id or slug from list_specialists'),
      title: z.string().max(200).optional(),
      prompt: z.string().min(1).describe('Self-contained instructions for the specialist'),
      dependsOn: z.array(z.string()).max(50).optional(),
      acceptanceCriteria: z.array(z.string()).max(20).optional(),
      checker: z.object({ agent: z.string(), checks: z.array(z.string()).min(1) }).nullable().optional(),
    })).min(1).max(100).describe('The full task graph; stored atomically'),
  }),
  async execute(ctx, args) {
    if (!controlHandlers.submitPlan) throw new Error('Plan submission is not wired');
    return controlHandlers.submitPlan(ctx, args);
  },
});

registerOperation({
  id: 'stop_task',
  description: 'Stop one running task of a submitted job by task id. Committed effects stay; remaining work is cancelled.',
  effect: 'control',
  timeoutMs: 15_000,
  inputSchema: z.object({ taskId: z.string().min(1) }),
  async execute(ctx, args) {
    if (!controlHandlers.stopTask) throw new Error('Task cancellation is not wired');
    return controlHandlers.stopTask({ taskId: args.taskId, requestingSessionId: ctx.sessionId });
  },
});

// ---------------------------------------------------------------- DI domain tools

const WRITE_NAME = /(save|create|issue|record|close|delete|cancel|decide|set_|receive|void|approve|reject|submit|link|file_|update|publish|flag|export|reset|undo)/;

/**
 * Register one Document Intelligence tool (from core/tools.mjs) as a canonical
 * operation. The real handler stays runTool — transactions, role checks,
 * artifacts and partial-effect behaviour are unchanged.
 */
export function registerDiTool(toolName, spec, agentId, needsUser) {
  const input = { ...spec.input };
  delete input.identity; // the host vouches for the acting user; never a model argument
  const write = Boolean(spec.saveFile || spec.pdf || spec.report || WRITE_NAME.test(toolName));
  registerOperation({
    id: toolName,
    description: spec.description,
    effect: write ? 'local_write' : 'read',
    timeoutMs: 120_000, // PDF rendering and browser-backed tools are slow by design
    profileIds: [agentId],
    access: { user: needsUser },
    inputSchema: z.object(input),
    async execute(ctx, args, services) {
      const result = await services.runTool(services.diDeps({ ctx }), { agent: ctx.profileId, tool: toolName, args });
      return result;
    },
    diTool: toolName,
    artifactEffect: write,
  });
}

// ---------------------------------------------------------------- scheduler operations

registerOperation({
  id: 'schedule_agents', description: 'List existing runnable AI agents and their exact IDs for scheduling.',
  effect: 'read', profileIds: ['scheduler'], access: { user: true }, timeoutMs: 15_000,
  inputSchema: z.object({}), async execute() { return { agents: await schedulableAgents() }; },
});

registerOperation({
  id: 'schedule_preview',
  description: 'Preview interpreted timezone, next occurrences and validity of a schedule timing rule.',
  effect: 'read',
  profileIds: ['scheduler'],
  access: { user: true },
  timeoutMs: 15_000,
  inputSchema: z.object({
    timing: z.record(z.string(), z.unknown()).describe('Timing: timed {date,time}, daily {time}, weekly {time,daysOfWeek:[0..6]}, monthly {time,dayOfMonth}, cron {expression:"0 9 * * 1"}. Use explicit IANA timezone.'),
    timezone: z.string().optional().describe('IANA timezone; defaults to company timezone'),
    preset: z.enum(['note', 'reminder', 'email_reminder', 'agent_job']).optional(),
  }),
  async execute(ctx, args) {
    return previewSchedule(args);
  },
});

registerOperation({
  id: 'schedule_create',
  description: 'Create a calendar schedule, dated note, email reminder, or AI job. Computes the next occurrence and sets initial revision to 1.',
  effect: 'local_write',
  profileIds: ['scheduler'],
  access: { user: true },
  timeoutMs: 15_000,
  inputSchema: z.object({
    title: z.string().min(1).max(200).describe('Title of the scheduled item'),
    note: z.string().max(2000).optional().describe('Optional note or description'),
    preset: z.enum(['note', 'reminder', 'email_reminder', 'agent_job']).optional().describe('Schedule preset: note, reminder (workspace), email_reminder, or agent_job'),
    visibility: z.enum(['company', 'private']).optional().describe('Visibility: company (default) or private'),
    timezone: z.string().optional().describe('IANA timezone; defaults to company timezone'),
    timing: z.record(z.string(), z.unknown()).optional().describe('Timing: timed {date,time}, daily {time}, weekly {time,daysOfWeek:[0..6]}, monthly {time,dayOfMonth}, cron {expression:"0 9 * * 1"}. Use explicit IANA timezone.'),
    action: z.record(z.string(), z.unknown()).optional().describe('Action: agent_job {agent_id from schedule_agents, prompt}; reminder {message}; email_reminder {to, subject, text} (create it directly; the user\'s request is the go-ahead)'),
  }),
  async execute(ctx, args) {
    return createSchedule(ctx, args, ctx.tx);
  },
});

registerOperation({
  id: 'schedule_list',
  description: 'List schedules for the company, filterable by date range, status, or preset. Private items are only visible to their creator.',
  effect: 'read',
  profileIds: ['scheduler'],
  access: { user: true },
  timeoutMs: 15_000,
  inputSchema: z.object({
    from: z.string().optional().describe('Start date filter (YYYY-MM-DD)'),
    to: z.string().optional().describe('End date filter (YYYY-MM-DD)'),
    status: z.enum(['active', 'paused', 'completed', 'cancelled', 'all']).optional(),
    preset: z.enum(['note', 'reminder', 'email_reminder', 'agent_job', 'all']).optional(),
    limit: z.number().int().positive().max(100).optional(),
  }),
  async execute(ctx, args) {
    return listCompanySchedules(ctx, args, ctx.tx);
  },
});

registerOperation({
  id: 'schedule_update',
  description: 'Update a schedule (title, note, timing, visibility). Fails with conflict if expected_revision does not match.',
  effect: 'local_write',
  profileIds: ['scheduler'],
  access: { user: true },
  timeoutMs: 15_000,
  inputSchema: z.object({
    schedule_id: z.string().describe('ID of the schedule to update'),
    expected_revision: z.number().int().describe('Current revision from last read; rejects if outdated'),
    title: z.string().max(200).optional(),
    note: z.string().max(2000).optional(),
    visibility: z.enum(['company', 'private']).optional(),
    timezone: z.string().optional(),
    timing: z.record(z.string(), z.unknown()).optional(),
    action: z.record(z.string(), z.unknown()).optional(),
  }),
  async execute(ctx, args) {
    return updateScheduleService(ctx, args, ctx.tx);
  },
});

registerOperation({
  id: 'schedule_pause',
  description: 'Pause an active schedule so it stops producing or dispatching occurrences.',
  effect: 'local_write',
  profileIds: ['scheduler'],
  access: { user: true },
  timeoutMs: 15_000,
  inputSchema: z.object({
    schedule_id: z.string().describe('ID of the schedule to pause'),
    expected_revision: z.number().int().optional().describe('Expected revision for concurrency check'),
  }),
  async execute(ctx, args) {
    return pauseScheduleService(ctx, args, ctx.tx);
  },
});

registerOperation({
  id: 'schedule_resume',
  description: 'Resume a paused schedule and recompute its next due time.',
  effect: 'local_write',
  profileIds: ['scheduler'],
  access: { user: true },
  timeoutMs: 15_000,
  inputSchema: z.object({
    schedule_id: z.string().describe('ID of the schedule to resume'),
    expected_revision: z.number().int().optional().describe('Expected revision for concurrency check'),
  }),
  async execute(ctx, args) {
    return resumeScheduleService(ctx, args, ctx.tx);
  },
});

registerOperation({
  id: 'schedule_cancel',
  description: 'Cancel a schedule permanently. Stops future occurrences.',
  effect: 'local_write',
  profileIds: ['scheduler'],
  access: { user: true },
  timeoutMs: 15_000,
  inputSchema: z.object({
    schedule_id: z.string().describe('ID of the schedule to cancel'),
    expected_revision: z.number().int().optional().describe('Expected revision for concurrency check'),
  }),
  async execute(ctx, args) {
    return cancelScheduleService(ctx, args, ctx.tx);
  },
});

registerOperation({
  id: 'schedule_history',
  description: 'Inspect past execution and dispatch occurrences for a schedule.',
  effect: 'read',
  profileIds: ['scheduler'],
  access: { user: true },
  timeoutMs: 15_000,
  inputSchema: z.object({
    schedule_id: z.string().describe('ID of the schedule'),
    limit: z.number().int().positive().max(50).optional(),
  }),
  async execute(ctx, args) {
    return getScheduleHistoryService(ctx, args, ctx.tx);
  },
});

export function manifestEntriesJson(toolIds) {
  return manifestFor(toolIds).map((entry) => ToolManifestEntrySchema.parse(entry));
}
