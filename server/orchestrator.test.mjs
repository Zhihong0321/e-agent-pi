import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertNotSelfDispatch,
  capabilityCard,
  clipResult,
  dispatchGate,
  maxParallelSlots,
  RESULT_CHARS,
} from "./orchestrator.mjs";

test("clipResult truncates at the cap", () => {
  assert.equal(clipResult("short"), "short");
  const long = "x".repeat(RESULT_CHARS + 50);
  const clipped = clipResult(long);
  assert.ok(clipped.startsWith("x".repeat(20)));
  assert.ok(clipped.endsWith("…(truncated)"));
  assert.ok(clipped.length < long.length);
});

test("capabilityCard projects skills and MCP without secrets", () => {
  const card = capabilityCard({
    id: "sales",
    slug: "sales",
    name: "Sales and Procurement",
    headline: "Sales, payment status, and stock on hand",
    description: "Read-only into prod_main.",
    toolProfile: "ops",
    skills: [{ name: "sales-reports", description: "pg-proxy SQL", secret: "nope" }],
    mcp: [{ name: "Sales Data Tools", description: "HTML reports", env: { TOKEN: "x" } }],
  });
  assert.equal(card.id, "sales");
  assert.equal(card.skills[0].name, "sales-reports");
  assert.equal(card.mcp[0].name, "Sales Data Tools");
  assert.equal(card.skills[0].secret, undefined);
  assert.equal(card.mcp[0].env, undefined);
});

test("dispatch to Orchestrator is refused", () => {
  assert.throws(() => assertNotSelfDispatch("orchestrator"), /Cannot dispatch to Orchestrator/);
  assert.throws(() => assertNotSelfDispatch(""), /agent is required/);
  assert.doesNotThrow(() => assertNotSelfDispatch("sales"));
});

test("unmet dependsOn stays blocked", () => {
  const gate = dispatchGate({
    task: { id: "t2", status: "pending", dependsOn: ["t1"] },
    siblingTasks: [{ id: "t1", status: "pending" }],
    runningCount: 0,
    maxParallel: 2,
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.status, "blocked");
});

test("a task whose dependencies are done may run", () => {
  const gate = dispatchGate({
    task: { id: "t2", status: "pending", dependsOn: ["t1"] },
    siblingTasks: [{ id: "t1", status: "done" }],
    runningCount: 0,
    maxParallel: 2,
  });
  assert.equal(gate.ok, true);
});

test("slot cap queues extra independent tasks as pending", () => {
  const gate = dispatchGate({
    task: { id: "t3", status: "pending", dependsOn: [] },
    siblingTasks: [],
    runningCount: 2,
    maxParallel: 2,
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.status, "pending");
  assert.match(gate.reason, /Slot cap/);
});

test("maxParallelSlots leaves one slot for Orchestrator", () => {
  assert.equal(maxParallelSlots(3), 2);
  assert.equal(maxParallelSlots(1), 1);
});
