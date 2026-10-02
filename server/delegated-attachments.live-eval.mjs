// Optional real-model verification. Uses synthetic scanned receipts, a private
// loopback MCP host and disposable PGlite. Never connects to a claims database.
// node server/delegated-attachments.live-eval.mjs /path/to/pi/models.json [provider] [model]
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { PGlite } from "@electric-sql/pglite";
import { findChromiumExecutable } from "./browser.mjs";
import { NON_CODING_SYSTEM_PROMPT } from "./agent-profiles.mjs";
import { materializeAttachments } from "./attachments.mjs";
import { expenseEvidenceModel, prepareExpenseDelegation } from "./delegated-attachments.mjs";
import { publishFile, readSharedFile, sharedFileLocation } from "./shared-files.mjs";
import { migrate, pgliteAdapter } from "../document_inteligence/core/db.mjs";
import { seedTenant } from "../document_inteligence/core/seed.mjs";
import { runTool, describeError } from "../document_inteligence/core/actions.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const modelsFile = process.argv[2];
if (!modelsFile) throw new Error("Pass the Pi models.json containing a configured vision provider");
const provider = process.argv[3] || "opencode-go";
const model = process.argv[4] || "deepseek-v4.1-flash";
const dir = await mkdtemp(path.join(process.env.HANDOFF_EVAL_ROOT || os.tmpdir(), "expense-handoff-live-"));
const workspace = path.join(dir, "clerk");
const sourceWorkspace = path.join(dir, "orchestrator");
const runtime = path.join(dir, "runtime");
await mkdir(runtime, { recursive: true });
await mkdir(workspace, { recursive: true });
const pg = new PGlite();
const db = pgliteAdapter(pg);
await migrate(db);
const companyId = (await db.query("INSERT INTO di.tenant(name,is_default) VALUES ('Synthetic handoff evaluation',true) RETURNING id")).rows[0].id;
await seedTenant(db, companyId);
const who = { id: "handoff-eval", username: "handoff-eval", display_name: "Pipeline Test", role: "admin" };
await db.query("INSERT INTO di.company_member(tenant_id,name,user_id,department) VALUES ($1,'Pipeline Test','handoff-eval','Test')", [companyId]);
const evidence = Array.from({ length: 7 }, (_, i) => ({ page: i + 1, merchant: `SYNTHETIC TAXI ${i + 1}`, amount: (i + 1) * 10 + 0.25, date: "2026-10-01" }));
const browser = await chromium.launch({ headless: true, executablePath: (await findChromiumExecutable()) || undefined, args: ["--no-sandbox"] });
let pdf;
try {
  const page = await browser.newPage({ viewport: { width: 794, height: 1122 } });
  const scans = [];
  for (const e of evidence) {
    await page.setContent(`<body style="font:32px Arial;padding:65px;background:white;color:black"><h1>${e.merchant}</h1><p>Receipt page ${e.page} of 7</p><p>Date: ${e.date}</p><p>Transport: client site visit</p><p>Total paid: MYR ${e.amount.toFixed(2)}</p><p>Payment: personal card</p><p>SYNTHETIC TEST RECEIPT ${e.page}</p></body>`);
    scans.push(await page.screenshot());
  }
  await page.setContent(`<style>@page{size:A4;margin:0}body{margin:0}img{display:block;width:210mm;height:297mm;break-after:page}img:last-child{break-after:auto}</style>${scans.map(png => `<img src="data:image/png;base64,${png.toString("base64")}">`).join("")}`);
  pdf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
} finally { await browser.close(); }
// Start with the same upload preparation, then publish into company storage.
const upload = await materializeAttachments(sourceWorkspace, [{ name: "synthetic-seven-receipts.pdf", data: pdf.toString("base64") }]);
const file = await publishFile({ root: path.join(dir, "files"), companyId, workspace: sourceWorkspace, source: upload.files[0].rel });
const toolCalls = [];
const host = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.headers.authorization !== "Bearer isolated-eval") return res.writeHead(401).end("{}");
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (body.agent !== "di-expenses") return res.writeHead(403).end("{}");
  try {
    const result = await runTool({ db, tenantId: () => companyId, who, resolveIdentity: async () => who,
      workspace: () => workspace, filesRoot: path.join(dir, "files"), now: () => new Date("2026-10-02T04:00:00Z") }, body);
    toolCalls.push({ tool: body.tool, args: body.args, ok: true });
    res.end(JSON.stringify({ ok: true, result }));
  } catch (error) {
    toolCalls.push({ tool: body.tool, args: body.args, ok: false, error: describeError(error) });
    res.writeHead(400).end(JSON.stringify({ ok: false, error: describeError(error) }));
  }
});
await new Promise(resolve => host.listen(0, "127.0.0.1", resolve));
const models = JSON.parse(await readFile(modelsFile, "utf8"));
assert.ok(models.providers[provider].models.find(m => m.id === model)?.input.includes("image"));
models.providers[provider].headers = { ...models.providers[provider].headers, "x-opencode-session": randomUUID() };
await writeFile(path.join(runtime, "models.json"), JSON.stringify(models));
await writeFile(path.join(runtime, "settings.json"), JSON.stringify({ packages: [] }));
await writeFile(path.join(runtime, "auth.json"), "{}");
await writeFile(path.join(runtime, "mcp.json"), JSON.stringify({ mcpServers: {
  "document-intelligence": { command: process.execPath, args: [path.join(root, "document_inteligence/mcp-server.mjs")], lifecycle: "lazy" },
} }));
const pi = new RpcClient({ cliPath: path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), cwd: workspace,
  provider, model, env: { ...process.env, PI_CODING_AGENT_DIR: runtime, DI_AGENT: "di-expenses", DI_TOKEN: "isolated-eval", DI_URL: `http://127.0.0.1:${host.address().port}` },
  args: ["--system-prompt", NON_CODING_SYSTEM_PROMPT, "--append-system-prompt", path.join(root, "agent/roles/di-expenses.md"),
    "--no-builtin-tools", "--no-skills", "--no-extensions", "--no-prompt-templates", "--no-context-files", "--extension", path.join(root, "node_modules/pi-mcp-adapter"), "--approve", "--thinking", "low"] });
const session = { id: "isolated-child", agentId: "di-expenses", parentSessionId: "isolated-parent", userId: who.id, engine: "pi" };
const report = { provider, model, setup: "Production runManageTurn + Pi RPC + real DI MCP + isolated PGlite", pages: [], modelInputs: [], toolCalls };
try {
  await pi.start();
  const source = await readFile(path.join(root, "server/index.mjs"), "utf8");
  const runner = source.slice(source.indexOf("async function runManageTurn("), source.indexOf("\nfunction hostStatusNote"));
  const deps = { getSession: async id => id === session.id ? session : { agentId: "orchestrator", userId: who.id },
    authenticateExpenseSession: async () => {}, insertMessage: async () => {}, logEvent: () => {}, resolveAgentProfile: async () => ({ id: "di-expenses" }),
    ORCHESTRATOR_AGENT_ID: "orchestrator", prepareExpenseDelegation, expenseEvidenceModel,
    modelCatalog: [{ id: model, available: true, vision: true }], updateSession: async () => session,
    getPool: () => ({ query: async () => ({ rows: [{ content: file.url }] }) }),
    agentWorkspace: agent => agent.id === "orchestrator" ? sourceWorkspace : workspace,
    path, DATA_DIR: dir, companyHostContext: () => ({ tenantId: companyId }), defaultModelId: model,
    withAgentLock: async (_id, fn) => fn(), chat: async (message, _model, _session, _event, images) => {
      report.modelInputs.push({ imageCount: images.length, message });
      assert.equal(images.length, 7);
      await pi.prompt(message, images);
      await pi.waitForIdle(240000);
      const messages = await pi.getMessages();
      const lastUser = messages.filter(m => m.role === "user").at(-1);
      assert.equal(lastUser.content.filter(c => c.type === "image").length, 7);
      return { text: await pi.getLastAssistantText(), blocks: [] };
    }, serializeTurn: turn => turn.text, filesFromBlocks: () => [], publicSession: s => s, scraplingPublic: async () => null };
  const run = new Function(...Object.keys(deps), `${runner};return runManageTurn;`)(...Object.values(deps));
  const summary = await run({ sessionId: session.id, message: `Read EVERY page of the uploaded receipts. Do not file claims yet. Return ONLY JSON {"pages":[{"page":1,"merchant":"...","expense_date":"YYYY-MM-DD","amount":12.34,"receipt":"_inbox/...png"}]}. Include all seven pages in page order and the exact page-specific receipt attachment path supplied by the host. These are synthetic test receipts. [Expense identity: handoff-eval (admin). Pass identity="eval" on expense tools.]` });
  const parsed = JSON.parse(summary.reply.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  assert.equal(parsed.pages.length, 7);
  for (const e of evidence) {
    const actual = parsed.pages[e.page - 1];
    assert.equal(actual.page, e.page);
    assert.equal(actual.merchant.toUpperCase(), e.merchant);
    assert.equal(actual.amount, e.amount);
    assert.equal(actual.expense_date, e.date);
    assert.equal(actual.receipt, report.modelInputs[0].message.match(new RegExp(`page ${e.page} of 7\\. Receipt attachment: (\\S+)`))[1]);
  }
  report.pages = parsed.pages;
  console.log("PASS: clerk read all seven page merchants, dates, totals and receipt references");
  const filed = await run({ sessionId: session.id, message: `Now file all seven synthetic receipts in ${file.url} as seven separate transport claims for the signed-in Pipeline Test user. I authorize filing these isolated test records. Use the current page-specific PNG paths supplied by the host. Do not use allow_duplicate. Return the seven claim numbers. [Expense identity: handoff-eval (admin). Pass identity="eval" on expense tools.]` });
  report.filingReply = filed.reply;
  const claims = (await db.query("SELECT number,merchant,amount FROM di.expense_claim ORDER BY amount")).rows;
  assert.equal(claims.length, 7);
  assert.equal(toolCalls.filter(c => c.tool === "file_claim" && c.ok).length, 7);
  const receipts = (await db.query("SELECT r.file_path,c.merchant FROM di.expense_receipt r JOIN di.expense_claim c ON c.id=r.claim_id")).rows;
  assert.equal(receipts.length, 7);
  for (const [i, e] of evidence.entries()) {
    assert.equal(claims[i].merchant.toUpperCase(), e.merchant);
    assert.equal(Number(claims[i].amount), e.amount);
    const r = receipts.find(r => r.merchant.toUpperCase() === e.merchant);
    const stored = await readSharedFile({ root: path.join(dir, "files"), companyId, ...sharedFileLocation(r.file_path) });
    const input = report.modelInputs[1].message.match(new RegExp(`page ${e.page} of 7\\. Receipt attachment: (\\S+)`))[1];
    assert.deepEqual(await readFile(stored.full), await readFile(path.join(workspace, input)));
  }
  report.claims = claims;
  report.passed = true;
  console.log(`PASS: seven claims filed with matching page evidence in isolated PGlite; report ${path.join(dir, "report.json")}`);
  console.log(JSON.stringify({ pages: report.pages, claims }, null, 2));
} finally {
  await writeFile(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
  await pi.stop();
  await new Promise(resolve => host.close(resolve));
  await pg.close();
  // Remove credential-bearing runtime files; retain the synthetic evidence/report.
  await writeFile(path.join(runtime, "models.json"), "{}");
}
