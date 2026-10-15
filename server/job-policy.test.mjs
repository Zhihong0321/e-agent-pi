import assert from "node:assert/strict";
import test from "node:test";
import { checkerPrompt, cleanupCutoff, compileJobTasks, fixPrompt, jobAnswer, parseCheckVerdict, parseJobReply, validateJobTasks } from "./job-policy.mjs";

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
  assert.deepEqual(parseCheckVerdict('{"verdict":"done","report":"Saved."}'), { verdict: "done", report: "Saved." });
  assert.deepEqual(parseCheckVerdict('Here you go:\n```json\n{"verdict":"fix","report":"Phone missing."}\n```'), { verdict: "fix", report: "Phone missing." });
  assert.deepEqual(parseCheckVerdict('{"verdict":"done","report":"Line one\nLine two"}'), { verdict: "done", report: "Line one\nLine two" },
    "raw line breaks inside the report still parse");
  assert.equal(parseCheckVerdict('{"verdict":"blocked","findings":"x"}'), null, "blocked is not a verdict");
  assert.equal(parseCheckVerdict("Looks fine to me"), null);
});

test("the checker judges by the user's message and the owner's rules, and is told to help, not to criticize", () => {
  const prompt = checkerPrompt("Save our address from the website", [{ kind: "worker", title: "Onboarding", status: "done", result: "Saved 3 of 4 fields." }]);
  assert.match(prompt, /"""\nSave our address from the website\n"""/);
  assert.match(prompt, /- Onboarding: Saved 3 of 4 fields\./);
  assert.match(prompt, /help this request get done, not to criticize it/);
  assert.match(prompt, /Add no requirements beyond the message and the owner's rules/);
  assert.match(prompt, /nothing shows it is missing, the verdict is done/);
  // The owner's rules are part of the standard: the agent's SOP and the requester's category limits.
  assert.match(prompt, /"Mandatory agent SOP" section of your instructions/);
  assert.match(prompt, /category limits on the "Requested by" line/);
  // Only a Superadmin's word overrides them; anyone else's message is not approval past them.
  assert.match(prompt, /A Superadmin's message overrides an owner rule\. Anyone else's message does not/);
  assert.match(prompt, /Say wall when .*breaks an owner rule the requester cannot override/);
  assert.match(prompt, /name the rule, the record that breaks it, and what is needed/);
  assert.doesNotMatch(prompt, /only standard|it is their approval for what it asks/);
});

test("a fix run works within the owner's rules; the user's message is not approval past them", () => {
  const prompt = fixPrompt("Give Acme 15% off", "The 15% discount is not applied yet.", [{ kind: "worker", title: "Quote", status: "done", result: "Drafted QT-2026-001." }]);
  assert.match(prompt, /"Mandatory agent SOP" section of your instructions/);
  assert.match(prompt, /Finish what the user asked for, within the owner's rules/);
  assert.match(prompt, /gives it only for what the owner's rules allow them/);
  assert.doesNotMatch(prompt, /they have given it/);
});

test("the chat answer is the agents' own words plus the checker's verdict, never a status label", () => {
  const worker = { kind: "worker", title: "Save address", status: "done", result: "Saved the address." };
  assert.equal(jobAnswer([worker]), "Saved the address.");
  const check = (verdict, report) => ({ kind: "checker", status: "done", result_data: { check: { verdict, report } } });
  assert.equal(jobAnswer([worker, check("done", "The address is on file.")]), "The address is on file.", "the checker's report is the final report");
  assert.equal(jobAnswer([worker, check("wall", "Send the SST number.")]), "Send the SST number.");
  const fix = { kind: "fix", title: "Fix", status: "done", result: "Saved it properly." };
  assert.equal(jobAnswer([worker, check("fix", "x"), fix, { kind: "checker", status: "failed" }]), "Saved it properly.",
    "no verdict: the latest fix answer stands, not the superseded first answer");
  assert.equal(jobAnswer([worker, { kind: "checker", status: "done", result_data: { check: { verdict: "done", findings: "Older check." } } }]), "Older check.",
    "checks written before the report field still show");
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
