import { getPool } from "./db.mjs";

const MAX_META = 2000;

function finite(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function clip(value, max = MAX_META) {
  if (value == null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function redactUsageMeta(value, depth = 0) {
  if (value == null || depth > 3) return null;
  if (typeof value !== "object") return clip(value, 300);
  if (Array.isArray(value)) return value.slice(0, 20).map(item => redactUsageMeta(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    if (/(?:api[_-]?key|token|password|secret|authorization|cookie)/i.test(key)) out[key] = "[REDACTED]";
    else if (item && typeof item === "object") out[key] = redactUsageMeta(item, depth + 1);
    else out[key] = clip(item, 300);
  }
  return out;
}

export function normalizeUsage(usage = {}) {
  const u = usage && typeof usage === "object" ? usage : {};
  const input = finite(u.input ?? u.input_tokens ?? u.prompt_tokens ?? u.promptTokens);
  const output = finite(u.output ?? u.output_tokens ?? u.completion_tokens ?? u.completionTokens);
  const cacheRead = finite(u.cacheRead ?? u.cache_read_input_tokens ?? u.cache_read ?? u.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens);
  const cacheWrite = finite(u.cacheWrite ?? u.cache_creation_input_tokens ?? u.cache_write);
  const explicitTotal = finite(u.total ?? u.total_tokens ?? u.totalTokens);
  const hasInclusiveInput = u.prompt_tokens != null || u.input_tokens_details != null;
  const total = explicitTotal ?? ([input, output, cacheRead, cacheWrite].some(v => v != null)
    ? [input, output, hasInclusiveInput ? 0 : cacheRead, cacheWrite].reduce((sum, value) => sum + (value || 0), 0)
    : null);
  const credits = finite(u.credits ?? u.credit ?? u.search_credits ?? u.units);
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, totalTokens: total, credits };
}

export async function ensureUsageSchema(pool = getPool()) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_usage (
      id BIGSERIAL PRIMARY KEY,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      service TEXT NOT NULL,
      provider TEXT,
      operation TEXT NOT NULL,
      engine TEXT,
      model_id TEXT,
      user_id TEXT,
      session_id TEXT,
      agent_id TEXT,
      request_id TEXT,
      status TEXT NOT NULL DEFAULT 'ok',
      duration_ms INTEGER,
      input_tokens BIGINT,
      output_tokens BIGINT,
      cache_read_tokens BIGINT,
      cache_write_tokens BIGINT,
      total_tokens BIGINT,
      credits NUMERIC,
      estimated_cost NUMERIC,
      error TEXT,
      metadata JSONB
    );
    CREATE INDEX IF NOT EXISTS api_usage_occurred_idx ON api_usage (occurred_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS api_usage_provider_idx ON api_usage (service, provider, model_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS api_usage_user_idx ON api_usage (user_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS api_usage_session_idx ON api_usage (session_id, occurred_at DESC);
  `);
}

export async function recordApiUsage(input = {}) {
  if (!input.service || !input.operation) return null;
  const usage = normalizeUsage(input.usage || input);
  try {
    const result = await getPool().query(
      `INSERT INTO api_usage
       (service, provider, operation, engine, model_id, user_id, session_id, agent_id, request_id, status,
        duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
        credits, estimated_cost, error, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING id, occurred_at AS "occurredAt"`,
      [input.service, clip(input.provider, 120), input.operation, clip(input.engine, 120), clip(input.modelId, 200), input.userId || null,
        input.sessionId || null, input.agentId || null, clip(input.requestId, 200), input.status || "ok",
        finite(input.durationMs), usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens,
        usage.totalTokens, usage.credits ?? finite(input.credits), costValue(input.estimatedCost ?? input.usage?.cost?.total), clip(input.error, 500), redactUsageMeta(input.metadata)],
    );
    return result.rows[0] || null;
  } catch {
    return null;
  }
}

function costValue(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function filters(options = {}) {
  const values = [];
  const clauses = [];
  const add = value => { values.push(value); return `$${values.length}`; };
  if (options.since) clauses.push(`occurred_at >= ${add(options.since)}`);
  if (options.until) clauses.push(`occurred_at <= ${add(options.until)}`);
  if (options.service) clauses.push(`service = ${add(options.service)}`);
  if (options.provider) clauses.push(`provider = ${add(options.provider)}`);
  if (options.modelId) clauses.push(`model_id = ${add(options.modelId)}`);
  if (options.userId) clauses.push(`user_id = ${add(options.userId)}`);
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", values };
}

export async function usageReport(options = {}) {
  const bounded = { ...options };
  if (!bounded.since && !bounded.until) bounded.since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { where, values } = filters(bounded);
  const pool = getPool();
  const [summary, trend, breakdown, recent] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS calls, COALESCE(SUM(input_tokens),0)::bigint AS "inputTokens", COALESCE(SUM(output_tokens),0)::bigint AS "outputTokens", COALESCE(SUM(cache_read_tokens),0)::bigint AS "cacheReadTokens", COALESCE(SUM(cache_write_tokens),0)::bigint AS "cacheWriteTokens", COALESCE(SUM(total_tokens),0)::bigint AS "totalTokens", COALESCE(SUM(credits),0)::numeric AS credits, COALESCE(SUM(estimated_cost),0)::numeric AS cost, COUNT(*) FILTER (WHERE status <> 'ok')::int AS failures FROM api_usage ${where}`, values),
    pool.query(`SELECT date_trunc('day', occurred_at) AS day, COUNT(*)::int AS calls, COALESCE(SUM(total_tokens),0)::bigint AS "totalTokens", COALESCE(SUM(credits),0)::numeric AS credits FROM api_usage ${where} GROUP BY 1 ORDER BY 1`, values),
    pool.query(`SELECT service, COALESCE(provider,'') AS provider, COALESCE(model_id,'') AS "modelId", COUNT(*)::int AS calls, COALESCE(SUM(total_tokens),0)::bigint AS "totalTokens", COALESCE(SUM(credits),0)::numeric AS credits FROM api_usage ${where} GROUP BY 1,2,3 ORDER BY "totalTokens" DESC NULLS LAST, calls DESC`, values),
    pool.query(`SELECT id, occurred_at AS "occurredAt", service, provider, operation, engine, model_id AS "modelId", status, duration_ms AS "durationMs", input_tokens AS "inputTokens", output_tokens AS "outputTokens", total_tokens AS "totalTokens", credits, estimated_cost AS cost, error FROM api_usage ${where} ORDER BY occurred_at DESC, id DESC LIMIT 100`, values),
  ]);
  return { summary: summary.rows[0], trend: trend.rows, breakdown: breakdown.rows, recent: recent.rows };
}
