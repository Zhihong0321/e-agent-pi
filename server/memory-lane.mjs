// Memory lane: E learns from conversations on its own lane, never inside a chat turn.
//
//   idle chat → trigger filter (code) → digest (one model call) → checker (code) → memories table
//
// Only the company's Superadmin shapes how E reacts: everything the digest writes is a
// *candidate* until the Superadmin approves it on /demo → Insights → Memory. The lane only
// reads sessions/messages and only writes its own two tables, so if it fails, chat never
// notices. Phase 1 records and manages; no agent reads these memories yet.
import { randomUUID } from "node:crypto";
import { createJudge, judgeConfigFromEnv } from "../document_inteligence/checker/judge.mjs";
import { parseTranscript } from "./pi-stream.mjs";
import { isSuperadmin } from "./roles.mjs";

export const TYPES = ["fact", "mistake", "rule_candidate"];
export const LIMITS = { body: 300, quote: 200, perDigest: 3, pendingPerCompany: 30, activePerCompany: 50, sessionsPerSweep: 5, transcriptChars: 14000, messageChars: 1500 };
const IDLE_MS = Number(process.env.MEMORY_LANE_IDLE_MS || 30 * 60_000);
const SWEEP_MS = Number(process.env.MEMORY_LANE_SWEEP_MS || 5 * 60_000);
const MAX_ATTEMPTS = 3;

// A session is only worth a model call when a person corrected E, told it to remember a rule,
// or a job went wrong. Everything else is skipped by code (English + Malay).
const SIGNALS = [
  ["correction", /\b(no|nope|wrong|incorrect|not (?:that|right|correct)|i (?:said|meant)|should (?:be|have)|actually|instead|salah|bukan|tak betul)\b/i],
  ["instruction", /\b(remember|always|never|from now on|every time|next time|by default|make sure|don'?t ever|ingat|sentiasa|jangan|lain kali|mulai sekarang)\b/i],
];
const FAILURE = /\b(blocked|failed|could not|couldn'?t|unable to|not allowed|permission denied)\b/i;
const SECRET = /\b(password|passwd|api[ _-]?key|secret|token|otp|pin)\b|\b\d{6}-\d{2}-\d{4}\b/i;

const settingKey = (tenantId) => `memory_lane:${tenantId}`;
const globalOff = () => String(process.env.MEMORY_LANE || "").toLowerCase() === "off";
const squash = (text) => String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();

export async function ensureMemorySchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      company_tenant_id TEXT NOT NULL,
      type TEXT NOT NULL,
      key TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'candidate',
      proposed_body TEXT,
      evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
      seen INT NOT NULL DEFAULT 1,
      note TEXT NOT NULL DEFAULT '',
      decided_by TEXT,
      decided_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (company_tenant_id, key)
    );
    CREATE TABLE IF NOT EXISTS memory_digests (
      session_id TEXT PRIMARY KEY,
      company_tenant_id TEXT NOT NULL,
      last_message_id INT NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      signals TEXT[] NOT NULL DEFAULT '{}',
      kept INT NOT NULL DEFAULT 0,
      dropped JSONB NOT NULL DEFAULT '[]'::jsonb,
      attempts INT NOT NULL DEFAULT 0,
      digested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS memory_digests_company_idx ON memory_digests (company_tenant_id, digested_at DESC);
  `);
}

export async function laneEnabled(pool, tenantId) {
  if (globalOff()) return false;
  return (await pool.query("SELECT value FROM settings WHERE key=$1", [settingKey(tenantId)])).rows[0]?.value === "on";
}

/** Top-level chats with messages the lane has not read yet, idle long enough, in companies that turned the lane on. */
async function pendingSessions(pool, { tenantId = null, idleMs = IDLE_MS, limit = LIMITS.sessionsPerSweep } = {}) {
  return (await pool.query(`
    SELECT s.id, COALESCE(s.company_tenant_id, u.company_tenant_id) AS tenant,
           COALESCE(d.last_message_id, 0) AS last_id, COALESCE(d.attempts, 0) AS attempts
      FROM sessions s
      LEFT JOIN users u ON u.id = s.user_id
      LEFT JOIN memory_digests d ON d.session_id = s.id
      JOIN settings st ON st.key = 'memory_lane:' || COALESCE(s.company_tenant_id, u.company_tenant_id) AND st.value = 'on'
     WHERE s.parent_session_id IS NULL
       AND ($1::text IS NULL OR COALESCE(s.company_tenant_id, u.company_tenant_id) = $1)
       AND s.updated_at < NOW() - ($2::int * INTERVAL '1 millisecond')
       AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.id > COALESCE(d.last_message_id, 0))
     ORDER BY s.updated_at ASC
     LIMIT $3`, [tenantId, Math.max(0, idleMs), limit])).rows;
}

/** Plain text of a stored message: assistant turns are stored as JSON with text + tool blocks. */
export function messageText(row) {
  if (row.role !== "assistant") return String(row.content || "");
  const parsed = parseTranscript(row.content);
  if (!parsed) return String(row.content || "");
  const failedTools = (parsed.blocks || []).filter((b) => b.type === "tool" && b.isError).map((b) => `[tool ${b.name} failed]`);
  return [parsed.text || "", ...failedTools].filter(Boolean).join("\n");
}

/** Code-only trigger filter over the messages the lane has not read yet. */
export function findSignals(fresh) {
  const found = new Set();
  for (const m of fresh) {
    if (m.role === "user") for (const [name, re] of SIGNALS) if (re.test(m.text)) found.add(name);
    if (m.role === "assistant" && FAILURE.test(m.text)) found.add("failure");
  }
  const asked = fresh.filter((m) => m.role === "user").map((m) => squash(m.text)).filter((t) => t.length > 8);
  if (new Set(asked).size < asked.length) found.add("retry");
  return [...found];
}

const SYSTEM = `You keep the long-term memory of "E", a team AI assistant used by one company.
You read one chat between a team member and E, and the memories the company already has.
Propose at most ${LIMITS.perDigest} memories worth keeping, or none. Most chats deserve none.

Keep only what will change how E should act in FUTURE chats with ANYONE in this company:
- fact: lasting company knowledge that a person stated and that is not a business record (names of things, jargon, who handles what, how this company works).
- mistake: E misunderstood or did something wrong and the person corrected it. Write the correct understanding, not the story.
- rule_candidate: the person stated a business rule or policy ("discounts above 15% need the boss's OK", "quotes are valid 14 days").

Never keep: one-off requests, the content of a single invoice/quote/expense/person record (those live in the database), small talk, anything E said that no person confirmed, passwords, tokens, personal ID numbers, or guesses.
If an existing memory already covers it, reuse its key (to strengthen or correct it). Never propose anything listed as rejected.

Reply with JSON only:
{"proposals":[{"key":"short-kebab-slug","type":"fact|mistake|rule_candidate","body":"one plain sentence, max ${LIMITS.body} characters","evidence":[<message ids>],"quote":"exact words copied from one person message in evidence"}],"why_none":"short reason when proposals is empty"}`;

function promptFor({ transcript, memories }) {
  const known = memories.length
    ? memories.map((m) => `- ${m.key} [${m.type}${m.status === "rejected" ? ", REJECTED" : m.status === "active" ? ", approved" : ", awaiting review"}]: ${m.body}`).join("\n")
    : "(none yet)";
  const chat = transcript.map((m) => `#${m.id} ${m.role === "user" ? `PERSON (${m.who})` : "E"}${m.fresh ? "" : " (earlier)"}: ${m.text}`).join("\n\n");
  return `Existing memories:\n${known}\n\nChat (only messages not marked "earlier" may be cited as evidence):\n${chat}`;
}

/** The checker: code decides what the digest may write. Returns { kept, dropped }. */
export function checkProposals(raw, { transcript, existing, pending, active }) {
  const fresh = new Map(transcript.filter((m) => m.fresh).map((m) => [m.id, m]));
  const byKey = new Map(existing.map((m) => [m.key, m]));
  const kept = [];
  const dropped = [];
  const list = Array.isArray(raw?.proposals) ? raw.proposals : [];
  for (const p of list) {
    const key = String(p?.key ?? "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    const body = String(p?.body ?? "").replace(/\s+/g, " ").trim();
    const drop = (why) => dropped.push({ key: key || "(no key)", why });
    if (kept.length >= LIMITS.perDigest) { drop("more than 3 proposals in one chat"); continue; }
    if (key.length < 3) { drop("missing key"); continue; }
    if (!TYPES.includes(p?.type)) { drop(`unknown type "${String(p?.type).slice(0, 30)}"`); continue; }
    if (body.length < 10 || body.length > LIMITS.body) { drop(`body must be 10-${LIMITS.body} characters`); continue; }
    if (SECRET.test(body)) { drop("looks like a secret or ID number"); continue; }
    const cited = (Array.isArray(p.evidence) ? p.evidence : []).map(Number).filter((id) => fresh.has(id));
    const people = cited.map((id) => fresh.get(id)).filter((m) => m.role === "user");
    if (!people.length) { drop("no evidence from a person in the new messages"); continue; }
    const quote = String(p.quote ?? "").trim().slice(0, LIMITS.quote);
    const said = people.find((m) => quote.length >= 4 && squash(m.text).includes(squash(quote)));
    if (!said) { drop("quote is not what the person wrote"); continue; }
    const prior = byKey.get(key);
    if (prior?.status === "rejected") { drop("the Superadmin rejected this before"); continue; }
    if (prior && ["retired", "promoted"].includes(prior.status)) { drop(`already ${prior.status}`); continue; }
    if (!prior && pending + kept.filter((k) => !k.prior).length >= LIMITS.pendingPerCompany) { drop("review queue is full"); continue; }
    if (!prior && active >= LIMITS.activePerCompany && p.type !== "rule_candidate") { drop("memory is full: retire something first"); continue; }
    if (kept.some((k) => k.key === key)) { drop("duplicate key in this chat"); continue; }
    kept.push({ key, type: p.type, body, prior, evidence: { message_id: said.id, who: said.who, quote, at: said.at } });
  }
  return { kept, dropped };
}

async function writeMemory(pool, tenantId, item, sessionId) {
  const evidence = JSON.stringify([{ ...item.evidence, session_id: sessionId }]);
  if (!item.prior) {
    await pool.query(`INSERT INTO memories (id, company_tenant_id, type, key, body, evidence) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
      ON CONFLICT (company_tenant_id, key) DO NOTHING`, [randomUUID(), tenantId, item.type, item.key, item.body, evidence]);
  } else if (item.prior.status === "candidate") {
    // Still awaiting review: the latest wording wins and the evidence piles up.
    await pool.query(`UPDATE memories SET body=$3, type=$4, evidence = (evidence || $5::jsonb), seen = seen + 1, updated_at=NOW()
      WHERE company_tenant_id=$1 AND key=$2`, [tenantId, item.key, item.body, item.type, evidence]);
  } else {
    // Approved memories never change by themselves: a different wording waits as a suggested change.
    const changed = squash(item.body) !== squash(item.prior.body);
    await pool.query(`UPDATE memories SET proposed_body = CASE WHEN $3 THEN $4 ELSE proposed_body END,
      evidence = (evidence || $5::jsonb), seen = seen + 1, updated_at=NOW() WHERE company_tenant_id=$1 AND key=$2`,
    [tenantId, item.key, changed, item.body, evidence]);
  }
}

async function recordDigest(pool, row) {
  await pool.query(`INSERT INTO memory_digests (session_id, company_tenant_id, last_message_id, status, reason, signals, kept, dropped, attempts, digested_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,NOW())
    ON CONFLICT (session_id) DO UPDATE SET last_message_id=EXCLUDED.last_message_id, status=EXCLUDED.status, reason=EXCLUDED.reason,
      signals=EXCLUDED.signals, kept=EXCLUDED.kept, dropped=EXCLUDED.dropped, attempts=EXCLUDED.attempts, digested_at=NOW()`,
  [row.sessionId, row.tenantId, row.lastId, row.status, String(row.reason || "").slice(0, 500), row.signals || [], row.kept || 0, JSON.stringify(row.dropped || []), row.attempts || 0]);
}

/** Reads one session's unread messages, filters, digests, checks and records. Never throws. */
export async function digestSession(pool, session, { judge, log = () => {} } = {}) {
  const { id: sessionId, tenant: tenantId } = session;
  const lastId = Number(session.last_id) || 0;
  let newest = lastId;
  try {
    const rows = (await pool.query(`SELECT m.id, m.role, m.content, m.created_at, COALESCE(u.display_name, u.username, 'team member') AS who
        FROM messages m JOIN sessions s ON s.id = m.session_id LEFT JOIN users u ON u.id = s.user_id
       WHERE m.session_id=$1 AND m.role IN ('user','assistant')
       ORDER BY m.id DESC LIMIT 60`, [sessionId])).rows.reverse();
    newest = rows.reduce((max, r) => Math.max(max, Number(r.id)), lastId);
    let transcript = rows.map((r) => ({ id: Number(r.id), role: r.role, who: r.who, at: r.created_at, fresh: Number(r.id) > lastId,
      text: messageText(r).slice(0, LIMITS.messageChars) })).filter((m) => m.text.trim());
    // Keep the newest messages inside the budget.
    let size = 0;
    transcript = transcript.reverse().filter((m) => (size += m.text.length) <= LIMITS.transcriptChars).reverse();
    const fresh = transcript.filter((m) => m.fresh);
    const signals = findSignals(fresh);
    if (!fresh.some((m) => m.role === "user")) return void await recordDigest(pool, { sessionId, tenantId, lastId: newest, status: "skipped", reason: "no new message from a person" });
    if (!signals.length) return void await recordDigest(pool, { sessionId, tenantId, lastId: newest, status: "skipped", reason: "no signal (no correction, rule or failure)" });

    const existing = (await pool.query(`SELECT key, type, body, status FROM memories WHERE company_tenant_id=$1
      AND status IN ('candidate','active','rejected','retired','promoted') ORDER BY (status='active') DESC, updated_at DESC LIMIT 80`, [tenantId])).rows;
    const reply = await judge(SYSTEM, promptFor({ transcript, memories: existing.filter((m) => ["candidate", "active", "rejected"].includes(m.status)) }));
    const pending = existing.filter((m) => m.status === "candidate").length;
    const active = existing.filter((m) => m.status === "active").length;
    const { kept, dropped } = checkProposals(reply, { transcript, existing, pending, active });
    for (const item of kept) await writeMemory(pool, tenantId, item, sessionId);
    await recordDigest(pool, { sessionId, tenantId, lastId: newest, status: "done", signals, kept: kept.length, dropped,
      reason: kept.length ? `kept ${kept.map((k) => k.key).join(", ")}` : String(reply?.why_none || "nothing worth keeping").slice(0, 300) });
    log("info", `memory lane session=${sessionId}: kept ${kept.length}, dropped ${dropped.length}`);
  } catch (error) {
    // Retry on the next sweep; after a few failures move past these messages so one bad chat can't jam the lane.
    const attempts = (Number(session.attempts) || 0) + 1;
    const giveUp = attempts >= MAX_ATTEMPTS;
    log("error", `memory lane session=${sessionId} failed (attempt ${attempts}): ${error?.message || error}`);
    await recordDigest(pool, { sessionId, tenantId, lastId: giveUp ? newest : lastId, status: "failed", attempts: giveUp ? 0 : attempts,
      reason: `${giveUp ? "gave up: " : ""}${String(error?.message || error).slice(0, 300)}` }).catch(() => {});
  }
}

let queue = Promise.resolve();
let busy = 0;

/** One pass over pending sessions, one model call at a time. Passes run one after another, never side by side. */
export function sweep(pool, { tenantId = null, idleMs, judge, log } = {}) {
  busy += 1;
  const pass = queue.then(async () => {
    if (globalOff()) return { digested: 0 };
    const sessions = await pendingSessions(pool, { tenantId, idleMs });
    if (!sessions.length) return { digested: 0 };
    const call = judge || createJudge({ ...judgeConfigFromEnv(), ...memoryJudgeEnv(), callerKey: "memory-lane", operation: "memory-digest" });
    for (const session of sessions) await digestSession(pool, session, { judge: call, log });
    return { digested: sessions.length };
  }).finally(() => { busy -= 1; });
  queue = pass.catch(() => {});
  return pass;
}

function memoryJudgeEnv(env = process.env) {
  const out = {};
  if (env.MEMORY_LANE_BASE_URL) out.baseUrl = env.MEMORY_LANE_BASE_URL.replace(/\/+$/, "");
  if (env.MEMORY_LANE_API_KEY) out.apiKey = env.MEMORY_LANE_API_KEY;
  if (env.MEMORY_LANE_MODEL) out.model = env.MEMORY_LANE_MODEL;
  return out;
}

/** Background timer. Every failure is caught here: the lane can never take the server down. */
export function startMemoryLane({ pool, log = () => {} }) {
  const tick = () => busy || void sweep(pool, { log }).catch((error) => log("error", `memory lane sweep failed: ${error?.message || error}`));
  const timer = setInterval(tick, SWEEP_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

// ---- Superadmin page API: /api/demo/memory ----

const ACTIONS = {
  approve: { from: ["candidate", "rejected", "retired"], to: "active" },
  reject: { from: ["candidate"], to: "rejected" },
  retire: { from: ["active"], to: "retired" },
  promote: { from: ["candidate", "active"], to: "promoted", types: ["rule_candidate"] },
};

export async function memoryOverview(pool, tenantId) {
  const memories = (await pool.query(`SELECT id, type, key, body, status, proposed_body AS "proposedBody", evidence, seen, note,
      decided_by AS "decidedBy", decided_at AS "decidedAt", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM memories WHERE company_tenant_id=$1 ORDER BY updated_at DESC LIMIT 500`, [tenantId])).rows;
  const digests = (await pool.query(`SELECT d.session_id AS "sessionId", s.title, COALESCE(u.display_name, u.username) AS "userName",
      d.status, d.reason, d.signals, d.kept, d.dropped, d.digested_at AS "digestedAt"
      FROM memory_digests d LEFT JOIN sessions s ON s.id = d.session_id LEFT JOIN users u ON u.id = s.user_id
      WHERE d.company_tenant_id=$1 ORDER BY d.digested_at DESC LIMIT 40`, [tenantId])).rows;
  const waiting = (await pendingSessions(pool, { tenantId, idleMs: 0, limit: 100 })).length;
  return { enabled: await laneEnabled(pool, tenantId), globalOff: globalOff(), idleMinutes: Math.round(IDLE_MS / 60000), waiting, limits: LIMITS, memories, digests };
}

export async function decideMemory(pool, tenantId, actor, id, { action, body, type, note } = {}) {
  const row = (await pool.query("SELECT * FROM memories WHERE id=$1 AND company_tenant_id=$2", [id, tenantId])).rows[0];
  if (!row) throw Object.assign(new Error("Memory not found"), { status: 404 });
  if (action === "delete") {
    await pool.query("DELETE FROM memories WHERE id=$1 AND company_tenant_id=$2", [id, tenantId]);
    return { deleted: true };
  }
  if (action === "edit") {
    const text = String(body ?? row.body).replace(/\s+/g, " ").trim();
    if (text.length < 10 || text.length > LIMITS.body) throw Object.assign(new Error(`A memory is 10-${LIMITS.body} characters`), { status: 400 });
    const nextType = type ?? row.type;
    if (!TYPES.includes(nextType)) throw Object.assign(new Error("Unknown memory type"), { status: 400 });
    await pool.query("UPDATE memories SET body=$3, type=$4, decided_by=$5, decided_at=NOW(), updated_at=NOW() WHERE id=$1 AND company_tenant_id=$2", [id, tenantId, text, nextType, actor]);
    return { ok: true };
  }
  if (action === "accept_change" || action === "dismiss_change") {
    if (!row.proposed_body) throw Object.assign(new Error("No suggested change on this memory"), { status: 400 });
    await pool.query(`UPDATE memories SET body = CASE WHEN $3 THEN proposed_body ELSE body END, proposed_body=NULL, decided_by=$4, decided_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND company_tenant_id=$2`, [id, tenantId, action === "accept_change", actor]);
    return { ok: true };
  }
  const rule = ACTIONS[action];
  if (!rule) throw Object.assign(new Error("Unknown action"), { status: 400 });
  if (!rule.from.includes(row.status)) throw Object.assign(new Error(`Cannot ${action} a memory that is ${row.status}`), { status: 409 });
  if (rule.types && !rule.types.includes(row.type)) throw Object.assign(new Error("Only rule ideas can be marked as moved into an SOP or rule"), { status: 409 });
  if (rule.to === "active" && (await pool.query("SELECT count(*)::int AS n FROM memories WHERE company_tenant_id=$1 AND status='active'", [tenantId])).rows[0].n >= LIMITS.activePerCompany) {
    throw Object.assign(new Error(`Memory holds at most ${LIMITS.activePerCompany} approved items. Retire one first.`), { status: 409 });
  }
  await pool.query("UPDATE memories SET status=$3, note=$4, decided_by=$5, decided_at=NOW(), updated_at=NOW() WHERE id=$1 AND company_tenant_id=$2",
    [id, tenantId, rule.to, String(note ?? row.note ?? "").slice(0, 300), actor]);
  return { ok: true };
}

/** /api/demo/memory/*: the signed-in Superadmin's own company only. */
export async function handleMemory(req, res, url, { user, json, readBody, getPool, log }) {
  const { pathname } = url;
  if (!pathname.startsWith("/api/demo/memory")) return false;
  if (!isSuperadmin(user)) return json(res, 403, { error: "Only your company's Superadmin can see and shape E's memory." }), true;
  const tenantId = user.company_tenant_id;
  if (!tenantId) return json(res, 400, { error: "Company tenant is required" }), true;
  try {
    const pool = getPool();
    const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
    if (pathname === "/api/demo/memory" && req.method === "GET") return json(res, 200, await memoryOverview(pool, tenantId)), true;
    if (pathname === "/api/demo/memory/settings" && req.method === "POST") {
      await pool.query("INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [settingKey(tenantId), body.enabled ? "on" : "off"]);
      return json(res, 200, { enabled: await laneEnabled(pool, tenantId) }), true;
    }
    if (pathname === "/api/demo/memory/run" && req.method === "POST") {
      if (globalOff()) throw Object.assign(new Error("The memory lane is switched off on this server (MEMORY_LANE=off)."), { status: 409 });
      if (!(await laneEnabled(pool, tenantId))) throw Object.assign(new Error("Turn the memory lane on first."), { status: 409 });
      return json(res, 200, await sweep(pool, { tenantId, idleMs: 0, log })), true;
    }
    const match = pathname.match(/^\/api\/demo\/memory\/([^/]+)$/);
    if (match && req.method === "POST") return json(res, 200, await decideMemory(pool, tenantId, user.username, decodeURIComponent(match[1]), body)), true;
    return json(res, 404, { error: "Unknown memory API" }), true;
  } catch (error) {
    return json(res, error.status || 400, { error: String(error.message || "Memory request failed").slice(0, 500) }), true;
  }
}
