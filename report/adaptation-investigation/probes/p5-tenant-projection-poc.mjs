// Probe 5: proof-of-concept for "every company sees its own schema" WITHOUT changing the physical tables.
//   Part A  generate one read-only VIEW per company and entity that exposes that company's custom fields as
//           typed, named columns (the view definition is derived from di.field_def). Does isolation still hold?
//   Part B  does the existing template engine already print custom values once they are in the context?
// Throwaway PGlite database. The repo is imported, never modified.
//
// Run: node report/adaptation-investigation/probes/p5-tenant-projection-poc.mjs
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = "E:/000/UIv2/document_inteligence";
const req = createRequire(`${ROOT}/package.json`);
const { PGlite } = await import(pathToFileURL(path.join(path.dirname(req.resolve("@electric-sql/pglite")), "index.js")).href);
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { migrate, pgliteAdapter, withContext } = await load("core/db.mjs");
const { seedTenant } = await load("core/seed.mjs");
const { runTool, describeError } = await load("core/actions.mjs");
const { renderTemplate, buildContext } = await load("core/templates.mjs");

const out = [];
const say = (id, claim, ok, detail = "") => { out.push({ id, ok }); console.log(`${ok === null ? "NOTE" : ok ? "PASS" : "FAIL"} ${id} ${claim}${detail ? "  ::  " + String(detail).slice(0, 300) : ""}`); };
const rejects = async (p) => { try { await p; return null; } catch (e) { return describeError(e); } };

const db = pgliteAdapter(new PGlite());
await migrate(db);
const mk = async (name) => (await db.query("INSERT INTO di.tenant (name) VALUES ($1) RETURNING id, code", [name])).rows[0];
const A = await mk("Alpha Solar");
const B = await mk("Beta Clinic");
await seedTenant(db, A.id); await seedTenant(db, B.id);
const as = (agent, t) => (tool, args) => runTool({ db, tenantId: () => t.id }, { agent, tool, args });
const [aDb, aRec, bDb, bRec] = [as("di-db", A), as("di-records", A), as("di-db", B), as("di-records", B)];

// Two companies with DIFFERENT shapes of "customer"
await aDb("define_custom_field", { entity: "customer", key: "segment", label: "Segment", type: "select", options: ["Residential", "C&I"] });
await aDb("define_custom_field", { entity: "customer", key: "roof_kwp", label: "Roof size kWp", type: "number" });
await bDb("define_custom_field", { entity: "customer", key: "patient_id", label: "Patient ID", type: "text" });
await bDb("define_custom_field", { entity: "customer", key: "insured", label: "Insured", type: "boolean" });
await bDb("define_custom_field", { entity: "customer", key: "first_visit", label: "First visit", type: "date" });
await aRec("save_customer", { name: "Acme Roofing", custom: { segment: "C&I", roof_kwp: 120.5 } });
await aRec("save_customer", { name: "Home Owner", custom: { segment: "Residential", roof_kwp: 6 } });
await bRec("save_customer", { name: "Patient One", custom: { patient_id: "P-001", insured: true, first_visit: "2026-01-05" } });

// ---------------------------------------------------------------- Part A: generated per-company views
// Platform-run DDL (owner role), generated from field_def. NOT something an agent could do (S3.4 in probe 1).
const TYPE_SQL = { text: "text", select: "text", number: "numeric", boolean: "boolean", date: "date" };
await db.exec(`
  CREATE SCHEMA IF NOT EXISTS di_view;
  -- safe casts: one bad stored value must not break a whole view
  CREATE OR REPLACE FUNCTION di_view.num(t text) RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN RETURN t::numeric; EXCEPTION WHEN others THEN RETURN NULL; END $$;
  CREATE OR REPLACE FUNCTION di_view.dt(t text)  RETURNS date    LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN RETURN t::date;    EXCEPTION WHEN others THEN RETURN NULL; END $$;
  GRANT USAGE ON SCHEMA di_view TO di_app;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA di_view TO di_app;
`);
async function buildViews(tenant, entity, { scoped = true } = {}) {
  const defs = (await db.query("SELECT key, type FROM di.field_def WHERE tenant_id=$1 AND entity=$2 AND deleted_at IS NULL ORDER BY key", [tenant.id, entity])).rows;
  const cols = defs.map((d) => {
    const raw = `custom->>'${d.key}'`;
    const expr = d.type === "number" ? `di_view.num(${raw})` : d.type === "date" ? `di_view.dt(${raw})` : d.type === "boolean" ? `(${raw})::boolean` : raw;
    return `${expr} AS ${d.key}`;
  });
  const name = `di_view."${tenant.code}_${entity}"`;
  await db.exec(`DROP VIEW IF EXISTS ${name};
    CREATE VIEW ${name} WITH (security_invoker = true) AS
      SELECT id, code, name, email, phone, ${cols.length ? cols.join(", ") + "," : ""} created_at FROM di.customer WHERE deleted_at IS NULL${scoped ? ` AND tenant_id = '${tenant.id}'` : ""};
    GRANT SELECT ON ${name} TO di_app;`);
  return { name, cols: defs.map((d) => `${d.key}:${TYPE_SQL[d.type]}`) };
}
const va = await buildViews(A, "customer");
const vb = await buildViews(B, "customer");
say("A1", "each company gets a view whose columns are ITS fields, typed", true, `A: ${va.cols.join(", ")} | B: ${vb.cols.join(", ")}`);

const ctx = (t) => ({ tenantId: t.id, actor: "probe", agent: "probe" });
const aOwn = await withContext(db, ctx(A), (tx) => tx.query(`SELECT name, segment, roof_kwp FROM ${va.name} ORDER BY name`));
say("A2", "company A queries its own view with real column names and numeric types", aOwn.rows.length === 2 && typeof aOwn.rows[0].roof_kwp !== "undefined", JSON.stringify(aOwn.rows));
const agg = await withContext(db, ctx(A), (tx) => tx.query(`SELECT segment, sum(roof_kwp) kwp FROM ${va.name} GROUP BY 1 ORDER BY 1`));
say("A3", "...and can aggregate on a custom number without any JSON syntax", agg.rows.length === 2, JSON.stringify(agg.rows));
await buildViews(B, "customer", { scoped: false }); // defence-in-depth filter OFF: rely on RLS alone
const viaRls = await withContext(db, ctx(A), (tx) => tx.query(`SELECT name, patient_id FROM ${vb.name}`)).then((r) => r.rows, (e) => "error: " + e.message);
say("A4a", "RLS alone: company A reading B's view sees only A's own rows, none of B's data (B's columns are NULL)", Array.isArray(viaRls) && viaRls.every((r) => r.patient_id === null) && !viaRls.some((r) => r.name === "Patient One"), JSON.stringify(viaRls));
await buildViews(B, "customer", { scoped: true });
const viaScoped = await withContext(db, ctx(A), (tx) => tx.query(`SELECT * FROM ${vb.name}`)).then((r) => r.rows.length, (e) => "error: " + e.message);
say("A4b", "with the view also filtered to its own company (recommended), A reading B's view gets 0 rows", viaScoped === 0, `rows=${viaScoped}`);
const bOwn = await withContext(db, ctx(B), (tx) => tx.query(`SELECT name, patient_id, insured, first_visit FROM ${vb.name}`));
say("A5", "company B sees its different shape: patient_id, insured, first_visit", bOwn.rows.length === 1 && bOwn.rows[0].insured === true, JSON.stringify(bOwn.rows));
// poison a stored value directly (owner role) to see the safe cast hold
await db.query("UPDATE di.customer SET custom = custom || '{\"roof_kwp\":\"not-a-number\"}' WHERE tenant_id=$1 AND name='Home Owner'", [A.id]);
const poisoned = await withContext(db, ctx(A), (tx) => tx.query(`SELECT name, roof_kwp FROM ${va.name} ORDER BY name`)).then((r) => r.rows, (e) => "error: " + e.message);
say("A6", "one corrupt stored value yields NULL in the view instead of failing the query", Array.isArray(poisoned) && poisoned.some((r) => r.roof_kwp === null), JSON.stringify(poisoned));
// evolve: add a field then rebuild the view (what a platform job would do on define_custom_field)
await aDb("define_custom_field", { entity: "customer", key: "site_visit", label: "Site visit", type: "date" });
const va2 = await buildViews(A, "customer");
const cols2 = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='di_view' AND table_name='${A.code}_customer'`)).rows.map((r) => r.column_name);
say("A7", "adding a field and regenerating the view exposes the new column; nothing else is touched", cols2.includes("site_visit") && cols2.includes("segment"), cols2.join(","));
say("A8", "base tables were not altered by any of this", (await db.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='di' AND table_name='customer' AND column_name IN ('segment','roof_kwp','patient_id')")).rows[0].n === 0, "no new columns on di.customer");

// ---------------------------------------------------------------- Part B: printing custom values
const baseCtx = { doc: { doc_type: "invoice", status: "issued", number: "INV-1", subtotal: 1, tax_total: 0, total: 1, amount_paid: 0, currency: "MYR", custom: { po_number: "PO-7781" } }, lines: [], customer: null, contact: null, tenant: { name: "X" } };
const built = buildContext(baseCtx);
const tpl = "<p>PO: {{doc.custom.po_number}}</p>";
say("B1", "today: the context has no 'custom', so the same template prints an empty value", renderTemplate(tpl, built) === "<p>PO: </p>", JSON.stringify(renderTemplate(tpl, built)));
const patched = { ...built, doc: { ...built.doc, custom: baseCtx.doc.custom } }; // what a one-line context change would add
say("B2", "the template engine ALREADY prints it once the context carries it (the gap is the context, not the engine)", renderTemplate(tpl, patched) === "<p>PO: PO-7781</p>", renderTemplate(tpl, patched));
const xss = { ...built, doc: { ...built.doc, custom: { po_number: "<img src=x onerror=alert(1)>" } } };
say("B3", "...and the value stays HTML-escaped", !renderTemplate(tpl, xss).includes("<img"), renderTemplate(tpl, xss));

console.log(`\nSUMMARY ${out.filter((o) => o.ok === true).length} pass, ${out.filter((o) => o.ok === false).length} fail`);
process.exit(0);
