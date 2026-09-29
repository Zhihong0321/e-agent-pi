// The judge: one small model call that returns JSON. No tools, no role prompt, no history.
// Default: glm-5.3-flash on OpenCode Go, a different model family from the workers.
import { randomUUID } from "node:crypto";

export function judgeConfigFromEnv(env = process.env) {
  return {
    baseUrl: (env.DI_CHECKER_BASE_URL || env.OPENCODE_GO_PLAN_BASE_URL || "https://opencode.ai/zen/go/v1").replace(/\/+$/, ""),
    apiKey: env.DI_CHECKER_API_KEY || env.OPENCODE_GO_TOKEN_PLAN || "",
    model: env.DI_CHECKER_MODEL || "glm-5.3-flash",
    reasoningEffort: env.DI_CHECKER_REASONING || "low",
    timeoutMs: Number(env.DI_CHECKER_TIMEOUT_MS || 90000),
  };
}

export function parseJsonReply(text) {
  const clean = String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "");
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`judge returned no JSON: ${clean.slice(0, 200)}`);
  return JSON.parse(clean.slice(start, end + 1));
}

/** @returns {(system: string, user: string) => Promise<any>} */
export function createJudge(config = judgeConfigFromEnv()) {
  if (!config.apiKey) throw new Error("Checker judge needs DI_CHECKER_API_KEY or OPENCODE_GO_TOKEN_PLAN");
  return async (system, user) => {
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` };
    if (config.baseUrl.includes("opencode.ai")) headers["x-opencode-session"] = randomUUID();
    const body = {
      model: config.model,
      temperature: 0,
      max_tokens: 1200,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    };
    if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort;
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(config.timeoutMs),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`judge HTTP ${res.status}: ${raw.slice(0, 300)}`);
    return parseJsonReply(JSON.parse(raw).choices?.[0]?.message?.content);
  };
}
