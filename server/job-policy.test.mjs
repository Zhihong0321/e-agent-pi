import assert from "node:assert/strict";
import test from "node:test";
import { checkerPrompt, cleanupCutoff, compileJobTasks, jobAnswer, parseCheckVerdict, parseJobReply, validateJobTasks } from "./job-policy.mjs";

const task = (id, dependsOn = []) => ({ id, agent: "worker", prompt: "Do the work", dependsOn });

test("submission rejects duplicates, missing dependencies, cycles and empty prompts", () => {
  assert.throws(() => validateJobTasks([task("a"), task("a")]), /Duplicate/);
  assert.throws(() => validateJobTasks([task("a", ["missing"])]), /Unknown dependency/);
  assert.throws(() => validateJobTasks([task("a", ["b"]), task("b", ["a"])]), /cycle/);
  assert.throws(() => validateJobTasks([{ ...task("a"), prompt: " " }]), /prompt/);
  assert.throws(() => validateJobTasks([{ ...task("a"), dependsOn: "b" }]), /dependencies/);
});

test("a plan cannot order its own checker: every submitted task is a worker", () => {
  const compiled = compileJobTasks([
    { ...task("a"), checker: { agent: "reviewer", checks: ["Read the actual stored value"] } },
    task("b", ["a"]),
  ]);
  assert.deepEqual(compiled.map(t => [t.id, t.kind, t.dependsOn]), [["a", "worker", []], ["b", "worker", ["a"]]]);
  assert.equal(compiled[0].checker, undefined);
});

test("the checker's verdict is read from its reply, and anything else is no verdict", () => {
  assert.deepEqual(parseCheckVerdict('{"verdict":"done","findings":"Saved."}'), { verdict: "done", findings: "Saved." });
  assert.deepEqual(parseCheckVerdict('Here you go:\n```json\n{"verdict":"fix","findings":"Phone missing."}\n```'), { verdict: "fix", findings: "Phone missing." });
  assert.equal(parseCheckVerdict('{"verdict":"blocked","findings":"x"}'), null, "blocked is not a verdict");
  assert.equal(parseCheckVerdict("Looks fine to me"), null);
});

test("the checker judges by the user's message only, and is told to help, not to criticize", () => {
  const prompt = checkerPrompt("Save our address from the website", [{ kind: "worker", title: "Onboarding", status: "done", result: "Saved 3 of 4 fields." }]);
  assert.match(prompt, /"""\nSave our address from the website\n"""/);
  assert.match(prompt, /- Onboarding: Saved 3 of 4 fields\./);
  assert.match(prompt, /help this request get done, not to criticize it/);
  assert.match(prompt, /Do not add requirements of your own/);
  assert.match(prompt, /nothing shows it is missing, the verdict is done/);
});

test("the chat answer is the agents' own words plus the checker's verdict, never a status label", () => {
  const worker = { kind: "worker", title: "Save address", status: "done", result: "Saved the address." };
  assert.equal(jobAnswer([worker]), "Saved the address.");
  const check = (verdict, findings) => ({ kind: "checker", status: "done", result_data: { check: { verdict, findings } } });
  assert.equal(jobAnswer([worker, check("done", "The address is on file.")]), "Saved the address.\n\nChecked: done. The address is on file.");
  assert.match(jobAnswer([worker, check("wall", "Need the SST number.")]), /To finish this I need from you: Need the SST number\.$/);
  assert.equal(jobAnswer([worker, { kind: "checker", status: "failed", error: '{"message":"model down"}' }]), "Saved the address.",
    "a checker that could not run adds nothing");
  const failed = { kind: "worker", title: "Fetch", status: "failed", result: "x", error: '{"code":"REQUEST_DEADLINE","message":"The run exceeded its deadline"}' };
  assert.equal(jobAnswer([failed]), "Could not finish this step: The run exceeded its deadline");
  for (const text of [jobAnswer([worker]), jobAnswer([failed]), jobAnswer([worker, check("fix", "x")])]) {
    assert.doesNotMatch(text, /blocked|\(done\)|\(failed\)|Job .*:/i);
  }
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
