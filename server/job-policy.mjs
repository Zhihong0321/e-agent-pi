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
// the records with the user's own message, and only its verdict says whether the job is done.

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

// The checker rescues jobs: it confirms done work and sends unfinished work back to be
// finished. It never blocks a job and never judges by anything but the user's message.
export function checkerPrompt(request, tasks) {
  return [
    "A job just finished. Your write tools are off. Use your read tools to look at the actual records.",
    `The user's message. This is the only standard:\n"""\n${clip(request, 4000)}\n"""`,
    `What the agents said they did (claims, not proof):\n${stepEvidence(tasks)}`,
    [
      "Your job is to help this request get done, not to criticize it.",
      "Look only at what the user's message asked for. Ignore wording, format, extra detail, and anything the user did not ask for. Do not add requirements of your own.",
      "If the records show what the user asked for, or nothing shows it is missing, the verdict is done.",
      "Say fix only when something the user clearly asked for is missing or wrong in the records and an agent can still do it. Then say exactly what to finish.",
      "Say wall only when it cannot be finished without something only the user can give (a file, a fact, a login). Then say what is needed.",
      "The user sent this message, so it is their approval for what it asks.",
      'Reply with only JSON: {"verdict":"done|fix|wall","findings":"one or two plain sentences"}',
    ].join("\n"),
  ].join("\n\n");
}

export function fixPrompt(request, findings, tasks) {
  return [
    `The user's message:\n"""\n${clip(request, 4000)}\n"""`,
    `A checker compared the records with this message and found this is not done yet:\n${clip(findings, 2000)}`,
    `What was done before (claims, not proof):\n${stepEvidence(tasks)}`,
    "Finish what the user asked for. Look at what already exists first and do not create anything twice. The user sent this message, so where a tool asks for the user's approval, they have given it.",
    "When you finish, say in plain words what you did.",
  ].join("\n\n");
}

/** The checker's reply: {verdict, findings}, or null when it is not a verdict. */
export function parseCheckVerdict(text) {
  const json = String(text || "").match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!["done", "fix", "wall"].includes(parsed?.verdict)) return null;
    return { verdict: parsed.verdict, findings: String(parsed.findings || "").trim() };
  } catch { return null; }
}

// The checker's verdict in the user's words. No verdict (it could not run) adds nothing:
// the job's own answer stands.
function checkLine(check, checks) {
  const verdict = check?.result_data?.check ?? check?.resultData?.check ?? null;
  const findings = verdict?.findings ? ` ${verdict.findings}` : "";
  if (verdict?.verdict === "done") return `Checked: done.${findings}`;
  if (verdict?.verdict === "wall") return `To finish this I need from you:${findings || " more information."}`;
  if (verdict?.verdict === "fix") return `Not finished yet after ${checks} tries:${findings || " part of the request is still missing."}`;
  return "";
}

/** The job's answer in chat: each step's own words, then the checker's verdict. */
export function jobAnswer(tasks) {
  const steps = tasks.filter(t => t.kind !== "checker");
  const checks = tasks.filter(t => t.kind === "checker" && t.status !== "cancelled");
  const parts = steps.map(t => steps.length > 1 ? `**${t.title}**\n${clip(stepAnswer(t), 3000)}` : clip(stepAnswer(t), 3000));
  if (checks.length) parts.push(checkLine(checks.at(-1), checks.length));
  return parts.filter(Boolean).join("\n\n");
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
