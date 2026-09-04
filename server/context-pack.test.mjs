import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { agentEnv } from "./agent-env.mjs";
import { contextPackSlug, mergeTurns, needsAutoContinue, turnMetrics } from "./context-pack.mjs";
import { agentWorkspace, WORKSPACE, WORKSPACES_DIR } from "./paths.mjs";

test("agentEnv strips host secrets and does not grant PG_PROXY_TOKEN to website", () => {
  const from = {
    PATH: "/usr/bin",
    HOME: "/root",
    USER: "root",
    DATABASE_URL: "postgres://studio",
    CAVOTI_API_KEY: "secret",
    KIMI_API_KEY: "secret",
    EE_HTML_API_KEY: "k",
    GITHUB_TOKEN: "ghp_x",
    RAILWAY_ENVIRONMENT_NAME: "production",
    PI_CODING_AGENT_DIR: "/storage/runtime/x",
    CLOUD_PI_ROOT: "/app",
    SCRAPLING_BIN: "/opt/scrapling/bin/scrapling",
  };
  const website = agentEnv({ id: "website", slug: "website" }, {}, from);
  assert.equal(website.DATABASE_URL, undefined);
  assert.equal(website.CAVOTI_API_KEY, undefined);
  assert.equal(website.KIMI_API_KEY, undefined);
  assert.equal(website.EE_HTML_API_KEY, undefined);
  assert.equal(website.GITHUB_TOKEN, undefined);
  assert.equal(website.RAILWAY_ENVIRONMENT_NAME, undefined);
  assert.equal(website.PG_PROXY_TOKEN, undefined);
  assert.ok(website.PATH);
  assert.ok(website.HOME);
  assert.equal(website.PI_CODING_AGENT_DIR, "/storage/runtime/x");
  assert.ok(website.CLOUD_PI_CATALOG);
});

test("needsAutoContinue catches incomplete tool turns", () => {
  assert.equal(
    needsAutoContinue({ text: "Let me read the i18n logic…", blocks: [{ type: "tool", name: "read" }] }),
    true,
  );
  assert.equal(
    needsAutoContinue({ text: "I'll update the file", blocks: [{ type: "tool", name: "read" }] }),
    true,
  );
  assert.equal(needsAutoContinue({ text: "", blocks: [{ type: "tool", name: "read" }] }), true);
  assert.equal(
    needsAutoContinue({
      text: "Changed styles.css. Live at https://x.",
      blocks: [{ type: "tool", name: "edit" }],
    }),
    false,
  );
  assert.equal(
    needsAutoContinue({ text: "Let me know if you want more?", blocks: [{ type: "tool", name: "read" }] }),
    false,
  );
  assert.equal(needsAutoContinue({ text: "Let me read it", blocks: [] }), false);
});

test("mergeTurns keeps final text and concatenates blocks", () => {
  const merged = mergeTurns(
    { text: "Let me…", blocks: [{ type: "tool", name: "read" }] },
    { text: "Done. Fonts fixed.", blocks: [{ type: "text", text: "Done. Fonts fixed." }] },
  );
  assert.equal(merged.text, "Done. Fonts fixed.");
  assert.equal(merged.blocks.length, 2);
});

test("turnMetrics counts tools and first edit", () => {
  const metrics = turnMetrics(
    {
      text: "ok",
      blocks: [
        { type: "tool", name: "read_file" },
        { type: "tool", name: "grep_search" },
        { type: "tool", name: "replace_file_content" },
      ],
    },
    { autoContinues: 1 },
  );
  assert.equal(metrics.toolCalls, 3);
  assert.equal(metrics.callsBeforeFirstEdit, 3);
  assert.equal(metrics.autoContinues, 1);
  assert.equal(metrics.endedWithoutText, false);
});

test("contextPackSlug maps ops to settings", () => {
  assert.equal(contextPackSlug({ id: "ops", slug: "settings" }), "settings");
  assert.equal(contextPackSlug({ id: "website", slug: "website" }), "website");
  assert.equal(contextPackSlug({ id: "proposal", slug: "proposal" }), "proposal");
});

test("agentWorkspace isolates unknown agents from the website folder", () => {
  assert.equal(agentWorkspace({ id: "website", slug: "website" }), WORKSPACE);
  assert.equal(agentWorkspace({ id: "ops", slug: "settings" }), path.join(WORKSPACES_DIR, "settings"));
  const created = agentWorkspace({ id: "abc", slug: "test" });
  assert.equal(created, path.join(WORKSPACES_DIR, "test"));
  assert.notEqual(created, WORKSPACE);
});
