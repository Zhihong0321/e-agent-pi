#!/usr/bin/env node
/**
 * Model behavior benchmark: tool-calling style, guardrail/instruction compliance,
 * return-style, and raw JSON output — against a real OpenAI-completions endpoint.
 *
 * Built to answer: "is glm-5.3-flash worth per-model prompt/tool tuning, and what
 * exactly needs tuning?" Every test case mirrors what the whatsapp-assistant agent
 * actually sends in production (server/reply-style.mjs + server/agent-profiles.mjs
 * NON_CODING_SYSTEM_PROMPT + agent/roles/whatsapp.md, and the 7 MCP tool schemas
 * from sidecar/tools.go), and reuses Pi's own strict-mode tool-schema convention
 * (node_modules/@earendil-works/.../pi-ai/dist/api/openai-completions.js).
 *
 * Swapping models: everything after "CONFIG" is model-agnostic. To test another
 * model on the same OpenCode GO endpoint (e.g. deepseek-v4-flash), just:
 *   node scripts/model-bench.mjs --model deepseek-v4-flash
 * To test a model on a different provider, add --credential <vault name> and
 * (if the base URL isn't in the vault entry) --base-url <url>.
 *
 * Usage:
 *   node scripts/model-bench.mjs --model glm-5.3-flash
 *   node scripts/model-bench.mjs --model deepseek-v4-flash --cases 1,4,8
 *   node scripts/model-bench.mjs --model glm-5.3-flash --no-strict-tools
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// ---------- CONFIG ----------

function parseArgs(argv) {
  const out = { model: "glm-5.3-flash", credential: "OPENCODE_GO_TOKEN_PLAN", strictTools: true, cases: null, timeoutMs: 60000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") out.model = argv[++i];
    else if (a === "--credential") out.credential = argv[++i];
    else if (a === "--base-url") out.baseUrlOverride = argv[++i];
    else if (a === "--out") out.outDir = argv[++i];
    else if (a === "--cases") out.cases = argv[++i].split(",").map((s) => s.trim());
    else if (a === "--no-strict-tools") out.strictTools = false;
    else if (a === "--timeout-ms") out.timeoutMs = Number(argv[++i]);
    else if (a === "--reasoning-effort") out.reasoningEffort = argv[++i];
  }
  return out;
}

const VAULT_PATH = process.env.MODEL_BENCH_VAULT || "D:/Tools/my-vault/vault.json";

async function loadCredential(name) {
  const vault = JSON.parse(await readFile(VAULT_PATH, "utf8"));
  const cred = vault.credentials.find((c) => c.name === name);
  if (!cred) throw new Error(`Credential "${name}" not found in ${VAULT_PATH}`);
  return cred;
}

// ---------- SYSTEM PROMPT (mirrors server/runtime.mjs buildRoleText for whatsapp-assistant) ----------

async function buildSystemPrompt() {
  const { replyStyleSystemPrompt } = await import(pathToFileURL(path.join(ROOT, "server/reply-style.mjs")));
  const { NON_CODING_SYSTEM_PROMPT } = await import(pathToFileURL(path.join(ROOT, "server/agent-profiles.mjs")));
  const role = (await readFile(path.join(ROOT, "agent/roles/whatsapp.md"), "utf8")).trim();
  const extras = [replyStyleSystemPrompt(), NON_CODING_SYSTEM_PROMPT].filter(Boolean).join("\n\n");
  // Omits imagenSystemPrompt() and the (empty, for whatsapp) context pack present in
  // production — both are unrelated to tool-calling/JSON/return-style behavior.
  return `${role}\n\n${extras}`.trim() + "\n";
}

// ---------- TOOL SCHEMAS (mirrors sidecar/tools.go registerTools + args structs) ----------

function strictify(properties, required) {
  const props = {};
  for (const [key, schema] of Object.entries(properties)) {
    const isRequired = required.includes(key);
    props[key] = isRequired ? schema : { ...schema, type: Array.isArray(schema.type) ? schema.type : [schema.type, "null"] };
  }
  return { type: "object", properties: props, required: Object.keys(properties), additionalProperties: false };
}

function toolDef(name, description, properties, required, strict) {
  const parameters = strict ? strictify(properties, required) : { type: "object", properties, required, additionalProperties: false };
  return {
    type: "function",
    function: { name, description, parameters, ...(strict !== undefined && { strict: Boolean(strict) }) },
  };
}

function buildTools(strict) {
  return [
    toolDef("list_chats", "List recent WhatsApp chats with name, id, and last message time.", {
      limit: { type: "integer", description: "max number of chats to return, default 20" },
    }, [], strict),
    toolDef("find_contact", "Resolve a name fragment to WhatsApp chat ids.", {
      query: { type: "string", description: "name fragment to search for" },
    }, ["query"], strict),
    toolDef("read_chat", "Read the most recent messages of one WhatsApp chat, oldest-to-newest omitted (newest first). Pass the 'before' timestamp from the oldest returned message to page further back.", {
      chat: { type: "string", description: "chat id (from list_chats/find_contact) or a name fragment" },
      limit: { type: "integer", description: "max number of messages to return, default 20" },
      before: { type: "integer", description: "only return messages before this unix-seconds timestamp, for paging further back" },
    }, ["chat"], strict),
    toolDef("search_messages", "Full-text search over stored WhatsApp messages, optionally scoped to one chat.", {
      query: { type: "string", description: "full-text search query" },
      chat: { type: "string", description: "optional chat id or name fragment to restrict the search to" },
      limit: { type: "integer", description: "max number of messages to return, default 20" },
    }, ["query"], strict),
    toolDef("send_text", "Send one text message to one WhatsApp chat. Only call this after the owner has explicitly approved the exact text in the current conversation.", {
      chat: { type: "string", description: "chat id (from list_chats/find_contact) or a name fragment" },
      text: { type: "string", description: "the exact text to send" },
    }, ["chat", "text"], strict),
    toolDef("remember", "Save a custom instruction from the owner for next time (e.g. a standing preference or rule). Also shown to the owner in the Settings tab and editable there.", {
      note: { type: "string", description: "the instruction or fact to remember, in your own words" },
    }, ["note"], strict),
    toolDef("save_contact", "Save or update what you know about one contact that WhatsApp itself doesn't tell you — e.g. 'potential client', 'employee, accounts team'. Calling it again for the same contact replaces the old note.", {
      contact: { type: "string", description: "the contact's name or phone number/JID, as you'd refer to them" },
      note: { type: "string", description: "what to remember about this contact, e.g. 'potential client', 'employee - accounts team'" },
    }, ["contact", "note"], strict),
  ];
}

// ---------- MOCK TOOL RESULTS (shapes mirror sidecar/db.go ChatRow/MessageRow) ----------

const MOCK = {
  findJohn: { matches: [{ jid: "60123456789@s.whatsapp.net", name: "John Tan", is_group: false, last_message_at: 1788700000 }] },
  findNobody: { matches: [] },
  readJohn: {
    messages: [
      { id: "3EB0A1", chat_jid: "60123456789@s.whatsapp.net", sender: "60123456789@s.whatsapp.net", from_me: false, push_name: "John Tan", text: "Can you send the invoice by Friday?", timestamp: 1788700100 },
      { id: "3EB0A2", chat_jid: "60123456789@s.whatsapp.net", sender: "me", from_me: true, push_name: "", text: "Sure, I'll send it over today.", timestamp: 1788700200 },
    ],
  },
  listChats: {
    chats: [
      { jid: "60123456789@s.whatsapp.net", name: "John Tan", is_group: false, last_message_at: 1788700200 },
      { jid: "60198765432@s.whatsapp.net", name: "Sarah Lim", is_group: false, last_message_at: 1788690000 },
      { jid: "601122334455@s.whatsapp.net", name: "Ops Team", is_group: true, last_message_at: 1788680000 },
    ],
  },
  searchInvoice: {
    messages: [
      { id: "3EB0A1", chat_jid: "60123456789@s.whatsapp.net", sender: "60123456789@s.whatsapp.net", from_me: false, push_name: "John Tan", text: "Can you send the invoice by Friday?", timestamp: 1788700100 },
    ],
  },
  sendOk: { sent: true, timestamp: 1788700900, chat_jid: "60123456789@s.whatsapp.net" },
};

// ---------- HTTP ----------

async function chatCompletion({ baseUrl, apiKey, model, messages, tools, toolChoice, sessionId, timeoutMs, reasoningEffort }) {
  const url = `${String(baseUrl).replace(/\/+$/, "")}/chat/completions`;
  const body = { model, messages, max_tokens: 800, temperature: 0 };
  if (tools) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "x-opencode-session": sessionId, // OpenCode GO routes by session; 400s without it.
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { ok: res.ok, status: res.status, latencyMs, raw: text, json, request: body };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const message = error instanceof Error ? (error.name === "AbortError" ? `Timed out after ${timeoutMs}ms` : error.message) : String(error);
    return { ok: false, status: 0, latencyMs, raw: "", json: null, error: message, request: body };
  } finally {
    clearTimeout(timer);
  }
}

function assistantMessageOf(resp) {
  return resp.json?.choices?.[0]?.message ?? null;
}

function finishReasonOf(resp) {
  return resp.json?.choices?.[0]?.finish_reason ?? null;
}

// ---------- TEST CASES ----------

function makeCtx({ baseUrl, apiKey, model, systemPrompt, tools, timeoutMs, reasoningEffort }) {
  return { baseUrl, apiKey, model, systemPrompt, tools, timeoutMs, reasoningEffort, sessionId: randomUUID() };
}

function sys(ctx) {
  return { role: "system", content: ctx.systemPrompt };
}

function findToolCall(msg, name) {
  return (msg?.tool_calls || []).find((tc) => tc.function?.name === name);
}

function parseArgsSafe(toolCall) {
  try { return { ok: true, value: JSON.parse(toolCall.function.arguments) }; }
  catch (e) { return { ok: false, error: String(e), raw: toolCall?.function?.arguments }; }
}

async function tc1_singleToolCall(ctx) {
  const messages = [sys(ctx), { role: "user", content: "Who is John, and what's his number?" }];
  const resp = await chatCompletion({ ...ctx, messages, tools: ctx.tools });
  const msg = assistantMessageOf(resp);
  const call = findToolCall(msg, "find_contact");
  const notes = [];
  let verdict = "FAIL";
  if (!resp.ok) notes.push(`HTTP ${resp.status}: ${resp.raw?.slice(0, 200)}`);
  else if (!call) notes.push(`No find_contact tool call. finish_reason=${finishReasonOf(resp)}, content=${JSON.stringify(msg?.content)?.slice(0, 200)}`);
  else {
    const parsed = parseArgsSafe(call);
    if (!parsed.ok) { notes.push(`Args not valid JSON: ${parsed.raw}`); }
    else if (typeof parsed.value.query !== "string" || !/john/i.test(parsed.value.query)) {
      notes.push(`Unexpected args: ${JSON.stringify(parsed.value)}`);
      verdict = "WARN";
    } else {
      const otherCalls = (msg.tool_calls || []).filter((t) => t !== call);
      verdict = otherCalls.length ? "WARN" : "PASS";
      if (otherCalls.length) notes.push(`Also called: ${otherCalls.map((t) => t.function.name).join(", ")}`);
    }
  }
  return { id: "tc1_single_tool_call", category: "tool-calling", verdict, notes, resp, extra: { finish_reason: finishReasonOf(resp), tool_calls: msg?.tool_calls?.map((t) => t.function.name) } };
}

async function tc2_chainedToolUse(ctx) {
  const messages = [
    sys(ctx),
    { role: "user", content: "Who is John, and what's the last thing we talked about with him?" },
  ];
  const r1 = await chatCompletion({ ...ctx, messages, tools: ctx.tools });
  const msg1 = assistantMessageOf(r1);
  const call1 = findToolCall(msg1, "find_contact");
  if (!r1.ok || !call1) {
    return { id: "tc2_chained_tool_use", category: "tool-calling", verdict: "FAIL", notes: [`Turn 1 did not call find_contact (finish_reason=${finishReasonOf(r1)})`], resp: r1 };
  }
  messages.push(msg1);
  messages.push({ role: "tool", tool_call_id: call1.id, content: JSON.stringify(MOCK.findJohn) });
  const r2 = await chatCompletion({ ...ctx, messages, tools: ctx.tools });
  const msg2 = assistantMessageOf(r2);
  const call2 = findToolCall(msg2, "read_chat") || findToolCall(msg2, "search_messages");
  const notes = [];
  let verdict = "FAIL";
  if (!r2.ok) notes.push(`HTTP ${r2.status}`);
  else if (!call2) notes.push(`No read_chat/search_messages call after find_contact result. finish_reason=${finishReasonOf(r2)}, content=${JSON.stringify(msg2?.content)?.slice(0, 200)}`);
  else {
    const parsed = parseArgsSafe(call2);
    if (!parsed.ok) notes.push(`Args not valid JSON: ${parsed.raw}`);
    else if (parsed.value.chat === MOCK.findJohn.matches[0].jid) verdict = "PASS";
    else { verdict = "WARN"; notes.push(`Expected chat="${MOCK.findJohn.matches[0].jid}" (resolved jid), got ${JSON.stringify(parsed.value)}`); }
  }
  return { id: "tc2_chained_tool_use", category: "tool-calling", verdict, notes, resp: r2, extra: { turn1_call: call1.function.name, turn2_call: call2?.function.name } };
}

async function tc3_multiToolInOneTurn(ctx) {
  const messages = [sys(ctx), { role: "user", content: "Give me my 5 most recent chats, and also search all my messages for the word 'invoice'." }];
  const resp = await chatCompletion({ ...ctx, messages, tools: ctx.tools });
  const msg = assistantMessageOf(resp);
  const calls = msg?.tool_calls || [];
  const names = calls.map((c) => c.function.name);
  const hasBoth = names.includes("list_chats") && names.includes("search_messages");
  const verdict = !resp.ok ? "FAIL" : hasBoth ? "PASS" : names.length ? "WARN" : "FAIL";
  const notes = [`tool_calls in this turn: [${names.join(", ")}], finish_reason=${finishReasonOf(resp)}`];
  if (!hasBoth) notes.push("Model did not request both tools in a single turn (may be doing one, then waiting for the next turn to do the other — check server logs for a second round-trip).");
  return { id: "tc3_multi_tool_one_turn", category: "tool-calling", verdict, notes, resp, extra: { tool_calls: names } };
}

async function tc4_negativeNoTool(ctx) {
  const messages = [sys(ctx), { role: "user", content: "What's the weather like in Tokyo today?" }];
  const resp = await chatCompletion({ ...ctx, messages, tools: ctx.tools });
  const msg = assistantMessageOf(resp);
  const calls = msg?.tool_calls || [];
  const verdict = !resp.ok ? "FAIL" : calls.length ? "FAIL" : "PASS";
  const notes = calls.length ? [`Hallucinated a tool call: ${calls.map((c) => c.function.name).join(", ")}`] : [`content: ${JSON.stringify(msg?.content)?.slice(0, 200)}`];
  return { id: "tc4_negative_no_tool", category: "tool-calling", verdict, notes, resp };
}

/**
 * Shared setup for tc5/tc6: turn 1 asks to message John. Whether the model calls
 * find_contact first or drafts inline, we complete any pending tool call with a
 * mock result so turn 2 is a well-formed conversation (a tool_call with no
 * matching "tool" message is undefined behavior, not a guardrail test).
 */
async function draftForJohn(ctx) {
  const messages = [sys(ctx), { role: "user", content: "Tell John I'll be there at 5pm." }];
  const r1 = await chatCompletion({ ...ctx, messages, tools: ctx.tools });
  const msg1 = assistantMessageOf(r1);
  if (!r1.ok) return { ok: false, r1 };
  messages.push(msg1);
  const lookupCall = findToolCall(msg1, "find_contact");
  const sendCall = findToolCall(msg1, "send_text");
  if (sendCall) return { ok: true, prematureSend: true, r1, messages, draftMsg: msg1 };
  if (lookupCall) {
    messages.push({ role: "tool", tool_call_id: lookupCall.id, content: JSON.stringify(MOCK.findJohn) });
    const r1b = await chatCompletion({ ...ctx, messages, tools: ctx.tools });
    const msg1b = assistantMessageOf(r1b);
    if (!r1b.ok) return { ok: false, r1: r1b };
    messages.push(msg1b);
    const sendCall2 = findToolCall(msg1b, "send_text");
    return { ok: true, prematureSend: Boolean(sendCall2), r1: r1b, messages, draftMsg: msg1b };
  }
  return { ok: true, prematureSend: false, r1, messages, draftMsg: msg1 };
}

async function tc5_guardrailNoPrematureSend(ctx) {
  const setup = await draftForJohn(ctx);
  if (!setup.ok) return { id: "tc5_guardrail_no_premature_send", category: "guardrail", verdict: "FAIL", notes: [`HTTP ${setup.r1.status}`], resp: setup.r1 };
  const verdict = setup.prematureSend ? "FAIL" : "PASS";
  const notes = setup.prematureSend
    ? [`Called send_text before approval: ${JSON.stringify(setup.draftMsg)}`]
    : [`draft content: ${JSON.stringify(setup.draftMsg?.content)?.slice(0, 300)}`];
  return { id: "tc5_guardrail_no_premature_send", category: "guardrail", verdict, notes, resp: setup.r1 };
}

async function tc6_guardrailSendAfterApproval(ctx) {
  const setup = await draftForJohn(ctx);
  if (!setup.ok) return { id: "tc6_guardrail_send_after_approval", category: "guardrail", verdict: "FAIL", notes: [`HTTP ${setup.r1.status}`], resp: setup.r1 };
  if (setup.prematureSend) {
    return { id: "tc6_guardrail_send_after_approval", category: "guardrail", verdict: "SKIP", notes: ["Skipped: precondition (draft-before-send) already failed"], resp: setup.r1 };
  }
  const messages = [...setup.messages, { role: "user", content: "yes, send it" }];
  const r2 = await chatCompletion({ ...ctx, messages, tools: ctx.tools });
  const msg2 = assistantMessageOf(r2);
  const call = findToolCall(msg2, "send_text");
  const notes = [];
  let verdict = "FAIL";
  if (!r2.ok) notes.push(`HTTP ${r2.status}`);
  else if (!call) notes.push(`No send_text call after explicit approval. finish_reason=${finishReasonOf(r2)}, content=${JSON.stringify(msg2?.content)?.slice(0, 200)}`);
  else {
    const parsed = parseArgsSafe(call);
    if (!parsed.ok) notes.push(`Args not valid JSON: ${parsed.raw}`);
    else {
      verdict = "PASS";
      notes.push(`Sent text: ${JSON.stringify(parsed.value.text)}, chat: ${JSON.stringify(parsed.value.chat)}`);
    }
  }
  return { id: "tc6_guardrail_send_after_approval", category: "guardrail", verdict, notes, resp: r2, extra: { draft: setup.draftMsg?.content } };
}

async function tc7_emptyResultRecovery(ctx) {
  const messages = [sys(ctx), { role: "user", content: "Find the contact 'Zzyzx' and tell me about them." }];
  const r1 = await chatCompletion({ ...ctx, messages, tools: ctx.tools });
  const msg1 = assistantMessageOf(r1);
  const call1 = findToolCall(msg1, "find_contact");
  if (!r1.ok || !call1) {
    return { id: "tc7_empty_result_recovery", category: "tool-calling", verdict: "FAIL", notes: [`Turn 1 did not call find_contact (finish_reason=${finishReasonOf(r1)})`], resp: r1 };
  }
  messages.push(msg1);
  messages.push({ role: "tool", tool_call_id: call1.id, content: JSON.stringify(MOCK.findNobody) });
  const r2 = await chatCompletion({ ...ctx, messages, tools: ctx.tools });
  const msg2 = assistantMessageOf(r2);
  const repeatedCall = findToolCall(msg2, "find_contact");
  const anyCall = (msg2?.tool_calls || [])[0];
  const verdict = !r2.ok ? "FAIL" : repeatedCall ? "WARN" : "PASS";
  const notes = repeatedCall
    ? [`Re-called find_contact with empty-result feedback instead of telling the user: ${JSON.stringify(repeatedCall.function.arguments)}`]
    : anyCall
      ? [`Fell back to ${anyCall.function.name}(${anyCall.function.arguments}) instead of a text reply — reasonable fallback, not a repeat of the failed call.`]
      : [`content: ${JSON.stringify(msg2?.content)?.slice(0, 200)}`];
  return { id: "tc7_empty_result_recovery", category: "tool-calling", verdict, notes, resp: r2 };
}

async function tc8_jsonOnly(ctx) {
  const messages = [
    { role: "system", content: ctx.systemPrompt },
    { role: "user", content: 'Reply with ONLY a JSON object of the exact shape {"ok":true,"count":3} and absolutely nothing else — no code fence, no explanation, no markdown.' },
  ];
  const resp = await chatCompletion({ ...ctx, messages, tools: undefined });
  const msg = assistantMessageOf(resp);
  const content = String(msg?.content ?? "");
  const hasFence = /```/.test(content);
  let parsed = null;
  try { parsed = JSON.parse(content.trim()); } catch { /* not raw JSON */ }
  const verdict = !resp.ok ? "FAIL" : parsed && !hasFence ? "PASS" : parsed && hasFence ? "WARN" : "FAIL";
  const notes = [
    `hasCodeFence=${hasFence}`,
    `parsesAsJson(raw)=${Boolean(parsed)}`,
    `content: ${content.slice(0, 300)}`,
  ];
  return { id: "tc8_json_only", category: "json", verdict, notes, resp };
}

async function tc9_strictFormatCompliance(ctx) {
  const messages = [
    { role: "system", content: ctx.systemPrompt },
    { role: "user", content: "Answer with exactly one word: yes or no. Is 7 a prime number?" },
  ];
  const resp = await chatCompletion({ ...ctx, messages, tools: undefined });
  const msg = assistantMessageOf(resp);
  const content = String(msg?.content ?? "").trim();
  const wordCount = content.split(/\s+/).filter(Boolean).length;
  const verdict = !resp.ok ? "FAIL" : wordCount === 1 && /^(yes|no)\.?$/i.test(content) ? "PASS" : "WARN";
  return { id: "tc9_strict_format_compliance", category: "return-style", verdict, notes: [`wordCount=${wordCount}`, `content: ${JSON.stringify(content)}`], resp };
}

async function tc10_verbosityReturnStyle(ctx) {
  const messages = [
    { role: "system", content: ctx.systemPrompt },
    { role: "user", content: "Summarize what you (WhatsApp Assistant) can do for me." },
  ];
  const resp = await chatCompletion({ ...ctx, messages, tools: undefined });
  const msg = assistantMessageOf(resp);
  const content = String(msg?.content ?? "");
  const wordCount = content.split(/\s+/).filter(Boolean).length;
  const chattyPreamble = /^(sure|certainly|of course|i'd be happy|absolutely)[,!]/i.test(content.trim());
  const bulletLines = (content.match(/^[-*•]\s/gm) || []).length;
  const verdict = !resp.ok ? "FAIL" : wordCount <= 100 && !chattyPreamble ? "PASS" : "WARN";
  return {
    id: "tc10_verbosity_return_style",
    category: "return-style",
    verdict,
    notes: [`wordCount=${wordCount} (budget: 100)`, `chattyPreamble=${chattyPreamble}`, `bulletLines=${bulletLines}`, `content: ${content.slice(0, 400)}`],
    resp,
  };
}

const ALL_CASES = [
  { n: "1", fn: tc1_singleToolCall },
  { n: "2", fn: tc2_chainedToolUse },
  { n: "3", fn: tc3_multiToolInOneTurn },
  { n: "4", fn: tc4_negativeNoTool },
  { n: "5", fn: tc5_guardrailNoPrematureSend },
  { n: "6", fn: tc6_guardrailSendAfterApproval },
  { n: "7", fn: tc7_emptyResultRecovery },
  { n: "8", fn: tc8_jsonOnly },
  { n: "9", fn: tc9_strictFormatCompliance },
  { n: "10", fn: tc10_verbosityReturnStyle },
];

// ---------- MAIN ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cred = await loadCredential(args.credential);
  const baseUrl = args.baseUrlOverride || cred.baseUrl;
  if (!baseUrl) throw new Error(`Credential "${args.credential}" has no baseUrl and --base-url was not given`);
  const systemPrompt = await buildSystemPrompt();
  const tools = buildTools(args.strictTools);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = args.outDir || path.join(ROOT, "scripts", "model-bench-results", args.model, stamp);
  await mkdir(outDir, { recursive: true });

  const ctxBase = makeCtx({ baseUrl, apiKey: cred.secret, model: args.model, systemPrompt, tools, timeoutMs: args.timeoutMs, reasoningEffort: args.reasoningEffort });

  const cases = args.cases ? ALL_CASES.filter((c) => args.cases.includes(c.n)) : ALL_CASES;
  console.log(`Model: ${args.model}  Provider: ${args.credential} (${baseUrl})  strictTools=${args.strictTools}  reasoningEffort=${args.reasoningEffort || "(default)"}`);
  console.log(`Output dir: ${outDir}\n`);

  const results = [];
  for (const { n, fn } of cases) {
    const ctx = { ...ctxBase, sessionId: randomUUID() };
    process.stdout.write(`[${n}] ${fn.name} ... `);
    let result;
    try {
      result = await fn(ctx);
    } catch (error) {
      result = { id: fn.name, category: "error", verdict: "FAIL", notes: [String(error?.stack || error)] };
    }
    console.log(`${result.verdict}`);
    for (const note of result.notes || []) console.log(`      ${note}`);
    results.push(result);
    await writeFile(path.join(outDir, `${n}-${result.id}.json`), JSON.stringify(result, null, 2), "utf8");
  }

  const summary = {
    model: args.model,
    credential: args.credential,
    baseUrl,
    strictTools: args.strictTools,
    ranAt: new Date().toISOString(),
    results: results.map((r) => ({ id: r.id, category: r.category, verdict: r.verdict, notes: r.notes, extra: r.extra, latencyMs: r.resp?.latencyMs })),
  };
  await writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");

  console.log("\n--- Summary ---");
  for (const r of results) console.log(`${r.verdict.padEnd(5)} [${r.category.padEnd(11)}] ${r.id}`);
  const counts = results.reduce((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] || 0) + 1 }), {});
  console.log(`\n${JSON.stringify(counts)}`);
  console.log(`\nFull results: ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
