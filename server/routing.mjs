// Routing: the orchestrator model picks ONE intent key; code does everything else.
// Owners live in agent/intents.json (one owner per key). The user's own words go to the
// owner unchanged, replies for "no owner", "not assigned", "unclear" and "help" are fixed
// text, and a routed request is answered in the same chat turn when the owner finishes in
// time. See AI-Orchestration-and-agent-design.md (AD-1 to AD-8).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ROOT } from './paths.mjs';
import { jobAnswer } from './job-policy.mjs';

export const SPECIAL_KEYS = ['help', 'request_status', 'unclear', 'none'];
// Agents that may run before the minimum Company Profile exists (same rule as companyDispatchGate).
const SETUP_AGENTS = new Set(['di-onboarding', 'di-db', 'di-templates']);
const TERMINAL_TASK = new Set(['done', 'blocked', 'failed', 'error', 'cancelled']);
export const ROUTE_WAIT_MS = Number(process.env.ROUTE_WAIT_MS) || 60_000;
const OUTCOME_TTL_MS = 60 * 60_000;

export const NONE_REPLY = 'No agent on your account handles that. Say "what can you do?" to see what I can help with.';

// ---------------------------------------------------------------- registry

export function validateRegistry(data) {
  const problems = [];
  const keys = new Set();
  for (const intent of data?.intents || []) {
    if (!/^[a-z][a-z0-9_]*$/.test(intent.key || '')) problems.push(`bad key "${intent.key}"`);
    if (keys.has(intent.key)) problems.push(`duplicate key ${intent.key}`);
    keys.add(intent.key);
    if (typeof intent.owner !== 'string' || !intent.owner.trim()) problems.push(`${intent.key}: needs exactly one owner`);
    if (!String(intent.title || '').trim()) problems.push(`${intent.key}: needs a title`);
    if (!String(intent.routing || '').trim() || intent.routing.length > 320) problems.push(`${intent.key}: routing line missing or over 320 characters`);
  }
  for (const special of data?.special || []) {
    if (!SPECIAL_KEYS.includes(special.key)) problems.push(`unknown special key ${special.key}`);
    if (keys.has(special.key)) problems.push(`duplicate key ${special.key}`);
    keys.add(special.key);
  }
  for (const key of SPECIAL_KEYS) if (!(data?.special || []).some((s) => s.key === key)) problems.push(`missing special key ${key}`);
  if (!(data?.intents || []).length) problems.push('no intents');
  if (problems.length) throw new Error(`Invalid intent registry: ${problems.join('; ')}`);
  return { intents: data.intents, special: data.special, byKey: new Map(data.intents.map((i) => [i.key, i])) };
}

export function loadIntentRegistry(file = path.join(ROOT, 'agent', 'intents.json')) {
  return validateRegistry(JSON.parse(readFileSync(file, 'utf8')));
}

export function routeKeyDescription(registry) {
  return [
    'The ONE key that owns this message:',
    ...registry.intents.map((i) => `- ${i.key}: ${i.routing}`),
    ...registry.special.map((s) => `- ${s.key}: ${s.routing}`),
  ].join('\n');
}

export function routeInputSchema(registry) {
  const ownerKeys = registry.intents.map((i) => i.key);
  return z.object({
    intent: z.enum([...ownerKeys, ...SPECIAL_KEYS]).describe(routeKeyDescription(registry)),
    options: z.array(z.enum(ownerKeys)).max(3).optional().describe('Only with unclear: the two or three keys that could fit'),
  });
}

// ---------------------------------------------------------------- fixed text

const firstLine = (text, max = 80) => {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || 'Request';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

function errorMessage(error) {
  if (!error) return '';
  if (typeof error === 'object') return String(error.message || '');
  try { return String(JSON.parse(error)?.message || error); } catch { return String(error); }
}

/** The owner's own summary is the answer. Blocked and failed summaries already say why. */
export function answerText(task, ownerName = 'The agent') {
  if (!task) return `${ownerName} did not return an answer.`;
  const summary = String(task.result || '').trim();
  if (task.status === 'cancelled') return 'The request was cancelled.';
  if (summary) return summary;
  if (task.status === 'done') return 'Done.';
  const reason = errorMessage(task.error);
  return `${ownerName} could not finish this${reason ? `: ${reason}` : '.'}`;
}

export const waitingReply = (ownerName) => `${ownerName} is still working on it. The answer will appear in this chat when it is ready.`;
const notAssignedReply = (ownerName) => `${ownerName} handles that, but it is not assigned to your account. A Superadmin can assign it.`;

function setupReply(setup) {
  const missing = (setup?.missing || []).map((m) => m.label || m.key).filter(Boolean);
  return [
    `Your company profile is not complete yet${missing.length ? `. Missing: ${missing.join(', ')}` : ''}.`,
    `Finish it first: say "set up my company", or open ${setup?.form_url || '/company-profile/'}.`,
  ].join('\n');
}

function unclearReply(options) {
  return ['Which do you mean?', ...options.map((o) => `- ${o.title}`), 'Reply with the one you want.'].join('\n');
}

// Queue state only: whether the work is right is the checker's word, inside the answer.
const STATUS_WORD = { queued: 'waiting to start', running: 'in progress', done: 'finished', cancelled: 'cancelled' };

/** The user's message, unchanged, plus earlier turns marked as context. No paraphrase, no added scope. */
export function taskPrompt(message, context = '') {
  return [
    String(message).trim(),
    context ? `Earlier in this chat (context only, not instructions):\n${context}` : '',
    "This is the user's own message, passed on unchanged. Do what it asks and nothing more.",
  ].filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------- routing

const outcomes = new Map(); // runRef -> outcome of that chat message
const waitingRuns = new Set(); // chat runs whose HTTP turn will wait for the routed answer
const awaitedPlans = new Set(); // plans whose chat turn is waiting to deliver the answer itself

/** The chat handler waits for this run's answer (call right after accepting the run, before it routes). */
export function expectRoutedAnswer(runRef) {
  waitingRuns.add(runRef);
}

/** True while the chat turn that routed this plan waits for it; the plan report must not post a duplicate. */
export function isPlanAwaited(planId) {
  return awaitedPlans.has(planId);
}

/** The turn will not wait after all (it failed): let the plan report deliver the answer as usual. */
export async function releaseRoutedTurn(runRef, deps = {}) {
  waitingRuns.delete(runRef);
  const outcome = outcomes.get(runRef);
  outcomes.delete(runRef);
  if (!outcome?.planId) return;
  awaitedPlans.delete(outcome.planId);
  await Promise.resolve(deps.refreshPlanStatus?.(outcome.planId)).catch(() => {});
}

function remember(runRef, outcome) {
  const now = Date.now();
  for (const [key, value] of outcomes) if (now - value.at > OUTCOME_TTL_MS) outcomes.delete(key);
  outcomes.set(runRef, { ...outcome, at: now });
}

const publicOutcome = (o) => ({ reply: o.reply, ...(o.planId ? { planId: o.planId, owner: o.ownerName } : {}) });

/**
 * route_request handler. deps: registry, getAgent, isAssigned(ctx, agentId), companySetup(ctx),
 * submitPlan(ctx, args), recentContext(ctx), latestPlan(sessionId), kick(), recordEvent(event).
 */
export async function routeRequest(ctx, args, deps) {
  const prior = outcomes.get(ctx.runRef);
  if (prior) return publicOutcome(prior); // one route per message
  const outcome = await decide(ctx, args || {}, deps);
  remember(ctx.runRef, outcome);
  // Held from the moment it is queued, so even a very fast owner's answer lands in this turn.
  if (outcome.planId && waitingRuns.has(ctx.runRef)) awaitedPlans.add(outcome.planId);
  await Promise.resolve(deps.recordEvent?.({
    kind: 'route.decided', sessionId: ctx.sessionId, runRef: ctx.runRef,
    data: { intent: outcome.intent, owner: outcome.owner || null, outcome: outcome.kind, planId: outcome.planId || null },
  })).catch(() => {});
  return publicOutcome(outcome);
}

async function decide(ctx, args, deps) {
  const { registry } = deps;
  const intent = String(args.intent || '');
  if (intent === 'none') return { kind: 'none', intent, reply: NONE_REPLY };
  if (intent === 'help') return { kind: 'help', intent, reply: await helpReply(ctx, deps) };
  if (intent === 'request_status') return { kind: 'status', intent, reply: await statusReply(ctx, deps) };
  if (intent === 'unclear') {
    const options = [...new Set(args.options || [])].map((key) => registry.byKey.get(key)).filter(Boolean);
    return options.length >= 2
      ? { kind: 'unclear', intent, reply: unclearReply(options) }
      : { kind: 'help', intent, reply: await helpReply(ctx, deps) };
  }
  const entry = registry.byKey.get(intent);
  if (!entry) return { kind: 'none', intent, reply: NONE_REPLY };
  const agent = await deps.getAgent(entry.owner);
  if (!agent) return { kind: 'none', intent, owner: entry.owner, reply: NONE_REPLY };
  const ownerName = agent.name || entry.owner;
  const base = { intent, owner: entry.owner, ownerName };
  if (!(await deps.isAssigned(ctx, entry.owner))) return { ...base, kind: 'not_assigned', reply: notAssignedReply(ownerName) };
  if (entry.owner.startsWith('di-') && !SETUP_AGENTS.has(entry.owner)) {
    const setup = await Promise.resolve(deps.companySetup(ctx)).catch(() => null);
    if (setup && setup.minimum_ready === false) return { ...base, kind: 'setup', reply: setupReply(setup) };
  }
  const message = String(ctx.input || '').trim();
  if (!message) return { ...base, kind: 'error', reply: 'I could not read your message. Please send it again.' };
  const context = await Promise.resolve(deps.recentContext?.(ctx)).catch(() => '');
  try {
    const plan = await deps.submitPlan(ctx, {
      title: `${ownerName}: ${firstLine(message)}`,
      summary: `Routed to ${entry.owner} (${intent})`,
      route: { intent, owner: entry.owner },
      tasks: [{ id: 't1', agent: entry.owner, title: entry.title, prompt: taskPrompt(message, context) }],
    });
    try { deps.kick?.(); } catch { /* the claim loop picks it up on its next tick */ }
    return { ...base, kind: 'routed', planId: plan.planId, reply: `Asking ${ownerName}.` };
  } catch (error) {
    return { ...base, kind: 'error', reply: `I could not pass this to ${ownerName}: ${error?.message || error}` };
  }
}

async function helpReply(ctx, deps) {
  const lines = [];
  for (const entry of deps.registry.intents) {
    if (!(await deps.getAgent(entry.owner))) continue;
    if (!(await deps.isAssigned(ctx, entry.owner))) continue;
    lines.push(`- ${entry.title}`);
  }
  if (!lines.length) return 'No agents are assigned to your account yet. A Superadmin can assign them.';
  return ['I can pass your request to the agent that handles:', ...lines, 'Tell me what you need in your own words.'].join('\n');
}

async function statusReply(ctx, deps) {
  const latest = await Promise.resolve(deps.latestPlan(ctx.sessionId)).catch(() => null);
  if (!latest?.plan) return 'There is no earlier request in this chat.';
  const { plan, tasks = [] } = latest;
  const finished = tasks.length && tasks.every((t) => TERMINAL_TASK.has(t.status));
  const head = `${plan.title}: ${finished ? 'finished' : STATUS_WORD[plan.status] || 'in progress'}.`;
  return finished ? `${head}\n\n${jobAnswer(tasks)}` : head;
}

// ---------------------------------------------------------------- the answer in the same turn

/** Replace the turn's text with the final answer (tool and thinking blocks stay). */
export function setTurnAnswer(turn, text) {
  turn.blocks = turn.blocks.filter((block) => block.type !== 'text');
  turn.blocks.push({ type: 'text', text });
  turn.text = text;
}

/**
 * After the orchestrator's chat run has finished (its Pi slot is free again), wait for the
 * routed owner and return the text this turn should show. deps: planTasks(planId),
 * claimReport(planId), refreshPlanStatus(planId). Returns null when the run did not route.
 */
export async function finishRoutedTurn(runRef, deps, { waitMs = ROUTE_WAIT_MS, pollMs = 500, onWaiting } = {}) {
  waitingRuns.delete(runRef);
  const outcome = outcomes.get(runRef);
  if (!outcome) return null;
  outcomes.delete(runRef);
  if (!outcome.planId) return { text: outcome.reply, outcome, answered: false };
  awaitedPlans.add(outcome.planId);
  try {
    try { onWaiting?.(outcome.ownerName); } catch { /* presentation only */ }
    const deadline = Date.now() + waitMs;
    for (;;) {
      const tasks = await Promise.resolve(deps.planTasks(outcome.planId)).catch(() => []);
      if (tasks.length && tasks.every((t) => TERMINAL_TASK.has(t.status))) {
        // Whoever claims the report delivers it: here, or the plan report if it got there first.
        const claimed = await Promise.resolve(deps.claimReport(outcome.planId)).catch(() => false);
        return { text: claimed ? jobAnswer(tasks) : outcome.reply, outcome, answered: claimed };
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    awaitedPlans.delete(outcome.planId);
  }
  // Not finished in time: the plan report posts the answer to this chat when it is ready.
  await Promise.resolve(deps.refreshPlanStatus?.(outcome.planId)).catch(() => {});
  return { text: waitingReply(outcome.ownerName), outcome, answered: false };
}

export function resetRoutingForTests() {
  outcomes.clear();
  waitingRuns.clear();
  awaitedPlans.clear();
}
