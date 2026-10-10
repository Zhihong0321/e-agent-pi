// Shared isolated harness for Pi stress tests: PGlite + real DI MCP server + Pi CLI,
// with the checker agent in the loop (pre-commit gate on the host, reply check after each turn).
//
//   node test/<runner>.mjs [count] [--no-checker]
//
// --no-checker runs the same scenarios without gate or reply check, for a baseline.
import { spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { chromium } from "playwright";
import { findChromiumExecutable } from "../../server/browser.mjs";
import { NON_CODING_SYSTEM_PROMPT } from "../../server/agent-profiles.mjs";
import { migrate, pgliteAdapter } from "../core/db.mjs";
import { createTestCompany } from "./company-fixture.mjs";
import { runTool, describeError } from "../core/actions.mjs";
import { createChecker, blockedMessage, isGated } from "../checker/index.mjs";
import { createJudge, judgeConfigFromEnv } from "../checker/judge.mjs";
import { dbDescribe, dbLookup } from "../checker/lookup.mjs";
import { runChecked } from "../checker/loop.mjs";
import { publicFormRoute } from "../host.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DI_ROOT = path.resolve(HERE, "..");
const ROOT = path.resolve(DI_ROOT, "..");
const PI_CLI = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const MCP_ADAPTER = path.join(ROOT, "node_modules", "pi-mcp-adapter");
const MCP_SERVER = path.join(DI_ROOT, "mcp-server.mjs");

function runPi(args, env, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PI_CLI, ...args], { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (["tool_execution_start", "agent_end"].includes(event.type)) process.stdout.write(`  PI ${event.type} ${event.toolName || ""}\n`);
        } catch { /* Pi may emit a plain-text startup line. */ }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on("error", (error) => { stderr += error.message; });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, timedOut, stdout: stdout.trim(), stderr: stderr.trim() }); });
  });
}

function finalText(stream) {
  let last = "";
  for (const line of stream.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const text = event.message.content?.filter((part) => part.type === "text").map((part) => part.text).join("") || "";
        if (text.trim()) last = text;
      }
    } catch { /* Startup lines need no parsing. */ }
  }
  return last;
}

/**
 * @param {{
 *   name: string,                       output folder name under the OS temp dir
 *   scenarios: [string, string][],      [agent, prompt]
 *   provider: string, modelId: string,  exact Pi provider/model for every worker turn
 *   providerConfig: object,             the models.json provider entry
 *   env?: Record<string, string>,       extra env for the Pi process (API keys)
 *   fixtures?: (fixture: (agent: string, tool: string, args: any) => Promise<any>,
 *              helpers: { submit: (slug: string, body: any) => Promise<any> }) => Promise<any>,
 *   thinking?: string, timeoutMs?: number, maxRetries?: number,
 * }} opts
 */
export async function runStressTest(opts) {
  const argv = process.argv.slice(2);
  const useChecker = !argv.includes("--no-checker");
  const limit = Number(argv.find((a) => /^\d+$/.test(a)) || opts.scenarios.length);
  const OUTPUT = path.join(os.tmpdir(), opts.name, new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(OUTPUT, { recursive: true });

  const db = pgliteAdapter(new PGlite());
  await migrate(db);
  const tenantId = await createTestCompany(db, "Test Co");

  let browser;
  async function renderPdf(html, absPath) {
    browser ??= await chromium.launch({ headless: true, executablePath: (await findChromiumExecutable()) || undefined, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: "load", timeout: 20000 });
      await mkdir(path.dirname(absPath), { recursive: true });
      await page.pdf({ path: absPath, format: "A4", printBackground: true, preferCSSPageSize: true });
    } finally {
      await page.close();
    }
  }

  const judgeConfig = judgeConfigFromEnv();
  const dbQuery = (sql, params) => db.query(sql, params);
  const checker = useChecker ? createChecker({ judge: createJudge(judgeConfig), lookup: dbLookup(dbQuery), describe: dbDescribe(dbQuery) }) : null;
  const report = {
    startedAt: new Date().toISOString(), setup: "Pi CLI + real MCP server + isolated PGlite host",
    provider: opts.provider, modelId: opts.modelId,
    checker: useChecker ? { model: judgeConfig.model, baseUrl: judgeConfig.baseUrl, reasoningEffort: judgeConfig.reasoningEffort, maxRetries: opts.maxRetries ?? 2 } : null,
    steps: [], fixtureCalls: [], toolCalls: [], gateDecisions: [],
  };
  const save = () => writeFile(path.join(OUTPUT, "report.json"), JSON.stringify(report, null, 2));
  const context = { db, tenantId: () => tenantId, actor: "pi-eval", workspace: (agent) => path.join(OUTPUT, "workspace", agent), renderPdf };

  if (opts.fixtures) {
    let ip = 0;
    // A public form submission, exactly as the host's /api/forms/<slug> route stores it.
    const submit = async (slug, body) => {
      const out = await publicFormRoute({
        db, tenantId, workspace: context.workspace, method: "POST", slug,
        contentType: "application/json", bodyText: JSON.stringify(body), ip: `fixture-${++ip}`,
      });
      const result = { status: out.status, ...JSON.parse(out.body) };
      report.fixtureCalls.push({ agent: "public", tool: "submit_form", args: { slug, body }, result });
      if (out.status !== 200) throw new Error(`fixture submission to ${slug} failed: ${out.body}`);
      return result;
    };
    await opts.fixtures(async (agent, tool, args) => {
      const result = await runTool(context, { agent, tool, args });
      report.fixtureCalls.push({ agent, tool, args, result });
      return result;
    }, { submit });
  }
  await save();

  // Current turn, read by the host so the gate knows what the user asked.
  let turn = { step: 0, agent: "", input: "", earlier: [] };
  const callsThisTurn = () => report.toolCalls.filter((c) => c.step === turn.step);

  const host = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== `Bearer eval-${body.agent}`) return res.writeHead(401).end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    const call = { step: turn.step, agent: body.agent, tool: body.tool, args: body.args };
    if (checker && isGated(body.tool, body.args)) {
      const gate = await checker.gateWrite({ agent: body.agent, input: turn.input, earlier: turn.earlier, priorCalls: callsThisTurn(), tool: body.tool, args: body.args });
      report.gateDecisions.push({ step: turn.step, tool: body.tool, args: body.args, ...gate });
      process.stdout.write(`  GATE ${body.tool} ${gate.allow ? "allow" : `BLOCK ${gate.reason}`}${gate.judgeError ? ` (judge error: ${gate.judgeError})` : ""}\n`);
      if (!gate.allow) {
        call.ok = false;
        call.blocked = true;
        call.target = gate.target;
        call.error = { code: "checker_blocked", message: blockedMessage(body.tool, gate.reason) };
        report.toolCalls.push(call);
        return res.writeHead(400).end(JSON.stringify({ ok: false, error: call.error }));
      }
    }
    report.toolCalls.push(call);
    try {
      const result = await runTool(context, body);
      call.ok = true;
      call.result = result;
      res.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      call.ok = false;
      call.error = describeError(error);
      res.writeHead(400).end(JSON.stringify({ ok: false, error: call.error }));
    }
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${host.address().port}`;

  const history = {}; // agent -> earlier user messages in its session
  try {
    const count = Math.min(opts.scenarios.length, limit);
    for (let i = 0; i < count; i++) {
      const [agent, prompt] = opts.scenarios[i];
      turn = { step: i + 1, agent, input: prompt, earlier: (history[agent] || []).slice(-3) };
      const dir = path.join(OUTPUT, agent);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "models.json"), JSON.stringify({ providers: { [opts.provider]: opts.providerConfig } }));
      await writeFile(path.join(dir, "settings.json"), JSON.stringify({ packages: [], enableSkillCommands: true }));
      await writeFile(path.join(dir, "auth.json"), "{}");
      await writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: {
        "document-intelligence": { command: process.execPath, args: [MCP_SERVER], lifecycle: "lazy" },
      } }));
      const role = path.join(ROOT, "agent", "roles", `${agent}.md`);
      const session = path.join(OUTPUT, `${agent}-session.jsonl`);
      const env = { ...process.env, ...(opts.env || {}), PI_CODING_AGENT_DIR: dir, DI_AGENT: agent, DI_TOKEN: `eval-${agent}`, DI_URL: url };
      const runs = [];
      const run = async (message) => {
        const args = [
          "--system-prompt", NON_CODING_SYSTEM_PROMPT, "--append-system-prompt", role,
          "--provider", opts.provider, "--model", opts.modelId,
          "--no-builtin-tools", "--thinking", opts.thinking || "low",
          "--no-skills", "--no-extensions", "--no-prompt-templates", "--no-context-files",
          "--extension", MCP_ADAPTER, "--session", session, "--approve", "--mode", "json", "--print", message,
        ];
        const result = await runPi(args, env, OUTPUT, opts.timeoutMs || 240000);
        runs.push({ code: result.code, timedOut: result.timedOut, stderr: result.stderr.slice(-2000), stdout: result.stdout });
        return { reply: finalText(result.stdout) };
      };

      process.stdout.write(`STEP ${turn.step}/${count} ${agent}\n`);
      let outcome;
      if (checker) {
        outcome = await runChecked({ checker, run, callsThisTurn, agent, input: prompt, earlier: turn.earlier, maxRetries: opts.maxRetries ?? 2 });
        for (const [n, a] of outcome.attempts.entries()) {
          process.stdout.write(`  CHECK attempt ${n + 1}: ${a.verdict.pass ? "pass" : "FAIL"} (${a.verdict.by})${a.verdict.problems.length ? ` ${a.verdict.problems.join(" | ")}` : ""}${a.verdict.judgeError ? ` judge error: ${a.verdict.judgeError}` : ""}\n`);
        }
      } else {
        const { reply } = await run(prompt);
        outcome = { reply, passed: null, attempts: [{ message: prompt, reply, verdict: null }] };
      }
      history[agent] = [...(history[agent] || []), prompt];
      report.steps.push({
        number: turn.step, agent, prompt, finalText: outcome.reply, checkerPassed: outcome.passed,
        attempts: outcome.attempts.map((a, n) => ({ ...a, run: { ...runs[n], stdout: undefined } })),
        rawStdout: runs.map((r) => r.stdout),
        toolCalls: callsThisTurn().map(({ tool, ok, error, blocked }) => ({ tool, ok, error, blocked })),
      });
      await save();
      process.stdout.write(`  DONE calls=${callsThisTurn().length} attempts=${outcome.attempts.length} reply=${outcome.reply.replace(/\s+/g, " ").slice(0, 300)}\n`);
    }

    const query = async (sql) => (await db.query(sql)).rows;
    report.finalState = {
      company: await query("SELECT name, legal_name, reg_no, address, phone, email, currency, bank_details FROM di.company_profile"),
      customers: await query("SELECT code, name, legal_name, reg_no, billing_address, payment_terms_days FROM di.customer"),
      contacts: await query("SELECT name, job_title, email, is_primary FROM di.contact"),
      products: await query("SELECT sku, name, unit_price, tax_code FROM di.product"),
      packages: await query("SELECT code, name, price, tax_code FROM di.package"),
      documents: await query("SELECT id, number, doc_type, status, total, valid_until, due_date, reference, source_document_id, pdf_path FROM di.document"),
      payments: await query("SELECT number, amount, reference FROM di.payment"),
      allocations: await query("SELECT amount, document_id FROM di.payment_allocation"),
      customFields: await query("SELECT entity, key, type, required_for FROM di.field_def WHERE deleted_at IS NULL"),
      templates: await query("SELECT doc_type, name, version, is_default FROM di.template WHERE deleted_at IS NULL"),
      forms: await query("SELECT slug, title, status, published_version, close_reason, deleted_at IS NOT NULL AS archived FROM di.form"),
      formVersions: await query(
        "SELECT f.slug, v.version, v.status, v.settings, v.schema FROM di.form_version v JOIN di.form f ON f.id = v.form_id ORDER BY f.slug, v.version",
      ),
      submissions: await query(
        `SELECT f.slug, s.id, s.version, s.status, s.review_note, s.data, c.code AS customer, d.id AS document_id, d.status AS document_status
           FROM di.form_submission s JOIN di.form f ON f.id = s.form_id
           LEFT JOIN di.customer c ON c.id = s.linked_customer_id LEFT JOIN di.document d ON d.id = s.linked_document_id
          ORDER BY f.slug, s.submitted_at`,
      ),
    };
    report.summary = summarize(report);
    report.completedAt = new Date().toISOString();
    await save();
    process.stdout.write(`SUMMARY ${JSON.stringify(report.summary)}\nREPORT ${path.join(OUTPUT, "report.json")}\n`);
    return report;
  } finally {
    await new Promise((resolve) => host.close(resolve));
    if (browser) await browser.close().catch(() => {});
  }
}

function summarize(report) {
  const steps = report.steps;
  return {
    steps: steps.length,
    firstTryPass: steps.filter((s) => s.attempts[0]?.verdict?.pass).length,
    passedAfterRetry: steps.filter((s) => s.checkerPassed && s.attempts.length > 1).length,
    unconfirmed: steps.filter((s) => s.checkerPassed === false).length,
    retries: steps.reduce((n, s) => n + s.attempts.length - 1, 0),
    toolCalls: report.toolCalls.length,
    toolErrors: report.toolCalls.filter((c) => c.ok === false && !c.blocked).length,
    gateBlocks: report.gateDecisions.filter((g) => !g.allow).length,
    judgeErrors: report.gateDecisions.filter((g) => g.judgeError).length + steps.flatMap((s) => s.attempts).filter((a) => a.verdict?.judgeError).length,
  };
}
