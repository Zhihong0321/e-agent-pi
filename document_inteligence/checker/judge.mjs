// The judge: one small model call that returns JSON. No tools, no role prompt, no history.
// Default: MiniMax M3.1 Flash Preview through M Plan.
import { randomUUID } from "node:crypto";
import { recordApiUsage } from "../../server/usage.mjs";
import { gatedFetch, providerForUrl } from "../../server/queue/llm-gate.mjs";

export function judgeConfigFromEnv(env = process.env) {
  return {
    baseUrl: (env.DI_CHECKER_BASE_URL || env.MINIMAX_BASE_URL || "https://api.minimax.io/v1").replace(/\/+$/, ""),
    apiKey: env.DI_CHECKER_API_KEY || env.MINIMAX_API_KEY || "",
    model: env.DI_CHECKER_MODEL || "MiniMax-M3.1-Flash-Preview",
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
  if (!config.apiKey) throw new Error("Checker judge needs DI_CHECKER_API_KEY or MINIMAX_API_KEY");
  return async (system, user) => {
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` };
    if (config.baseUrl.includes("opencode.ai")) headers["x-opencode-session"] = randomUUID();
    const body = {
      model: config.model,
      temperature: 0,
      max_completion_tokens: 8192,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    };
    if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort;
    const started = Date.now();
    let raw = "";
    try {
      // Same gate as every other call to this provider; the timeout starts when the request is sent, not while it waits in line.
      const url = `${config.baseUrl}/chat/completions`;
      const res = await gatedFetch(providerForUrl(url), url, {
        method: "POST", headers, body: JSON.stringify(body), runTimeoutMs: config.timeoutMs, callerKey: "di-checker",
      });
      raw = await res.text();
      let payload = null;
      try { payload = JSON.parse(raw); } catch { /* handled by the provider error below */ }
      if (!res.ok) {
        void recordApiUsage({ service: "llm", provider: "checker", operation: "judge", modelId: config.model, status: "error", durationMs: Date.now() - started, error: `HTTP ${res.status}`, metadata: { baseUrl: config.baseUrl } });
        throw new Error(`judge HTTP ${res.status}: ${raw.slice(0, 300)}`);
      }
      void recordApiUsage({ service: "llm", provider: "checker", operation: "judge", modelId: config.model, status: "ok", durationMs: Date.now() - started, usage: payload?.usage, metadata: { baseUrl: config.baseUrl } });
      return parseJsonReply(payload?.choices?.[0]?.message?.content);
    } catch (error) {
      if (!raw) void recordApiUsage({ service: "llm", provider: "checker", operation: "judge", modelId: config.model, status: "error", durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error), metadata: { baseUrl: config.baseUrl } });
      throw error;
    }
  };
}
