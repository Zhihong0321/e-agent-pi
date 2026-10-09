import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { materializeAttachments } from "./attachments.mjs";
import { expenseEvidenceModel, prepareExpenseDelegation } from "./delegated-attachments.mjs";
import { publishFile, readSharedFile, sharedFileLocation } from "./shared-files.mjs";
import { migrate, pgliteAdapter } from "../document_inteligence/core/db.mjs";
import { seedTenant } from "../document_inteligence/core/seed.mjs";
import { runTool } from "../document_inteligence/core/actions.mjs";

const poppler = !spawnSync("pdftotext", ["-v"]).error && !spawnSync("pdftoppm", ["-v"]).error;

// Blank image pages exercise scanned-page detection; the optional live evaluation
// uses visible synthetic receipts to verify the model reads their actual contents.
function pdf(pages) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids = [];
  for (const text of pages) {
    const n = objects.length + 1;
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : "q 300 0 0 300 100 400 cm /Im0 Do Q";
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${n + 1} 0 R /Resources << /Font << /F1 3 0 R >> /XObject << /Im0 ${n + 2} 0 R >> >> >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x80\nendstream");
    kids.push(`${n} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => { const offset = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return offset; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

async function fixture(t, bytes = pdf(Array(7).fill(null))) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "expense-handoff-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sourceWorkspace = path.join(dir, "orchestrator");
  const workspace = path.join(dir, "clerk");
  const root = path.join(dir, "files");
  await mkdir(path.join(sourceWorkspace, "_inbox"), { recursive: true });
  const source = "_inbox/upload.pdf";
  await writeFile(path.join(sourceWorkspace, source), bytes);
  const file = await publishFile({ root, companyId: "company-a", workspace: sourceWorkspace, source });
  return { dir, sourceWorkspace, workspace, root, companyId: "company-a", file, source };
}

test("delegation delivers seven numbered scanned pages and usable page receipt paths", { skip: !poppler }, async t => {
  const f = await fixture(t);
  const packed = await prepareExpenseDelegation({ ...f, message: `Read every page: ${f.file.url}.` });
  assert.equal(packed.images.length, 7);
  for (let page = 1; page <= 7; page++) {
    assert.match(packed.message, new RegExp(`Image ${page}: .*page ${page} of 7`));
    const rel = packed.message.match(new RegExp(`page ${page} of 7\\. Receipt attachment: (\\S+)`))[1];
    assert.equal((await readFile(path.join(f.workspace, rel))).toString("base64"), packed.images[page - 1].data);
  }
  assert.equal(packed.files.length, 1);
  assert.deepEqual(await readFile(packed.files[0].abs), pdf(Array(7).fill(null)));
  assert.match(packed.message, /clerk-local receipt paths/);
});

test("old inbox references and repeated shared URLs resolve to one receipt", { skip: !poppler }, async t => {
  const f = await fixture(t);
  const packed = await prepareExpenseDelegation({ ...f, message: `${f.source} ${f.file.url} ${f.file.url}` });
  assert.equal(packed.files.length, 1);
  assert.equal(packed.images.length, 7);
  const inherited = await prepareExpenseDelegation({ ...f, message: "Read the uploaded receipts; use _inbox/...png per page", sourceMessage: f.file.url });
  assert.equal(inherited.images.length, 7, "parent upload survives an omitted URL in the task");
});

test("scanned evidence uses an available vision model without changing the global default", () => {
  const catalog = [{ id: "text", provider: "a", available: true, vision: false },
    { id: "vision", provider: "a", available: true, vision: true }];
  assert.equal(expenseEvidenceModel(catalog, "text"), "vision");
  assert.equal(expenseEvidenceModel(catalog, "vision"), "vision");
  assert.throws(() => expenseEvidenceModel(catalog.slice(0, 1), "text"), /configured vision model/);
});

test("seven published page images reach the clerk while direct upload retains its six-file limit", async t => {
  const f = await fixture(t);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4WQAAAAASUVORK5CYII=", "base64");
  const urls = [];
  const raw = [];
  for (let page = 1; page <= 7; page++) {
    const source = `_inbox/page-${page}.png`;
    await writeFile(path.join(f.sourceWorkspace, source), png);
    const ref = await publishFile({ ...f, workspace: f.sourceWorkspace, source });
    urls.push(ref.url);
    raw.push({ name: `page-${page}.png`, data: png.toString("base64") });
  }
  const packed = await prepareExpenseDelegation({ ...f, message: urls.join("\n") });
  assert.equal(packed.files.length, 7);
  assert.equal(packed.images.length, 7);
  for (const file of packed.files) assert.deepEqual(await readFile(file.abs), png);
  await assert.rejects(materializeAttachments(f.workspace, raw), /Attach at most 6 files/);
  const tooMany = Array.from({ length: 65 }, (_, i) => `/files/${"a".repeat(64)}/page-${i}.png`).join("\n");
  await assert.rejects(prepareExpenseDelegation({ ...f, message: tooMany }), /at most 64 delegated/);
});

test("mixed PDFs deliver text plus explicitly numbered scanned pages", { skip: !poppler }, async t => {
  const f = await fixture(t, pdf(["Text receipt merchant one amount MYR 12.34", null, "Text receipt merchant three amount MYR 56.78", null, null, null, null]));
  const packed = await prepareExpenseDelegation({ ...f, message: f.file.url });
  assert.equal(packed.images.length, 5);
  assert.match(packed.message, /Text receipt merchant three/);
  assert.match(packed.message, /Image 1: .*page 2 of 7/);
  assert.match(packed.message, /Image 5: .*page 7 of 7/);
  assert.doesNotMatch(packed.message, /Render them with/);
});

test("delegation includes document text beyond the direct-chat excerpt", { skip: !poppler }, async t => {
  const f = await fixture(t, pdf(["Receipt evidence ".repeat(700), "FINAL PAGE merchant seven total MYR 70.25"]));
  const packed = await prepareExpenseDelegation({ ...f, message: f.file.url });
  assert.equal(packed.images.length, 0);
  assert.match(packed.message, /FINAL PAGE merchant seven total MYR 70.25/);
  assert.doesNotMatch(packed.message, /Showing \d+ of \d+ chars/);
});

test("company isolation, traversal and unreadable evidence fail before model input", async t => {
  const f = await fixture(t);
  await assert.rejects(prepareExpenseDelegation({ ...f, companyId: "company-b", message: f.file.url }), /ENOENT/);
  await assert.rejects(prepareExpenseDelegation({ ...f, message: f.file.url.replace("upload.pdf", "%2E%2E%2Fsecret.pdf") }), /Invalid shared file reference/);
  await assert.rejects(prepareExpenseDelegation({ ...f, message: "_inbox/../../secret.pdf" }), /inside the agent workspace/);
  assert.equal((await prepareExpenseDelegation({ ...f, message: "https://example.test/document.pdf" })).images.length, 0);
  await assert.rejects(materializeAttachments(f.workspace, [{ name: "broken.pdf", data: "eA==" }], { complete: true }), /Could not read|Could not prepare/);
});

test("runManageTurn hands all pages to the model and files page receipts only in isolated PGlite", { skip: !poppler }, async t => {
  const f = await fixture(t);
  const pg = new PGlite();
  const db = pgliteAdapter(pg);
  t.after(() => pg.close());
  await migrate(db);
  const tenant = (await db.query("INSERT INTO di.tenant(name,is_default) VALUES ('Handoff test',true) RETURNING id")).rows[0].id;
  await seedTenant(db, tenant);
  const who = { id: "test-owner", username: "handoff-test", display_name: "Handoff Test", role: "admin" };
  await db.query("INSERT INTO di.company_member(tenant_id,name,user_id,department) VALUES ($1,'Handoff Test','test-owner','Test')", [tenant]);
  // Evaluate the production runner without starting a second HTTP server. Storage,
  // PDF preparation and filing are real; session persistence and the model are seams.
  const source = await readFile(new URL("./index.mjs", import.meta.url), "utf8");
  const runner = source.slice(source.indexOf("async function runManageTurn("), source.indexOf("\nfunction hostStatusNote"));
  assert.ok(runner.includes("delegatedImages"));
  let captured;
  const session = { id: "child", agentId: "di-expenses", parentSessionId: "parent", userId: "test-owner", engine: "pi" };
  const deps = {
    getSession: async id => id === "child" ? session : { id: "parent", agentId: "orchestrator", userId: "test-owner" },
    authenticateExpenseSession: async () => {}, logEvent: () => {}, insertMessage: async () => {},
    resolveAgentProfile: async () => ({ id: "di-expenses" }), ORCHESTRATOR_AGENT_ID: "orchestrator",
    prepareExpenseDelegation, expenseEvidenceModel, modelCatalog: [{ id: "test", available: true, vision: true }],
    getPool: () => ({ query: async () => ({ rows: [{ content: f.file.url }] }) }), updateSession: async () => session,
    agentWorkspace: agent => agent.id === "orchestrator" ? f.sourceWorkspace : f.workspace,
    path, DATA_DIR: f.dir, tenantOfSession: async () => "company-a", defaultModelId: "test",
    withAgentLock: async (_agent, fn) => fn(),
    chat: async (message, _model, _session, _event, images) => {
      captured = { message, images };
      const summaries = [];
      for (let page = 1; page <= 7; page++) {
        const receipt = message.match(new RegExp(`page ${page} of 7\\. Receipt attachment: (\\S+)`))[1];
        const result = await runTool({ db, tenantId: () => tenant, who, filesRoot: path.join(f.dir, "isolated-claim-files"), workspace: () => f.workspace,
          now: () => new Date("2026-10-02T04:00:00Z") }, { agent: "di-expenses", tool: "file_claim", args: {
          expense_date: "2026-10-01", merchant: `Synthetic page ${page}`, category: "transport", amount: page + 0.25,
          receipts: [receipt], allow_duplicate: true, description: `Isolated pipeline test page ${page}`,
        } });
        summaries.push({ page, receipt, claim: result.claim.number });
      }
      return { text: JSON.stringify(summaries), blocks: [] };
    },
    serializeTurn: turn => turn.text, filesFromBlocks: () => [], publicSession: s => s, scraplingPublic: async () => null,
  };
  const run = new Function(...Object.keys(deps), `${runner}; return runManageTurn;`)(...Object.values(deps));
  const result = await run({ message: "Summarise all pages of the uploaded receipts", sessionId: "child" });
  assert.equal(captured.images.length, 7);
  assert.equal(JSON.parse(result.reply).length, 7);
  const receipts = (await db.query("SELECT * FROM di.expense_receipt")).rows;
  assert.equal(receipts.length, 7);
  for (const receipt of receipts) {
    const shared = await readSharedFile({ root: path.join(f.dir, "isolated-claim-files"), companyId: tenant, ...sharedFileLocation(receipt.file_path) });
    assert.ok((await readFile(shared.full)).subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")));
  }
});
