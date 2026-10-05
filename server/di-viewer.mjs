import { readFile } from "node:fs/promises";
import { dbReady, getPool } from "./db.mjs";
import { hasApiAuth } from "./auth.mjs";

// A subquery plus the extended protocol prevents transaction control or stacked SQL.
// Postgres, rather than a SQL keyword blacklist, enforces read-only execution.
export async function viewerQuery(pool, sql, params = []) {
  if (typeof sql !== "string" || !sql.trim() || sql.length > 100000 || !Array.isArray(params)) {
    throw new Error("Provide a SELECT query (maximum 100,000 characters) and a params array.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL search_path = di, pg_catalog");
    const result = await client.query({
      text: `SELECT * FROM (\n${sql.trim().replace(/;\s*$/, "")}\n) AS viewer_result LIMIT 1001`,
      values: params,
      queryMode: "extended",
    });
    return { rows: result.rows.slice(0, 1000), fields: result.fields, command: "SELECT", rowCount: Math.min(result.rows.length, 1000), truncated: result.rows.length > 1000 };
  } finally {
    try { await client.query("ROLLBACK"); } finally { client.release(true); }
  }
}

export async function handleDiViewer(req, res, url) {
  const route = url.pathname.slice("/db-viewer".length);
  const json = (status, value) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(value));
  };
  if (!hasApiAuth(req)) {
    if (!route.startsWith("/api/") && req.method === "GET") {
      res.writeHead(302, { Location: "/admin", "Cache-Control": "no-store" });
      res.end();
    } else json(401, { error: "Unlock Settings, then open Database viewer." });
    return;
  }
  try {
    if (route.startsWith("/api/")) {
      if (!dbReady()) return json(503, { error: "Database is not connected" });
      if (route === "/api/config" && req.method === "GET") {
        const result = await viewerQuery(getPool(), "SELECT current_database() AS name");
        return json(200, { dbName: `${result.rows[0].name} · di`, access: "read-only", expiresAt: null });
      }
      if (route === "/api/health" && req.method === "GET") {
        await viewerQuery(getPool(), "SELECT 1");
        return json(200, { ok: true });
      }
      if (route === "/api/sql" && req.method === "POST") {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk.toString();
          if (Buffer.byteLength(raw) > 200000) return json(413, { error: "Query request too large" });
        }
        const body = JSON.parse(raw || "{}");
        return json(200, await viewerQuery(getPool(), body.sql, body.params ?? []));
      }
      return json(404, { error: "Unknown viewer API" });
    }
    if (req.method !== "GET") return json(405, { error: "Method not allowed" });
    if (!route) {
      res.writeHead(302, { Location: "/db-viewer/" });
      return res.end();
    }
    const assets = { "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/styles.css": ["styles.css", "text/css"] };
    const asset = assets[route];
    if (!asset) return json(404, { error: "Not found" });
    const data = await readFile(new URL(`./di-viewer/${asset[0]}`, import.meta.url));
    res.writeHead(200, { "Content-Type": `${asset[1]}; charset=utf-8`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(data);
  } catch (error) {
    json(400, { error: String(error.message || "Viewer query failed").slice(0, 500) });
  }
}
