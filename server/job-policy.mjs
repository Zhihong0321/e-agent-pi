// Pure validation shared by submission, execution and retention tests.
export function validateJobTasks(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) throw new Error("A plan needs at least one task");
  if (tasks.length > 100) throw new Error("A plan may contain at most 100 tasks");
  const normalized = tasks.map((task, i) => {
    if (!task || typeof task !== "object" || Array.isArray(task)) throw new Error(`Invalid task at position ${i + 1}`);
    const id = String(task.id || `t${i + 1}`).trim();
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error(`Invalid task id: ${id}`);
    if (!String(task.prompt || "").trim()) throw new Error(`Task ${id} needs a prompt`);
    if (task.dependsOn !== undefined && !Array.isArray(task.dependsOn)) throw new Error(`Invalid dependencies for ${id}`);
    if (task.acceptanceCriteria !== undefined && (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.some(x => typeof x !== "string" || !x.trim()))) throw new Error(`Invalid acceptance criteria for ${id}`);
    return { ...task, id, dependsOn: [...new Set(task.dependsOn || [])] };
  });
  const byId = new Map(normalized.map(task => [task.id, task]));
  if (byId.size !== normalized.length) throw new Error("Duplicate task ids");
  const visiting = new Set(), visited = new Set();
  const visit = id => {
    if (!byId.has(id)) throw new Error(`Unknown dependency: ${id}`);
    if (visiting.has(id)) throw new Error(`Dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id).dependsOn) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of normalized) visit(task.id);
  return normalized;
}

// Every submitted task is a worker. Whether the job gets checked is decided by code after the
// workers finish (see nextJobStep in execution/runner.mjs), never by the plan.
export function compileJobTasks(tasks) {
  return validateJobTasks(tasks).map(({ checker, ...task }) => ({ ...task, kind: "worker" }));
}

// ---------------------------------------------------------------- the job check
//
// Workers never grade their own work. Every planned job ends with a checker run that compares
// the records with the job's standard (below), and only its verdict says whether the job is done.

/** Fix rounds after the first check; then the last verdict stands. */
export const MAX_FIX_ROUNDS = 3;

const clip = (text, limit) => {
  const value = String(text || "").trim();
  return value.length > limit ? `${value.slice(0, limit)}\n...(truncated)` : value;
};

function errorText(error) {
  if (!error) return "";
  if (typeof error === "object") return String(error.message || "");
  try { return String(JSON.parse(error)?.message || error); } catch { return String(error); }
}

/** What a step said it did, or why it could not run. */
function stepAnswer(task) {
  if (task.status === "cancelled") return "Cancelled.";
  const result = String(task.result || "").trim();
  if (task.status === "failed") return `Could not finish this step: ${errorText(task.error) || result || "no reason given"}`;
  return result || "No answer.";
}

function stepEvidence(tasks) {
  return tasks.filter(t => t.kind !== "checker")
    .map(t => `- ${t.title}: ${clip(stepAnswer(t), 1500)}`).join("\n");
}

// The job's standard has three parts: the user's message (what was asked), the owner's rules
// (the agent's SOP, already in its instructions, and the requester's category limits on the
// "Requested by" line), and who asked (a Superadmin's word overrides an owner rule; anyone
// else's does not). The checker and a fix run both work to this standard.
const OWNER_RULES = [
  "The owner's rules also apply: the \"Mandatory agent SOP\" section of your instructions, and the category limits on the \"Requested by\" line. They are the owner's standing instructions, not requirements of your own.",
  "A Superadmin's message overrides an owner rule. Anyone else's message does not: it approves only what the owner's rules allow that person to do.",
].join("\n");

// The checker rescues jobs: it confirms done work, sends unfinished work back to be finished,
// and stops at work that breaks an owner rule. Its report is the job's final answer in the
// chat; the agents' own answers are progress.
export function checkerPrompt(request, tasks) {
  return [
    "A job just finished. Your write tools are off. Use your read tools to look at the actual records.",
    `The user's message (what was asked):\n"""\n${clip(request, 4000)}\n"""`,
    OWNER_RULES,
    `What the agents said they did (claims, not proof):\n${stepEvidence(tasks)}`,
    [
      "Your job is to help this request get done, not to criticize it.",
      "Judge what the user's message asked for, against the owner's rules. Ignore wording, format, extra detail, and anything the user did not ask for. Add no requirements beyond the message and the owner's rules.",
      "If the records show what the user asked for within the owner's rules, or nothing shows it is missing, the verdict is done.",
      "Say fix only when something the user clearly asked for is missing or wrong in the records and an agent can still do it within the owner's rules.",
      "Say wall when it cannot be finished without something only the user can give (a file, a fact, a login), or when what was asked or saved breaks an owner rule the requester cannot override.",
      "Then write the report. It is the only answer the user sees for this job. Write it to the user, in plain words, from the records you read: for a question, the answer; for a change, what is now saved, with record numbers, amounts and links copied exactly; for fix, exactly what is still missing; for wall, what is needed from the user. For a broken owner rule, name the rule, the record that breaks it, and what is needed: a Superadmin's approval, or a request within the rule. Do not mention checking, agents or steps.",
      'Reply with only JSON: {"verdict":"done|fix|wall","report":"the report for the user"}',
    ].join("\n"),
  ].join("\n\n");
}

export function fixPrompt(request, missing, tasks) {
  return [
    `The user's message:\n"""\n${clip(request, 4000)}\n"""`,
    OWNER_RULES,
    `A checker compared the records with this message and found this is not done yet:\n${clip(missing, 2000)}`,
    `What was done before (claims, not proof):\n${stepEvidence(tasks)}`,
    "Finish what the user asked for, within the owner's rules. Look at what already exists first and do not create anything twice. Where a tool asks for the user's approval, their message gives it only for what the owner's rules allow them.",
    "When you finish, say in plain words what you did.",
  ].join("\n\n");
}

/** The checker's reply: {verdict, report}, or null when it is not a verdict. */
export function parseCheckVerdict(text) {
  const json = String(text || "").match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  let parsed = null;
  // A model often puts raw line breaks inside the report string; read those as \n.
  for (const candidate of [json, json.replace(/\r?\n/g, "\\n")]) {
    try { parsed = JSON.parse(candidate); break; } catch { /* try the next reading */ }
  }
  if (!["done", "fix", "wall"].includes(parsed?.verdict)) return null;
  return { verdict: parsed.verdict, report: String(parsed.report || parsed.findings || "").trim() };
}

/** What the last check said, from a task row or a mapped task. Older checks wrote findings. */
export function checkOf(task) {
  const check = task?.result_data?.check ?? task?.resultData?.check ?? null;
  if (!check?.verdict) return null;
  return { verdict: check.verdict, report: String(check.report || check.findings || "").trim() };
}

/**
 * The job's answer in chat. The checker's report is the final report. Without one (the checker
 * could not run, or gave no verdict) the latest answers stand: the last fix run if there was
 * one, else every working step. No status label either way.
 */
export function jobAnswer(tasks) {
  const checks = tasks.filter(t => t.kind === "checker" && t.status !== "cancelled");
  const check = checkOf(checks.at(-1));
  if (check?.report) {
    return check.verdict === "fix" ? `Not finished yet after ${checks.length} tries.\n\n${check.report}` : check.report;
  }
  const steps = tasks.filter(t => t.kind !== "checker");
  const fixes = steps.filter(t => t.kind === "fix");
  const shown = fixes.length ? [fixes.at(-1)] : steps;
  return shown.map(t => shown.length > 1 ? `**${t.title}**\n${clip(stepAnswer(t), 3000)}` : clip(stepAnswer(t), 3000)).join("\n\n");
}

export function parseJobReply(reply, kind = "worker") {
  const text = String(reply || "").trim();
  if (!text) throw new Error("Specialist returned an empty result");
  const raw = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let result;
  try { result = JSON.parse(raw); } catch { throw new Error("Specialist must return the requested JSON outcome; inspect its child chat before retrying"); }
  if (!result || typeof result.summary !== "string" || !result.summary.trim()) throw new Error("Outcome needs a non-empty summary");
  if (kind === "checker") {
    if (typeof result.pass !== "boolean") throw new Error("Checker must return an explicit pass verdict");
    return { status: result.pass ? "done" : "error", result: result.summary, resultData: result, error: result.pass ? null : `Checker rejected: ${result.summary}` };
  }
  if (!["done", "blocked", "failed"].includes(result.status)) throw new Error("Outcome status must be done, blocked or failed");
  return { status: result.status === "failed" ? "error" : result.status, result: result.summary, resultData: result, error: result.status === "done" ? null : result.summary };
}

export function cleanupCutoff(before) {
  if (typeof before !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(before)) throw new Error("Choose a date in YYYY-MM-DD format");
  const date = new Date(`${before}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== before) throw new Error("Invalid cleanup date");
  // The selected date is exclusive, at midnight in Asia/Kuala_Lumpur.
  return new Date(date.getTime() - 8 * 60 * 60 * 1000).toISOString();
}
