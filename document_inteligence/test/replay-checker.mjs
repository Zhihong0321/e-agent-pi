// Replay a finished stress-test report through the checker, without re-running the workers.
// Useful for tuning the checker: does it catch known defects, and does it pass good turns?
//   node test/replay-checker.mjs <report.json> [step,step,...]
// Facts come from the report's final state, so a status or number that changed later in the
// run is judged against the end state (a replay limitation, not the live behaviour).
import { readFile } from "node:fs/promises";
import { createChecker } from "../checker/index.mjs";
import { createJudge } from "../checker/judge.mjs";

const [file, only] = process.argv.slice(2);
if (!file) throw new Error("Pass a report.json path");
const report = JSON.parse(await readFile(file, "utf8"));
const wanted = only ? new Set(only.split(",").map(Number)) : null;

const known = new Map();
for (const d of report.finalState?.documents || []) if (d.number) known.set(d.number, { kind: d.doc_type, status: d.status });
for (const p of report.finalState?.payments || []) known.set(p.number, { kind: "payment", status: "recorded" });
for (const c of report.finalState?.customers || []) known.set(c.code, { kind: "customer" });
const checker = createChecker({ judge: createJudge(), lookup: async (id) => known.get(id) || null });

const history = {};
for (const step of report.steps) {
  const earlier = (history[step.agent] || []).slice(-3);
  history[step.agent] = [...(history[step.agent] || []), step.prompt];
  if (wanted && !wanted.has(step.number)) continue;
  const toolCalls = report.toolCalls.filter((c) => c.step === step.number);
  const started = Date.now();
  const verdict = await checker.checkReply({ agent: step.agent, input: step.prompt, earlier, toolCalls, reply: step.finalText });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(`${String(step.number).padStart(2)} ${step.agent.padEnd(12)} ${verdict.pass ? "pass" : "FAIL"} (${verdict.by}, ${secs}s)${verdict.judgeError ? ` judge error: ${verdict.judgeError}` : ""}\n`);
  for (const p of verdict.problems) process.stdout.write(`     - ${p}\n`);
}
