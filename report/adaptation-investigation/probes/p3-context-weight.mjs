// Probe 3: how much text the company-adaptation tools hand to a model on every call.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
const ROOT = "E:/000/UIv2/document_inteligence";
const req = createRequire(`${ROOT}/package.json`);
const { PGlite } = await import(pathToFileURL(path.join(path.dirname(req.resolve("@electric-sql/pglite")), "index.js")).href);
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { migrate, pgliteAdapter } = await load("core/db.mjs");
const { seedTenant } = await load("core/seed.mjs");
const { runTool } = await load("core/actions.mjs");
const db = pgliteAdapter(new PGlite());
await migrate(db);
const t = (await db.query("INSERT INTO di.tenant (name) VALUES ('W') RETURNING id")).rows[0].id;
await seedTenant(db, t);
const call = (agent, tool, args = {}) => runTool({ db, tenantId: () => t }, { agent, tool, args });
const size = (x) => JSON.stringify(x).length;
const s = await call("di-db", "describe_schema");
console.log("describe_schema (whole)       chars:", size(s), "~tokens:", Math.round(size(s) / 4));
console.log("  of which standard_columns   chars:", size(s.standard_columns));
console.log("  of which workflows          chars:", size(s.workflows));
const s2 = await call("di-db", "describe_schema", { entity: "document" });
console.log("describe_schema(entity=doc)   chars:", size(s2));
const v = await call("di-templates", "template_variables");
console.log("template_variables            chars:", size(v));
const tpl = await call("di-templates", "list_templates", {});
console.log("list_templates                chars:", size(tpl));
const fs = await import("node:fs/promises");
for (const id of ["di-db", "di-documents", "di-templates", "di-onboarding", "di-fde", "di-forms", "orchestrator"]) {
  const txt = (await fs.readFile(`E:/000/UIv2/agent/roles/${id}.md`, "utf8")).replaceAll("\r\n", "\n");
  console.log(`role ${id.padEnd(14)} chars: ${txt.length}`);
}
const { TOOLS } = await load("core/tools.mjs");
const toolsPer = {};
for (const [n, d] of Object.entries(TOOLS)) for (const a of d.agents) (toolsPer[a] ??= []).push(n);
console.log("tools per agent:", Object.fromEntries(Object.entries(toolsPer).map(([a, l]) => [a, l.length])));
process.exit(0);
