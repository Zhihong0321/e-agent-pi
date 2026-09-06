import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildPiArgs, resolveToolProfile, skillsNeedBash } from "./runtime.mjs";
import { NON_CODING_SYSTEM_PROMPT } from "./agent-profiles.mjs";

const baseOpts = {
  agent: { name: "Test Agent" },
  skills: [],
  mcpCount: 0,
  runtimeDir: "/runtime/test",
  provider: "cavoti",
  model: "gpt-5.6-luna",
};

test("buildPiArgs: coding profile keeps Pi's default prompt and built-in tools", () => {
  const args = buildPiArgs({ ...baseOpts, toolProfile: "coding" });
  assert.equal(args.includes("--system-prompt"), false);
  assert.equal(args.includes("--tools"), false);
  assert.equal(args.includes("--no-builtin-tools"), false);
});

test("buildPiArgs: ops profile swaps the system prompt and limits tools to read+bash", () => {
  const args = buildPiArgs({ ...baseOpts, toolProfile: "ops" });
  const promptIdx = args.indexOf("--system-prompt");
  assert.ok(promptIdx >= 0);
  assert.equal(args[promptIdx + 1], NON_CODING_SYSTEM_PROMPT);
  const toolsIdx = args.indexOf("--tools");
  assert.ok(toolsIdx >= 0);
  assert.equal(args[toolsIdx + 1], "read,bash");
  assert.equal(args.includes("--no-builtin-tools"), false);
});

test("buildPiArgs: assistant profile swaps the system prompt and disables built-in tools", () => {
  const args = buildPiArgs({ ...baseOpts, toolProfile: "assistant" });
  const promptIdx = args.indexOf("--system-prompt");
  assert.ok(promptIdx >= 0);
  assert.equal(args[promptIdx + 1], NON_CODING_SYSTEM_PROMPT);
  assert.equal(args.includes("--tools"), false);
  assert.equal(args.includes("--no-builtin-tools"), true);
});

test("buildPiArgs: an unknown profile falls back to coding", () => {
  const args = buildPiArgs({ ...baseOpts, toolProfile: "bogus" });
  assert.equal(args.includes("--system-prompt"), false);
  assert.equal(args.includes("--no-builtin-tools"), false);
});

test("buildPiArgs: a valid thinking level is passed through", () => {
  const args = buildPiArgs({ ...baseOpts, toolProfile: "coding", thinkingLevel: "low" });
  const idx = args.indexOf("--thinking");
  assert.ok(idx >= 0);
  assert.equal(args[idx + 1], "low");
});

test("buildPiArgs: an invalid or missing thinking level omits the flag", () => {
  assert.equal(buildPiArgs({ ...baseOpts, toolProfile: "coding", thinkingLevel: "extreme" }).includes("--thinking"), false);
  assert.equal(buildPiArgs({ ...baseOpts, toolProfile: "coding" }).includes("--thinking"), false);
});

test("skillsNeedBash / resolveToolProfile: assistant falls back to ops when a skill shells out", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-skill-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { mkdir } = await import("node:fs/promises");
  const bashSkillDir = path.join(dir, "curl-skill");
  await mkdir(bashSkillDir, { recursive: true });
  await writeFile(path.join(bashSkillDir, "SKILL.md"), "---\nname: curl-skill\n---\nRun `curl -sS https://example`.\n");

  const mcpOnlySkillDir = path.join(dir, "mcp-skill");
  await mkdir(mcpOnlySkillDir, { recursive: true });
  await writeFile(path.join(mcpOnlySkillDir, "SKILL.md"), "---\nname: mcp-skill\n---\nUse the `sales-data` MCP tools only.\n");

  assert.equal(await skillsNeedBash([{ dirPath: bashSkillDir }]), true);
  assert.equal(await skillsNeedBash([{ dirPath: mcpOnlySkillDir }]), false);
  assert.equal(await skillsNeedBash([]), false);

  const downgraded = await resolveToolProfile({ toolProfile: "assistant", slug: "sales" }, [{ dirPath: bashSkillDir }]);
  assert.equal(downgraded.profile, "ops");
  assert.ok(downgraded.warning && downgraded.warning.includes("sales"));

  const kept = await resolveToolProfile({ toolProfile: "assistant", slug: "sales" }, [{ dirPath: mcpOnlySkillDir }]);
  assert.equal(kept.profile, "assistant");
  assert.equal(kept.warning, null);

  const opsStaysOps = await resolveToolProfile({ toolProfile: "ops", slug: "package" }, [{ dirPath: bashSkillDir }]);
  assert.equal(opsStaysOps.profile, "ops");
  assert.equal(opsStaysOps.warning, null);
});
