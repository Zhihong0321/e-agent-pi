import assert from "node:assert/strict";
import { test } from "node:test";
import { isLeakedAgentCmd } from "./proc.mjs";
import { pickIdleSlots } from "./pi-idle.mjs";

function slot(id, { lastUsedAt, client = {}, booting, busy } = {}) {
  return { id, lastUsedAt, client, booting, busy };
}

test("keep the newest slot even when every Pi is idle", () => {
  const now = 1_000_000;
  const idle = pickIdleSlots(
    [
      slot("old", { lastUsedAt: now - 600_000 }),
      slot("warm", { lastUsedAt: now - 590_000 }),
      slot("older", { lastUsedAt: now - 800_000 }),
    ],
    { now, idleMs: 180_000, keepWarm: 1 },
  );
  assert.deepEqual(
    idle.map((s) => s.id).sort(),
    ["old", "older"],
  );
});

test("do not kill a recently used extra slot", () => {
  const now = 1_000_000;
  const idle = pickIdleSlots(
    [
      slot("website", { lastUsedAt: now - 5_000 }),
      slot("proposal", { lastUsedAt: now - 10_000 }),
    ],
    { now, idleMs: 180_000, keepWarm: 1 },
  );
  assert.deepEqual(idle, []);
});

test("never drop the last live Pi", () => {
  const now = 1_000_000;
  const idle = pickIdleSlots([slot("only", { lastUsedAt: now - 3_600_000 })], {
    now,
    idleMs: 180_000,
    keepWarm: 1,
  });
  assert.deepEqual(idle, []);
});

test("do not idle-evict a slot that is mid-turn", () => {
  const now = 1_000_000;
  const idle = pickIdleSlots(
    [
      slot("warm", { lastUsedAt: now }),
      slot("busy", { lastUsedAt: now - 600_000, busy: true }),
    ],
    { now, idleMs: 180_000, keepWarm: 1 },
  );
  assert.deepEqual(idle, []);
});

test("skip slots that are still booting", () => {
  const now = 1_000_000;
  const idle = pickIdleSlots(
    [
      slot("warm", { lastUsedAt: now }),
      slot("boot", { lastUsedAt: now - 600_000, booting: true }),
    ],
    { now, idleMs: 180_000, keepWarm: 1 },
  );
  assert.deepEqual(idle, []);
});

test("isLeakedAgentCmd matches Pi/MCP leftovers only", () => {
  assert.equal(isLeakedAgentCmd("node /app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), true);
  assert.equal(isLeakedAgentCmd("node .../pi-mcp-adapter/index.js"), true);
  assert.equal(isLeakedAgentCmd("/opt/scrapling/bin/scrapling mcp"), true);
  assert.equal(isLeakedAgentCmd("node server/index.mjs"), false);
  assert.equal(isLeakedAgentCmd("git status"), false);
  assert.equal(isLeakedAgentCmd("node server/catalog-cli.mjs"), false);
});
