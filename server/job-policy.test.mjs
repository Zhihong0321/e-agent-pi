import assert from "node:assert/strict";
import test from "node:test";
import { cleanupCutoff, compileJobTasks, parseJobReply, validateJobTasks } from "./job-policy.mjs";

const task = (id, dependsOn = []) => ({ id, agent: "worker", prompt: "Do the work", dependsOn });

test("submission rejects duplicates, missing dependencies, cycles and empty prompts", () => {
  assert.throws(() => validateJobTasks([task("a"), task("a")]), /Duplicate/);
  assert.throws(() => validateJobTasks([task("a", ["missing"])]), /Unknown dependency/);
  assert.throws(() => validateJobTasks([task("a", ["b"]), task("b", ["a"])]), /cycle/);
  assert.throws(() => validateJobTasks([{ ...task("a"), prompt: " " }]), /prompt/);
  assert.throws(() => validateJobTasks([{ ...task("a"), dependsOn: "b" }]), /dependencies/);
});

test("checker becomes a dependency barrier and retains the original worker evidence", () => {
  const compiled = compileJobTasks([
    { ...task("a"), checker: { agent: "reviewer", checks: ["Read the actual stored value"] } },
    task("b", ["a"]),
  ]);
  assert.equal(compiled[1].kind, "checker");
  assert.deepEqual(compiled[1].dependsOn, ["a"]);
  assert.deepEqual(compiled[2].dependsOn, ["a", compiled[1].id]);
  assert.throws(() => compileJobTasks([{ ...task("a"), checker: { agent: "reviewer", checks: [] } }]), /explicit checks/);
});

test("malformed, blocked and rejected outcomes never count as successful work", () => {
  assert.throws(() => parseJobReply(""), /empty/);
  assert.throws(() => parseJobReply("Looks done"), /JSON outcome/);
  assert.equal(parseJobReply('{"status":"blocked","summary":"Need account id"}').status, "blocked");
  assert.equal(parseJobReply('{"status":"failed","summary":"Write rejected"}').status, "error");
  assert.equal(parseJobReply('{"pass":false,"summary":"Stored value is wrong"}', "checker").status, "error");
  assert.throws(() => parseJobReply('{"pass":"true","summary":"fine"}', "checker"), /explicit pass/);
});

test("outcomes retain structured receipt evidence outside the summary", () => {
  const evidence = { status: "done", summary: "Read seven slides", slides: [{ slide: 7, amount: "5.09", currency: "MYR", image_link: "/files/receipt.png" }] };
  const outcome = parseJobReply(JSON.stringify(evidence));
  assert.equal(outcome.result, evidence.summary);
  assert.deepEqual(outcome.resultData, evidence);
});

test("retention uses exclusive midnight in Kuala Lumpur and rejects invalid dates", () => {
  assert.equal(cleanupCutoff("2026-09-30"), "2026-09-29T16:00:00.000Z");
  assert.throws(() => cleanupCutoff("2026-02-30"), /Invalid/);
  assert.throws(() => cleanupCutoff("30/09/2026"), /YYYY-MM-DD/);
});
