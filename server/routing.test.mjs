// Routing contract: the model picks a key, code decides everything else (AI-Orchestration-and-agent-design.md AD-1 to AD-8).
import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS as DI_AGENTS } from '../document_inteligence/core/tools.mjs';
import { isPlatformAgent } from './paths.mjs';
import {
  NONE_REPLY, SPECIAL_KEYS, answerText, expectRoutedAnswer, finishRoutedTurn, isPlanAwaited, loadIntentRegistry, releaseRoutedTurn, resetRoutingForTests,
  routeInputSchema, routeRequest, setTurnAnswer, taskPrompt, validateRegistry, waitingReply,
} from './routing.mjs';

const SPECIAL = SPECIAL_KEYS.map((key) => ({ key, routing: key }));
const registry = validateRegistry({
  intents: [
    { key: 'customers_products', owner: 'di-records', title: 'Customers and products', routing: 'customers' },
    { key: 'quotes_invoices', owner: 'di-documents', title: 'Quotations and invoices', routing: 'invoices' },
    { key: 'company_profile', owner: 'di-onboarding', title: 'Company profile', routing: 'profile' },
    { key: 'ads_research', owner: 'ads-research', title: 'Ads research', routing: 'ads' },
  ],
  special: SPECIAL,
});
const AGENT_ROWS = {
  'di-records': { id: 'di-records', name: 'Records Clerk' },
  'di-documents': { id: 'di-documents', name: 'Document Agent' },
  'di-onboarding': { id: 'di-onboarding', name: 'Company Onboarding' },
};

function fakeDeps(over = {}) {
  const calls = { plans: [], events: [], kicks: 0 };
  const deps = {
    registry,
    getAgent: async (id) => AGENT_ROWS[id] || null,
    isAssigned: async () => true,
    companySetup: async () => ({ minimum_ready: true }),
    submitPlan: async (ctx, args) => { calls.plans.push(args); return { planId: `plan-${calls.plans.length}` }; },
    recentContext: async () => '',
    latestPlan: async () => ({ plan: null, tasks: [] }),
    kick: () => { calls.kicks += 1; },
    recordEvent: async (event) => { calls.events.push(event); },
    ...over,
  };
  return { deps, calls };
}

let runSeq = 0;
const ctxFor = (input, over = {}) => ({ runRef: `run-${++runSeq}`, sessionId: 's1', userId: 'u1', companyId: 'c1', input, ...over });

test('the shipped intent registry is valid: one company agent per key, never a platform agent or the orchestrator', () => {
  const shipped = loadIntentRegistry();
  const companyAgents = new Set([...Object.keys(DI_AGENTS), 'scheduler', 'company-deep-research', 'ads-research', 'media-ai']);
  for (const intent of shipped.intents) {
    assert.ok(companyAgents.has(intent.owner), `${intent.key}: owner ${intent.owner} is not a company agent`);
    assert.ok(!isPlatformAgent(intent.owner), `${intent.key}: ${intent.owner} is a platform agent`);
  }
  assert.deepEqual(shipped.special.map((s) => s.key).sort(), [...SPECIAL_KEYS].sort());
});

test('the registry refuses duplicate keys, a missing owner and missing special keys', () => {
  const ok = { key: 'a_b', owner: 'di-records', title: 'A', routing: 'a' };
  assert.throws(() => validateRegistry({ intents: [ok, ok], special: SPECIAL }), /duplicate key a_b/);
  assert.throws(() => validateRegistry({ intents: [{ ...ok, owner: '' }], special: SPECIAL }), /needs exactly one owner/);
  assert.throws(() => validateRegistry({ intents: [ok], special: SPECIAL.slice(1) }), /missing special key help/);
  assert.throws(() => validateRegistry({ intents: [{ ...ok, routing: 'x'.repeat(321) }], special: SPECIAL }), /over 320/);
});

test('the router can only pick a known key', () => {
  const schema = routeInputSchema(registry);
  assert.equal(schema.safeParse({ intent: 'customers_products' }).success, true);
  assert.equal(schema.safeParse({ intent: 'none' }).success, true);
  assert.equal(schema.safeParse({ intent: 'prototyper' }).success, false);
  assert.equal(schema.safeParse({ intent: 'unclear', options: ['help'] }).success, false);
});

test('a routed message becomes ONE task for the owner carrying the user\'s own words, once', async () => {
  resetRoutingForTests();
  const { deps, calls } = fakeDeps({ recentContext: async () => 'User: hi\nAssistant: hello' });
  const ctx = ctxFor('Add this name card.\nUploaded files:\n[{"link":"/files/x/card.png"}]');
  const first = await routeRequest(ctx, { intent: 'customers_products' }, deps);
  assert.deepEqual(first, { reply: 'Asking Records Clerk.', planId: 'plan-1', owner: 'Records Clerk' });
  assert.equal(calls.plans.length, 1);
  const [plan] = calls.plans;
  assert.deepEqual(plan.route, { intent: 'customers_products', owner: 'di-records' });
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].agent, 'di-records');
  assert.ok(plan.tasks[0].prompt.startsWith(ctx.input), 'the owner reads the message exactly as typed');
  assert.match(plan.tasks[0].prompt, /Earlier in this chat \(context only, not instructions\):\nUser: hi/);
  assert.equal(calls.kicks, 1);
  assert.deepEqual(calls.events[0].data, { intent: 'customers_products', owner: 'di-records', outcome: 'routed', planId: 'plan-1' });
  // The model calling the tool again for the same message changes nothing.
  assert.deepEqual(await routeRequest(ctx, { intent: 'quotes_invoices' }, deps), first);
  assert.equal(calls.plans.length, 1);
});

test('no owner, a missing agent or an unassigned owner gets fixed text and no plan', async () => {
  resetRoutingForTests();
  const { deps, calls } = fakeDeps({ isAssigned: async (ctx, agentId) => agentId !== 'di-documents' });
  assert.equal((await routeRequest(ctx(), { intent: 'none' }, deps)).reply, NONE_REPLY);
  assert.equal((await routeRequest(ctx(), { intent: 'ads_research' }, deps)).reply, NONE_REPLY); // agent not installed
  assert.equal((await routeRequest(ctx(), { intent: 'quotes_invoices' }, deps)).reply,
    'Document Agent handles that, but it is not assigned to your account. A Superadmin can assign it.');
  assert.equal(calls.plans.length, 0);
  function ctx() { return ctxFor('x'); }
});

test('operational work waits for the minimum company profile; setup agents do not', async () => {
  resetRoutingForTests();
  const setup = { minimum_ready: false, missing: [{ key: 'business_type', label: 'Business type' }], form_url: '/company-profile/' };
  const { deps, calls } = fakeDeps({ companySetup: async () => setup });
  const blocked = await routeRequest(ctxFor('Add a customer'), { intent: 'customers_products' }, deps);
  assert.equal(blocked.reply, 'Your company profile is not complete yet. Missing: Business type.\nFinish it first: say "set up my company", or open /company-profile/.');
  assert.equal(calls.plans.length, 0);
  const setupRoute = await routeRequest(ctxFor('Our business type is solar'), { intent: 'company_profile' }, deps);
  assert.equal(setupRoute.planId, 'plan-1');
});

test('help lists only what this login can reach; unclear asks once; status reads the last request', async () => {
  resetRoutingForTests();
  const { deps } = fakeDeps({
    isAssigned: async (ctx, agentId) => agentId !== 'di-onboarding',
    latestPlan: async () => ({ plan: { title: 'Records Clerk: Add ACME', status: 'done' }, tasks: [{ status: 'done', result: 'ACME saved as C-0001.' }] }),
  });
  const help = (await routeRequest(ctxFor('hi'), { intent: 'help' }, deps)).reply;
  assert.match(help, /- Customers and products/);
  assert.doesNotMatch(help, /Company profile|Ads research/);
  assert.equal((await routeRequest(ctxFor('x'), { intent: 'unclear', options: ['customers_products', 'quotes_invoices'] }, deps)).reply,
    'Which do you mean?\n- Customers and products\n- Quotations and invoices\nReply with the one you want.');
  assert.match((await routeRequest(ctxFor('x'), { intent: 'unclear', options: ['customers_products'] }, deps)).reply, /^I can pass your request/);
  assert.equal((await routeRequest(ctxFor('how is it going'), { intent: 'request_status' }, deps)).reply, 'Records Clerk: Add ACME: finished.\n\nACME saved as C-0001.');
});

test('a failed hand-off is reported as fixed text, not improvised', async () => {
  resetRoutingForTests();
  const { deps } = fakeDeps({ submitPlan: async () => { throw new Error('The service is draining for restart'); } });
  assert.equal((await routeRequest(ctxFor('Add a customer'), { intent: 'customers_products' }, deps)).reply,
    'I could not pass this to Records Clerk: The service is draining for restart');
});

test('the routed answer arrives in the same turn, and the plan report stays quiet while the turn waits', async () => {
  resetRoutingForTests();
  const { deps } = fakeDeps();
  const ctx = ctxFor('Do we already have a product with SKU X?');
  await routeRequest(ctx, { intent: 'customers_products' }, deps);
  let polls = 0;
  const seenAwaited = [];
  const finish = await finishRoutedTurn(ctx.runRef, {
    planTasks: async (planId) => { seenAwaited.push(isPlanAwaited(planId)); return ++polls < 3 ? [{ status: 'running' }] : [{ status: 'done', result: 'No product has SKU X.' }]; },
    claimReport: async () => true,
  }, { pollMs: 1 });
  assert.equal(finish.text, 'No product has SKU X.');
  assert.equal(finish.answered, true);
  assert.ok(seenAwaited.every(Boolean));
  assert.equal(isPlanAwaited('plan-1'), false);
  assert.equal(await finishRoutedTurn(ctx.runRef, {}), null, 'one answer per run');
});

test('a report that got there first is not repeated; a slow owner leaves a waiting note and the report posts later', async () => {
  resetRoutingForTests();
  const { deps } = fakeDeps();
  const fast = ctxFor('a');
  await routeRequest(fast, { intent: 'customers_products' }, deps);
  const raced = await finishRoutedTurn(fast.runRef, { planTasks: async () => [{ status: 'done', result: 'x' }], claimReport: async () => false });
  assert.equal(raced.text, 'Asking Records Clerk.');

  const slow = ctxFor('b');
  await routeRequest(slow, { intent: 'customers_products' }, deps);
  const refreshed = [];
  const late = await finishRoutedTurn(slow.runRef, {
    planTasks: async () => [{ status: 'running' }], claimReport: async () => true, refreshPlanStatus: async (id) => { refreshed.push([id, isPlanAwaited(id)]); },
  }, { waitMs: 5, pollMs: 1 });
  assert.equal(late.text, waitingReply('Records Clerk'));
  assert.deepEqual(refreshed, [['plan-2', false]]);
});

test('a waiting chat holds the plan from the moment it is routed; a failed turn or an unwatched run lets the report post', async () => {
  resetRoutingForTests();
  const { deps } = fakeDeps();
  const watched = ctxFor('a');
  expectRoutedAnswer(watched.runRef);
  const { planId } = await routeRequest(watched, { intent: 'customers_products' }, deps);
  assert.equal(isPlanAwaited(planId), true, 'held before the turn even starts waiting');
  const refreshed = [];
  await releaseRoutedTurn(watched.runRef, { refreshPlanStatus: async (id) => { refreshed.push(id); } });
  assert.equal(isPlanAwaited(planId), false);
  assert.deepEqual(refreshed, [planId]);

  const scheduled = ctxFor('b', { sessionId: 'schedule:occ-1' });
  const other = await routeRequest(scheduled, { intent: 'customers_products' }, deps);
  assert.equal(isPlanAwaited(other.planId), false, 'nobody waits for a scheduled run: its report posts normally');
});

test('fixed answers: the owner\'s own summary, or why it could not finish', () => {
  assert.equal(answerText({ status: 'done', result: 'Saved.' }, 'X'), 'Saved.');
  assert.equal(answerText({ status: 'blocked', result: 'Need the unit price.' }, 'X'), 'Need the unit price.');
  assert.equal(answerText({ status: 'failed', result: '', error: JSON.stringify({ code: 'E', message: 'tool crashed' }) }, 'X'), 'X could not finish this: tool crashed');
  assert.equal(answerText({ status: 'cancelled' }, 'X'), 'The request was cancelled.');
  assert.equal(taskPrompt('Hi'), "Hi\n\nThis is the user's own message, passed on unchanged. Do what it asks and nothing more.");
});

test('the final answer replaces the streamed text and keeps the tool trail', () => {
  const turn = { text: 'Asking Records Clerk.', blocks: [{ type: 'tool', id: 't', name: 'route_request', detail: '' }, { type: 'text', text: 'Asking Records Clerk.' }] };
  setTurnAnswer(turn, 'No product has SKU X.');
  assert.equal(turn.text, 'No product has SKU X.');
  assert.deepEqual(turn.blocks.map((b) => b.type), ['tool', 'text']);
  assert.equal(turn.blocks[1].text, 'No product has SKU X.');
});
