// Prompt budgets (AD-9): role prompts may shrink, never grow past agent/prompt-budgets.json.
// Growing a prompt is the last rung of the fix ladder; see AI-Orchestration-and-agent-design.md section 10.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRoleText } from './runtime.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const budgets = JSON.parse(await readFile(path.join(ROOT, 'agent', 'prompt-budgets.json'), 'utf8'));
// Count characters the model reads: a Windows checkout's CRLF must not count against the budget.
const readText = async (file) => (await readFile(file, 'utf8')).replaceAll('\r\n', '\n');

test('every role prompt has a budget and stays within it', async () => {
  const problems = [];
  for (const file of (await readdir(path.join(ROOT, 'agent', 'roles'))).filter((f) => f.endsWith('.md'))) {
    const id = file.replace(/\.md$/, '');
    const size = (await readText(path.join(ROOT, 'agent', 'roles', file))).length;
    const cap = budgets.roles[id];
    if (!cap) problems.push(`${file}: no budget in agent/prompt-budgets.json`);
    else if (size > cap) problems.push(`${file}: ${size} characters, budget ${cap}`);
  }
  assert.deepEqual(problems, []);
});

test('the orchestrator runs on its role file alone: no host notes, SOP or context pack appended', async () => {
  const role = await readText(path.join(ROOT, 'agent', 'roles', 'orchestrator.md'));
  const assembled = await buildRoleText({ id: 'orchestrator', slug: 'orchestrator', rolePrompt: role });
  assert.equal(assembled, `${role.trim()}\n`);
  assert.ok(assembled.length <= budgets.orchestratorAssembled, `${assembled.length} > ${budgets.orchestratorAssembled}`);
});
