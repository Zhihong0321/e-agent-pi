// Probe 4: is a JSONB "bag" column slower than "anything columns" (typed slot columns c1..cN)?
// Throwaway in-process Postgres (PGlite). Relative numbers only: PGlite is Postgres compiled to WASM, not the
// production server, so absolute milliseconds are NOT production numbers. Nothing in the repo is touched.
//
// Run: node report/adaptation-investigation/probes/p4-flex-storage-benchmark.mjs
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const req = createRequire("E:/000/UIv2/document_inteligence/package.json");
const { PGlite } = await import(pathToFileURL(path.join(path.dirname(req.resolve("@electric-sql/pglite")), "index.js")).href);
const db = new PGlite();
console.log("server:", (await db.query("select version() v")).rows[0].v.slice(0, 40));

const TENANTS = 4, PER = 50_000; // 200k rows total, like four mid-size companies on one platform
const SEG = ["Residential", "C&I", "Government", "Retail", "Education", "Health", "Utility", "Other"];
await db.exec(`
  CREATE TABLE bag  (tenant_id int NOT NULL, id int NOT NULL, name text, custom jsonb NOT NULL DEFAULT '{}');
  CREATE TABLE slot (tenant_id int NOT NULL, id int NOT NULL, name text, t1 text, n1 numeric, d1 date);
`);
for (let t = 1; t <= TENANTS; t++) {
  await db.exec(`
    INSERT INTO bag SELECT ${t}, g, 'cust '||g,
      jsonb_build_object('segment', (ARRAY['${SEG.join("','")}'])[1 + (g % 8)], 'score', (g * 7919) % 1000, 'since', (date '2020-01-01' + (g % 1500)))
      FROM generate_series(1, ${PER}) g;
    INSERT INTO slot SELECT ${t}, g, 'cust '||g,
      (ARRAY['${SEG.join("','")}'])[1 + (g % 8)], (g * 7919) % 1000, (date '2020-01-01' + (g % 1500))
      FROM generate_series(1, ${PER}) g;
  `);
}
await db.exec("CREATE INDEX bag_t ON bag(tenant_id, id); CREATE INDEX slot_t ON slot(tenant_id, id); ANALYZE bag; ANALYZE slot;");

const ms = async (sql) => {
  const times = [];
  let plan = "";
  for (let i = 0; i < 5; i++) {
    const r = await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`);
    const j = r.rows[0]["QUERY PLAN"][0];
    times.push(j["Execution Time"]);
    plan = JSON.stringify(j.Plan).match(/"Node Type":"([^"]+)"/)?.[1] + (JSON.stringify(j.Plan).match(/"Index Name":"([^"]+)"/)?.[1] ? ` (${JSON.stringify(j.Plan).match(/"Index Name":"([^"]+)"/)[1]})` : "");
  }
  times.sort((a, b) => a - b);
  return { ms: times[2].toFixed(2), plan };
};
const size = async (rel) => (await db.query(`select pg_size_pretty(pg_total_relation_size('${rel}')) s`)).rows[0].s;

const Q = {
  "Q1 equality  (segment = 'C&I')": {
    bag: `SELECT count(*) FROM bag WHERE tenant_id=2 AND custom->>'segment'='C&I'`,
    bagGin: `SELECT count(*) FROM bag WHERE tenant_id=2 AND custom @> '{"segment":"C&I"}'`,
    slot: `SELECT count(*) FROM slot WHERE tenant_id=2 AND t1='C&I'`,
  },
  "Q2 range     (score 990..999)": {
    bag: `SELECT count(*) FROM bag WHERE tenant_id=2 AND (custom->>'score')::numeric BETWEEN 990 AND 999`,
    slot: `SELECT count(*) FROM slot WHERE tenant_id=2 AND n1 BETWEEN 990 AND 999`,
  },
  "Q3 aggregate (sum score by segment)": {
    bag: `SELECT custom->>'segment' s, sum((custom->>'score')::numeric) FROM bag WHERE tenant_id=2 GROUP BY 1`,
    slot: `SELECT t1, sum(n1) FROM slot WHERE tenant_id=2 GROUP BY 1`,
  },
};

const rows = [];
const run = async (stage, labelSuffix = "") => {
  for (const [q, v] of Object.entries(Q)) {
    const b = await ms(v.bag);
    const s = await ms(v.slot);
    const g = v.bagGin ? await ms(v.bagGin) : null;
    rows.push({ stage, query: q, bag: `${b.ms} ms  ${b.plan}`, ...(g ? { bagGIN: `${g.ms} ms  ${g.plan}` } : {}), slot: `${s.ms} ms  ${s.plan}` });
  }
};

await run("A: no extra index (only tenant_id,id)");
console.log("sizes before extra indexes: bag", await size("bag"), "| slot", await size("slot"));

await db.exec(`CREATE INDEX bag_gin ON bag USING gin (custom jsonb_path_ops);`);
await run("B: + GIN(custom) on the bag");
await db.exec(`DROP INDEX bag_gin;`);

// per-company PARTIAL expression indexes on the bag (what a platform-run 'promote hot field' step would create)
await db.exec(`
  CREATE INDEX bag_seg_t2   ON bag ((custom->>'segment'))              WHERE tenant_id = 2;
  CREATE INDEX bag_score_t2 ON bag (((custom->>'score')::numeric))     WHERE tenant_id = 2;
  CREATE INDEX slot_t1_idx  ON slot(tenant_id, t1);
  CREATE INDEX slot_n1_idx  ON slot(tenant_id, n1);
  ANALYZE bag; ANALYZE slot;
`);
await run("C: bag + partial expression indexes for tenant 2 | slot + btree on its columns");
console.log("sizes after indexes: bag", await size("bag"), "| slot", await size("slot"));

console.log("\n=== results (median of 5, tenant 2 = 50,000 rows of 200,000) ===");
for (const r of rows) console.log(JSON.stringify(r));

// Waste: how wide must the slot table be to serve "any company"?
console.log("\nslot-table width if each company may need 20 text + 20 number + 10 date + 10 bool flex columns: 60 columns per row, mostly NULL for every company that uses 5.");
process.exit(0);
