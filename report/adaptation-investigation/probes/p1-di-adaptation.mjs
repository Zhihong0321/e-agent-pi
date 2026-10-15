// Probe 1: how Document Intelligence adapts one codebase to two (then three) companies.
// READ-ONLY with respect to the repo: it imports the real domain code and runs it on an
// in-process Postgres (PGlite) that is thrown away. Nothing in the repo is modified.
//
// Run:  node report/adaptation-investigation/probes/p1-di-adaptation.mjs
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT = "E:/000/UIv2/document_inteligence";
const req = createRequire(`${ROOT}/package.json`);
const pgliteDir = path.dirname(req.resolve("@electric-sql/pglite"));
const { PGlite } = await import(pathToFileURL(path.join(pgliteDir, "index.js")).href);
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { migrate, pgliteAdapter, withContext } = await load("core/db.mjs");
const { seedTenant, DEFAULT_SEQUENCES } = await load("core/seed.mjs");
const { runTool, describeError } = await load("core/actions.mjs");
const { DEFAULT_WORKFLOWS } = await load("core/workflows.mjs");

const results = [];
const say = (id, claim, ok, detail = "") => {
  results.push({ id, claim, ok, detail });
  console.log(`${ok === null ? "NOTE" : ok ? "PASS" : "FAIL"} ${id} ${claim}${detail ? "  ::  " + String(detail).slice(0, 400) : ""}`);
};
const rejects = async (promise) => {
  try { await promise; return null; } catch (e) { return describeError(e); }
};

const db = pgliteAdapter(new PGlite());
await migrate(db);
const mk = async (name) => (await db.query("INSERT INTO di.tenant (name) VALUES ($1) RETURNING id", [name])).rows[0].id;
const A = await mk("Alpha Solar");
const B = await mk("Beta Clinic");
const C = await mk("Gamma Trading");
for (const t of [A, B, C]) await seedTenant(db, t);

const dir = await mkdtemp(path.join(os.tmpdir(), "adapt-probe-"));
const pdfs = []; // { tenant, html }
const deps = (tenantId) => ({
  db, tenantId: () => tenantId, filesRoot: path.join(dir, "files"),
  workspace: (agent) => path.join(dir, tenantId, agent),
  renderPdf: async (html, abs) => { await mkdir(path.dirname(abs), { recursive: true }); await writeFile(abs, html); pdfs.push({ tenantId, abs, html }); },
});
const as = (agent, tenantId) => (tool, args) => runTool(deps(tenantId), { agent, tool, args });
const [aDb, aRec, aDoc, aTpl] = ["di-db", "di-records", "di-documents", "di-templates"].map((x) => as(x, A));
const [bDb, bRec, bDoc, bTpl] = ["di-db", "di-records", "di-documents", "di-templates"].map((x) => as(x, B));
const [cDb, cRec, cDoc, cTpl] = ["di-db", "di-records", "di-documents", "di-templates"].map((x) => as(x, C));

// ------------------------------------------------------------------ S1 same code, two companies
console.log("\n== S1 one codebase, two companies, different rules ==");
const addr = (city) => ({ line1: "1 Jalan Contoh", city, postcode: "50000", country: "x" });
await aDb("update_company_profile", { name: "Alpha Solar Sdn Bhd", address: addr("Kuala Lumpur"), currency: "MYR", country: "MY", tax_status: "registered" });
await bDb("update_company_profile", { name: "Beta Clinic Pte Ltd", address: addr("Singapore"), currency: "SGD", country: "SG", tax_status: "registered" });

for (const [rec, label] of [[aRec, "A"], [bRec, "B"]]) {
  // customer WITHOUT a billing address on purpose
  await rec("save_customer", { name: `Customer ${label} Ltd`, email: `buyer@cust${label.toLowerCase()}.example` });
  await rec("save_product", { sku: "SVC-1", name: "Service hour", unit: "hour", unit_price: 100, tax_code: label === "A" ? "SV8" : "NT" });
}

// B customises: PO number required at invoice issue, billing address downgraded to a warning, GST 9 tax code, own numbering.
await bDb("define_custom_field", { entity: "document", key: "po_number", label: "Customer PO no.", type: "text", required_for: "invoice.issue" });
const bInvoiceRules = DEFAULT_WORKFLOWS.invoice.issue.map((r) => (r.check === "customer_has_billing_address" ? { ...r, severity: "warn" } : r));
await bDb("set_workflow_rules", { doc_type: "invoice", rules: bInvoiceRules });
await bDb("save_tax_code", { code: "GST9", name: "GST 9%", rate: 9, kind: "none", is_default: true });
await bDb("set_numbering", { key: "invoice", prefix: "BC/", padding: 6, yearly_reset: false });

const mkInvoice = (doc, custCode, taxCode) => doc("create_draft", { doc_type: "invoice", customer: custCode, lines: [{ product: "SVC-1", quantity: 2, ...(taxCode ? { tax_code: taxCode } : {}) }], due_date: "2099-01-01" });
const aDraft = await mkInvoice(aDoc, "C-0001");
const bDraft = await mkInvoice(bDoc, "C-0001", "GST9");
const blockersOf = (d) => (d.document.readiness?.blockers ?? []).map((b) => b.check + (b.field ? `(${b.field})` : ""));
const warnsOf = (d) => (d.document.readiness?.warnings ?? []).map((b) => b.check);
say("S1.1", "tenant A (defaults): missing customer billing address BLOCKS issue", blockersOf(aDraft).includes("customer_has_billing_address"), blockersOf(aDraft).join(","));
say("S1.2", "tenant B (relaxed rule): same data does NOT block on billing address, it only warns", !blockersOf(bDraft).includes("customer_has_billing_address") && warnsOf(bDraft).includes("customer_has_billing_address"), `blockers=${blockersOf(bDraft)} warns=${warnsOf(bDraft)}`);
say("S1.3", "tenant B: custom field po_number is a blocking rule on its own invoices", blockersOf(bDraft).some((b) => b.startsWith("custom_field(document.po_number")), blockersOf(bDraft).join(","));
const bBlocked = await rejects(bDoc("issue_document", { document: bDraft.document.id }));
say("S1.4", "tenant B cannot issue until the PO number is filled", /Customer PO no/.test(bBlocked ?? ""), bBlocked);
await bDoc("update_draft", { document: bDraft.document.id, set: { custom: { po_number: "PO-7781" } } });
const bIssued = await bDoc("issue_document", { document: bDraft.document.id });
say("S1.5", "tenant B issues with ITS numbering format (BC/000001), tenant A keeps INV-yyyy-nnnn", bIssued.document.number === "BC/000001", `B=${bIssued.document.number}`);
await aRec("save_customer", { id: (await aRec("find_customers", { query: "Customer A" })).customers?.[0]?.id, billing_address: addr("KL") }).catch(() => {});
// simpler: set the address via update; if the helper above did not work, fix with a direct save by code
const aCust = (await aRec("find_customers", { query: "Customer A" }));
const aCustId = (aCust.customers ?? aCust.results ?? aCust.items ?? [])[0]?.id;
if (aCustId) await aRec("save_customer", { id: aCustId, billing_address: addr("Kuala Lumpur") });
const aIssued = await aDoc("issue_document", { document: aDraft.document.id }).catch((e) => ({ error: describeError(e) }));
say("S1.6", "tenant A issues once its address exists, with the default numbering", /^INV-\d{4}-0001$/.test(aIssued.document?.number ?? ""), aIssued.document?.number ?? aIssued.error);
say("S1.7", "tax codes are per tenant: B has GST9, A does not", (await bDb("describe_schema", {})).workflows !== undefined && (await bDb("list_tax_codes", {})).tax_codes?.some?.((t) => t.code === "GST9") && !(await aDb("list_tax_codes", {})).tax_codes?.some?.((t) => t.code === "GST9"), "");

// ------------------------------------------------------------------ S2 what reaches the printed document
console.log("\n== S2 do company-specific values reach the printed PDF? ==");
const bHtml = pdfs.filter((p) => p.tenantId === B).at(-1)?.html ?? "";
say("S2.1", "issued B invoice rendered with the default template contains the invoice number", bHtml.includes("BC/000001"), `html chars=${bHtml.length}`);
say("S2.2", "custom field value (PO-7781) appears on the default PDF", bHtml.includes("PO-7781"), bHtml.includes("PO-7781") ? "yes" : "NO: required by the rule, but not printed");
const probeTpl = await bTpl("save_template", { doc_type: "invoice", name: "With PO", html: "<h1>{{doc.number}}</h1><p>PO: {{doc.custom.po_number}}</p><p>Ref: {{doc.reference}}</p>", make_default: false });
say("S2.3", "Template Designer is warned that doc.custom.* is unknown (prints empty)", (probeTpl.unknown_fields ?? []).includes("doc.custom.po_number"), JSON.stringify(probeTpl.unknown_fields));
const tplVars = await bTpl("template_variables", {});
say("S2.4", "template_variables lists NO custom-field variable for documents", !JSON.stringify(tplVars.doc).includes("custom"), JSON.stringify(tplVars.doc).slice(0, 200));

// ------------------------------------------------------------------ S3 tenant isolation in the database
console.log("\n== S3 isolation ==");
const aSchema = await aDb("describe_schema", {});
say("S3.1", "tenant A's describe_schema does not show B's po_number field", !aSchema.custom_fields.some((f) => f.key === "po_number"), `A fields=${aSchema.custom_fields.map((f) => f.key)}`);
const aTax = await aDb("list_tax_codes", {});
const crossRead = await withContext(db, { tenantId: A, actor: "probe", agent: "probe" }, (tx) => tx.query("SELECT count(*)::int AS n FROM di.field_def WHERE tenant_id = $1", [B]));
say("S3.2", "as tenant A (role di_app), SELECT of B's field_def rows returns 0", crossRead.rows[0].n === 0, `n=${crossRead.rows[0].n}`);
const crossWrite = await rejects(withContext(db, { tenantId: A, actor: "probe", agent: "probe" }, (tx) => tx.query("INSERT INTO di.field_def (tenant_id, entity, key, label, type) VALUES ($1,'customer','evil','Evil','text')", [B])));
say("S3.3", "as tenant A, INSERT of a row owned by B is refused by row-level security", Boolean(crossWrite), crossWrite);
const ddl = await rejects(withContext(db, { tenantId: A, actor: "probe", agent: "probe" }, (tx) => tx.query("ALTER TABLE di.customer ADD COLUMN evil text")));
say("S3.4", "as an agent, DDL (ALTER TABLE) is refused", Boolean(ddl), ddl);
const del = await rejects(withContext(db, { tenantId: A, actor: "probe", agent: "probe" }, (tx) => tx.query("DELETE FROM di.field_def")));
say("S3.5", "as an agent, DELETE is refused", Boolean(del), del);

// ------------------------------------------------------------------ S4 bad or hostile configuration
console.log("\n== S4 what a company can do to itself (and only itself) ==");
const r1 = await rejects(cDb("set_workflow_rules", { doc_type: "invoice", rules: [{ check: "does_not_exist", severity: "block", message: "x" }] }));
say("S4.1", "unknown check name in a rule is rejected", /Unknown check/.test(r1 ?? ""), r1);
const r2 = await rejects(cDb("set_workflow_rules", { doc_type: "invoice", rules: DEFAULT_WORKFLOWS.invoice.issue.filter((r) => r.check !== "has_lines") }));
say("S4.2", "dropping the blocking has_lines rule is rejected (platform invariant)", /has_lines must stay/.test(r2 ?? ""), r2);
const r3 = await rejects(cDb("define_custom_field", { entity: "customer", key: "name", label: "x", type: "text" }));
say("S4.3", "a custom field cannot shadow a standard column", /standard column/.test(r3 ?? ""), r3);
await cDb("define_custom_field", { entity: "customer", key: "tier", label: "Tier", type: "text" });
const r4 = await rejects(cDb("define_custom_field", { entity: "customer", key: "tier", label: "Tier", type: "number" }));
say("S4.4", "changing a custom field's type later is rejected", /changing type/.test(r4 ?? ""), r4);
const r5 = await rejects(cDoc("create_draft", { doc_type: "delivery_order", customer: "C-0001", lines: [] }));
say("S4.5", "a company cannot invent a new document type (delivery_order) with data alone", /Invalid input/.test(r5 ?? ""), r5);
// self-inflicted lock: a rule that names a field nobody defined
await cRec("save_customer", { name: "Gamma Customer", email: "g@example.test", billing_address: addr("KL") });
await cRec("save_product", { sku: "G1", name: "Item", unit: "unit", unit_price: 10, tax_code: "NT" });
await cDb("update_company_profile", { name: "Gamma Trading", address: addr("KL") });
const ghost = [...DEFAULT_WORKFLOWS.invoice.issue, { check: "custom_field", arg: "document.ghost_field", severity: "block", message: "Ghost field required" }];
let ghostAccepted = true; let ghostErr = null;
try { await cDb("set_workflow_rules", { doc_type: "invoice", rules: ghost }); } catch (e) { ghostAccepted = false; ghostErr = describeError(e); }
say("S4.6", "a blocking rule that names an UNDEFINED custom field is accepted", ghostAccepted, ghostErr ?? "accepted without checking the field exists");
const cDraft = await cDoc("create_draft", { doc_type: "invoice", customer: "C-0001", lines: [{ product: "G1", quantity: 1 }], due_date: "2099-01-01" });
const cStuck = await rejects(cDoc("issue_document", { document: cDraft.document.id }));
say("S4.7", "...which makes every invoice of that company unissuable until a human fixes the rule", /Ghost field/.test(cStuck ?? ""), cStuck);
const cNoField = await rejects(cDoc("update_draft", { document: cDraft.document.id, set: { custom: { ghost_field: "x" } } }));
say("S4.8", "...and the agent cannot even fill it (field is not defined)", /Unknown custom field/.test(cNoField ?? ""), cNoField);
await cDb("set_workflow_rules", { doc_type: "invoice", rules: DEFAULT_WORKFLOWS.invoice.issue });
const cFixed = await cDoc("issue_document", { document: cDraft.document.id });
say("S4.9", "company C recovers by resubmitting the full rule list (blast radius = company C only)", Boolean(cFixed.document?.number), cFixed.document?.number);
// rule added after drafts exist
const cDraft2 = await cDoc("create_draft", { doc_type: "invoice", customer: "C-0001", lines: [{ product: "G1", quantity: 1 }], due_date: "2099-01-01" });
await cDb("define_custom_field", { entity: "document", key: "job_ref", label: "Job ref", type: "text", required_for: "invoice.issue" });
const afterRule = await cDoc("get_document", { ref: cDraft2.document.id });
say("S4.10", "a requirement added later immediately blocks drafts that were already in flight", (afterRule.document.readiness?.blockers ?? []).some((b) => /job_ref/.test(b.field ?? "")), blockersOf(afterRule).join(","));
const tagA = await aDb("describe_schema", {});
say("S4.11", "...and tenant A is untouched by C's rule changes", !tagA.custom_fields.some((f) => f.key === "job_ref"), "");

// ------------------------------------------------------------------ S5 platform evolution vs existing tenants
console.log("\n== S5 how platform changes reach companies that already exist ==");
// simulate a tenant created before the 'supplier' sequence existed: soft-delete that row
await db.query("UPDATE di.document_sequence SET deleted_at = now() WHERE tenant_id = $1 AND key = 'supplier'", [C]);
const adminWho = { id: "u-admin", username: "probe-admin", role: "admin", company_tenant_id: C };
const procErr = await rejects(runTool({ ...deps(C), who: adminWho }, { agent: "di-procurement", tool: "save_supplier", args: { name: "Supplier X Sdn Bhd" } }));
say("S5.1", "a tenant that lacks a newer default sequence fails with 'No numbering sequence' (nothing creates it lazily)", /No numbering sequence for "supplier"/.test(procErr ?? ""), procErr);
// seedTenant never overwrites what the tenant has, and never adds changed defaults to existing rules
const before = (await db.query("SELECT rules FROM di.workflow_def WHERE tenant_id=$1 AND doc_type='invoice'", [B])).rows[0].rules;
await seedTenant(db, B);
const after = (await db.query("SELECT rules FROM di.workflow_def WHERE tenant_id=$1 AND doc_type='invoice'", [B])).rows[0].rules;
say("S5.2", "re-running the seed keeps B's customised rules (customisation is safe from the seed)", JSON.stringify(before) === JSON.stringify(after), "");
// simulate a product improvement to the default invoice rules: add a rule to the default list in memory only
const improved = [...DEFAULT_WORKFLOWS.invoice.issue, { check: "customer_has_email", severity: "warn", message: "NEW DEFAULT" }];
say("S5.3", "ILLUSTRATION (not a test): a changed default cannot reach rows that already exist, because the seed is ON CONFLICT DO NOTHING and runs only at company creation/reset", null, `A's stored invoice rules: ${(await db.query("SELECT jsonb_array_length(rules) AS n FROM di.workflow_def WHERE tenant_id=$1 AND doc_type='invoice'", [A])).rows[0].n} vs improved default ${improved.length} (not applied; code evidence: graft callers seedTenantTx = createCompany, resetCompany)`);

// ------------------------------------------------------------------ S6 audit and reversibility
console.log("\n== S6 audit and undo ==");
const audit = await bDb("read_audit_log", { entity: "workflow_def", limit: 5 });
const row = (audit.entries ?? []).find((e) => e.changed?.rules);
say("S6.1", "DB Manager changes are in the audit log with actor/agent and the field-level from/to", Boolean(row?.agent === "di-db" && row.changed.rules.from && row.changed.rules.to), row ? JSON.stringify({ agent: row.agent, action: row.action, changedKeys: Object.keys(row.changed) }) : "no entry with changed.rules");
const { TOOLS } = await load("core/tools.mjs");
const dbTools = Object.entries(TOOLS).filter(([, t]) => t.agents.includes("di-db")).map(([n]) => n);
const undoCapable = dbTools.filter((n) => /revert|undo|rollback|history/.test(n));
say("S6.2", "DB Manager has no revert/undo tool for rule, field, numbering or tax changes (restore_record only restores archived records); fde_revert exists only for the FDE", undoCapable.length === 0 && dbTools.includes("restore_record"), "di-db tools: " + dbTools.join(", "));

// ------------------------------------------------------------------ S7 issued documents are pinned
console.log("\n== S7 a later template change does not alter an issued document ==");
const renderOf = async () => { const out = await bDoc("render_pdf", { document: bIssued.document.id }); return pdfs.filter((p) => p.tenantId === B).at(-1).html; };
const first = await renderOf();
await bTpl("save_template", { doc_type: "invoice", name: "Standard invoice", html: "<h1>NEW LOOK {{doc.number}}</h1>", make_default: true });
const second = await renderOf();
say("S7.1", "after B publishes a new default template, the already-issued invoice still renders with the old one", first === second && !second.includes("NEW LOOK"), `same=${first === second}`);
const newDraft = await mkInvoice(bDoc, "C-0001", "GST9");
await bDoc("update_draft", { document: newDraft.document.id, set: { custom: { po_number: "PO-2" } } });
const newIssued = await bDoc("issue_document", { document: newDraft.document.id });
const newHtml = pdfs.filter((p) => p.tenantId === B).at(-1).html;
say("S7.2", "...while the next invoice uses the new template", newHtml.includes("NEW LOOK"), newIssued.document.number);

// ------------------------------------------------------------------ S8 template safety
console.log("\n== S8 what a template may contain ==");
const evil = '<html><body><script>document.title="JS-RAN"</script><img src="http://169.254.169.254/latest/meta-data/"><iframe src="file:///etc/passwd"></iframe>{{doc.number}}</body></html>';
const saved = await bTpl("save_template", { doc_type: "quotation", name: "Active content", html: evil, make_default: false }).catch((e) => ({ error: describeError(e) }));
say("S8.1", "a template containing <script>, an external <img> and an <iframe file:> is ACCEPTED by save_template", Boolean(saved.template), saved.error ?? `saved as ${saved.template?.name} v${saved.template?.version}`);
const big = "<p>" + "x".repeat(3_000_000) + "{{doc.number}}</p>";
const savedBig = await bTpl("save_template", { doc_type: "quotation", name: "Huge", html: big, make_default: false }).catch((e) => ({ error: describeError(e) }));
say("S8.2", "a 3 MB template is accepted (no size cap)", Boolean(savedBig.template), savedBig.error ?? "accepted");
const xssName = "<script>alert(1)</script> Co";
await bRec("save_customer", { name: xssName, email: "x@y.test" });
const xssList = await bRec("find_customers", { query: "alert(1)" });
const xssCode = (xssList.customers ?? xssList.results ?? xssList.items ?? [])[0]?.code;
const xssDraft = await bDoc("create_draft", { doc_type: "quotation", customer: xssCode, lines: [{ description: "<b>bold</b>", quantity: 1, unit_price: 5 }], valid_until: "2099-01-01" });
await bDoc("render_pdf", { document: xssDraft.document.id });
const xssHtml = pdfs.filter((p) => p.tenantId === B).at(-1)?.html ?? "";
say("S8.3", "data values (customer name, line text) are HTML-escaped by the renderer", xssCode && xssHtml.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && !xssHtml.includes("<script>alert(1)</script>"), "customer=" + xssCode);

// ------------------------------------------------------------------ S9 who may change company rules
console.log("\n== S9 authority ==");
const plainUser = { id: "u-plain", username: "probe-user", role: "user", company_tenant_id: B };
const plainDefine = await rejects(runTool({ ...deps(B), who: plainUser }, { agent: "di-db", tool: "define_custom_field", args: { entity: "customer", key: "by_plain_user", label: "By plain user", type: "text" } }));
say("S9.1", "domain layer: a NON-admin user can define a custom field through DB Manager (no role check; only agent assignment gates it)", plainDefine === null, plainDefine ?? "accepted");
const plainRules = await rejects(runTool({ ...deps(B), who: plainUser }, { agent: "di-db", tool: "set_workflow_rules", args: { doc_type: "quotation", rules: DEFAULT_WORKFLOWS.quotation.issue } }));
say("S9.2", "domain layer: a NON-admin user can replace issue rules through DB Manager", plainRules === null, plainRules ?? "accepted");
const plainNumber = await rejects(runTool({ ...deps(B), who: plainUser }, { agent: "di-db", tool: "set_numbering", args: { key: "quotation", prefix: "ZZ-" } }));
say("S9.3", "domain layer: a NON-admin user can change numbering through DB Manager", plainNumber === null, plainNumber ?? "accepted");
const fdeBad = await rejects(runTool({ ...deps(B), who: adminWho2(B) }, { agent: "di-fde", tool: "fde_apply", args: { changeset: { target_agent: "di-documents", summary: "quotation validity 14 days", sop: { markdown: "Quotations are valid 14 days." } } } }));
say("S9.4", "FDE cannot target the Document Agent: fde_apply accepts di-expenses only", /target_agent/.test(fdeBad ?? "") && /di-expenses/.test(fdeBad ?? ""), fdeBad);
function adminWho2(t) { return { id: "u-admin2", username: "probe-admin2", role: "admin", company_tenant_id: t }; }

// ------------------------------------------------------------------ summary
const pass = results.filter((r) => r.ok === true).length;
const fail = results.filter((r) => r.ok === false).length;
console.log(`\nSUMMARY ${pass} pass, ${fail} fail, ${results.length - pass - fail} note`);
await writeFile(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "p1-results.json"), JSON.stringify(results, null, 2));
await writeFile(path.join(dir, "evil-template.html"), evil);
console.log("evil template stored at", path.join(dir, "evil-template.html"));
process.exit(0);
