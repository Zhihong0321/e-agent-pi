// Prompt lint: the rules the code no longer has must not come back through a prompt or a tool
// description. Every refusal of a signed-in owner so far came from prompt text describing an
// identity mechanism, a confirm flag or a domain limit that the code had already dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NON_CODING_SYSTEM_PROMPT } from './agent-profiles.mjs';
import { replyStyleSystemPrompt } from './reply-style.mjs';
import { listOperations } from './execution/registry.mjs';
import { manifestForAgent } from './execution/profiles.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function promptSources() {
  const sources = [
    { name: 'NON_CODING_SYSTEM_PROMPT', text: NON_CODING_SYSTEM_PROMPT },
    { name: 'reply style', text: replyStyleSystemPrompt() },
    { name: 'ee-mail tool', text: await readFile(path.join(ROOT, 'server', 'ee-mail-mcp-server.mjs'), 'utf8') },
    ...listOperations().map((op) => ({ name: `operation ${op.id}`, text: op.description || '' })),
  ];
  for (const file of await readdir(path.join(ROOT, 'agent', 'roles'))) {
    if (file.endsWith('.md')) sources.push({ name: `agent/roles/${file}`, text: await readFile(path.join(ROOT, 'agent', 'roles', file), 'utf8') });
  }
  for (const dir of await readdir(path.join(ROOT, 'agent', 'skills'))) {
    const text = await readFile(path.join(ROOT, 'agent', 'skills', dir, 'SKILL.md'), 'utf8').catch(() => null);
    if (text) sources.push({ name: `agent/skills/${dir}/SKILL.md`, text });
  }
  return sources;
}

const FORBIDDEN = [
  [/\[(Deploy|Procurement|Expense) identity/i, 'identity lines are gone: the host attaches the user to every call'],
  [/Pass it as `identity`|identity code/i, 'no identity code is handed to the model any more'],
  [/ask (them|the user) to sign in/i, 'a signed-in person is never sent to sign in again'],
  [/non-technical operator/i, 'the person chatting may be the Superadmin who owns the system'],
  [/(send_email|email_reminder)[^\n]*confirm(: |=)true/i, 'email tools take no confirm flag'],
  [/internal @eternalgy\.me|@eternalgy\.me recipients|external recipients are prohibited/i, 'email has no domain limit'],
  [/orchestrator-dispatch_/, 'the orchestrator-dispatch MCP is retired; tools are called by name'],
];

test('no prompt or tool description brings back a rule the code dropped', async () => {
  const problems = [];
  for (const { name, text } of await promptSources()) {
    for (const [pattern, why] of FORBIDDEN) {
      const hit = text.match(pattern);
      if (hit) problems.push(`${name}: "${hit[0]}" (${why})`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the orchestrator only routes: one tool, and a role that plans nothing and does no work', async () => {
  const role = await readFile(path.join(ROOT, 'agent', 'roles', 'orchestrator.md'), 'utf8');
  assert.match(role, /`route_request`/);
  // The planning and worker instructions that made routing random must not come back (AI-Orchestration-and-agent-design.md F-4, F-5).
  assert.doesNotMatch(role, /submit_plan|list_specialists|save_agent_sop|ee-mail__send_email|create_person|create_user|checker|pipeline|Never refuse/i);
  assert.deepEqual(manifestForAgent({ id: 'orchestrator', slug: 'orchestrator' }).manifest.toolIds, ['route_request']);
});
