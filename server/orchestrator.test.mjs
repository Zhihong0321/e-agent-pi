import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertNotSelfDispatch,
  capabilityCard,
  clipResult,
  dispatchGate,
  maxParallelSlots,
  RESULT_CHARS,
  specialistPrompt,
} from "./orchestrator.mjs";

test("clipResult truncates at the cap", () => {
  assert.equal(clipResult("short"), "short");
  const long = "x".repeat(RESULT_CHARS + 50);
  const clipped = clipResult(long);
  assert.ok(clipped.startsWith("x".repeat(20)));
  assert.ok(clipped.endsWith("…(truncated)"));
  assert.ok(clipped.length < long.length);
});

test("a dependent profile save receives the observed logo and source page", () => {
  const message = specialistPrompt({ prompt: "Save the discovered logo", dependsOn: ["t1"] }, [
    { id: "t1", status: "done", result: "Logo: https://ee-pr.up.railway.app/Logo/eternalgy.png\nSource: https://ee-pr.up.railway.app/" },
    { id: "unrelated", status: "done", result: "Unrelated secret" },
    { id: "pending", status: "pending", result: "Unverified" },
  ]);
  assert.match(message, /Logo\/eternalgy.png/);
  assert.match(message, /Source: https:\/\/ee-pr.up.railway.app\//);
  assert.doesNotMatch(message, /Unrelated secret|Unverified/);
});

test("dependent tasks receive complete structured evidence and published files", () => {
  const evidence = { status: "done", summary: "Extracted receipts", notes: "x".repeat(RESULT_CHARS + 1), slides: [{ slide: 7, image_link: "/files/slide-07.png", amount: "5.09" }] };
  const files = [{ url: "/files/slide-07.png" }];
  const message = specialistPrompt({ prompt: "Verify receipts", dependsOn: ["t1"] }, [
    { id: "t1", status: "done", result: evidence.summary, resultData: evidence, shared_files: files },
    { id: "pending", status: "pending", resultData: { secret: "Unverified" } },
  ]);
  assert.ok(message.includes(JSON.stringify(evidence)));
  assert.ok(message.includes(`Published files: ${JSON.stringify(files)}`));
  assert.doesNotMatch(message, /truncated|Unverified/);
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

test("a roster with verbose skill metadata stays below the MCP result limit", () => {
  const specialists = Array.from({ length: 32 }, (_, i) => capabilityCard({
    id: `agent-${i}`, slug: `agent-${i}`, name: `Specialist ${i}`,
    headline: "h".repeat(500), description: "d".repeat(5000),
    skills: [{ name: "website-inspection", description: "s".repeat(5000) }],
    mcp: [{ name: "Website Tools", description: "m".repeat(5000) }],
  }));
  const result = { content: [{ type: "text", text: JSON.stringify({ specialists }) }] };
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 16 * 1024);
  assert.equal(specialists[0].headline.length, 120);
  assert.equal(specialists[0].description.length, 120);
  assert.equal(specialists[0].skills[0].description, undefined);
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
