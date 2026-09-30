// Pure validation shared by submission, execution and retention tests.
export function validateJobTasks(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) throw new Error("A plan needs at least one task");
  if (tasks.length > 100) throw new Error("A plan may contain at most 100 tasks");
  const normalized = tasks.map((task, i) => {
    if (!task || typeof task !== "object" || Array.isArray(task)) throw new Error(`Invalid task at position ${i + 1}`);
    const id = String(task.id || `t${i + 1}`).trim();
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error(`Invalid task id: ${id}`);
    if (!String(task.prompt || "").trim()) throw new Error(`Task ${id} needs a prompt`);
    const checker = task.checker;
    if (checker && (!checker.agent || !Array.isArray(checker.checks) || !checker.checks.length || checker.checks.some(x => typeof x !== "string" || !x.trim()))) {
      throw new Error(`Task ${id} needs a checker agent and explicit checks`);
    }
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

export function compileJobTasks(tasks) {
  const normalized = validateJobTasks(tasks);
  const reviews = new Map(normalized.filter(t => t.checker).map((t, i) => [t.id, `__review_${i + 1}`]));
  if (normalized.some(t => [...reviews.values()].includes(t.id))) throw new Error("Task id conflicts with a generated checker task");
  return normalized.flatMap(task => {
    const worker = { ...task, kind: "worker", dependsOn: task.dependsOn.flatMap(id => reviews.has(id) ? [id, reviews.get(id)] : [id]) };
    if (!task.checker) return [worker];
    return [worker, {
      id: reviews.get(task.id), agent: task.checker.agent, title: `Check: ${task.title || task.id}`,
      kind: "checker", dependsOn: [task.id], acceptanceCriteria: [],
      prompt: `Verify the completed dependency against these checks. Use tools to inspect actual state or artifacts where needed.\nOriginal task:\n${task.prompt}\nAcceptance criteria:\n${(task.acceptanceCriteria || []).join("\n")}\nChecks:\n${task.checker.checks.map(x => `- ${x}`).join("\n")}\nReturn ONLY JSON: {"pass":true,"summary":"evidence and findings"}. Use pass:false if any check fails or cannot be verified.`,
    }];
  });
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
    return { status: result.pass ? "done" : "error", result: result.summary, error: result.pass ? null : `Checker rejected: ${result.summary}` };
  }
  if (!["done", "blocked", "failed"].includes(result.status)) throw new Error("Outcome status must be done, blocked or failed");
  return { status: result.status === "failed" ? "error" : result.status, result: result.summary, error: result.status === "done" ? null : result.summary };
}

export function cleanupCutoff(before) {
  if (typeof before !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(before)) throw new Error("Choose a date in YYYY-MM-DD format");
  const date = new Date(`${before}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== before) throw new Error("Invalid cleanup date");
  // The selected date is exclusive, at midnight in Asia/Kuala_Lumpur.
  return new Date(date.getTime() - 8 * 60 * 60 * 1000).toISOString();
}
