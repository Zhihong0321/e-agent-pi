// Protocol-level test: spawns the real MCP server as each agent would, against a tiny
// HTTP host that authenticates the per-agent token and runs tools on PGlite.
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { migrate, pgliteAdapter } from "../core/db.mjs";
import { ensureDefaultTenant, seedTenant } from "../core/seed.mjs";
import { runTool, describeError } from "../core/actions.mjs";
import { diTokenFor } from "../host.mjs";
import { toolsFor } from "../core/tools.mjs";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mcp-server.mjs");

test("MCP server exposes per-agent tools and round-trips through the host", async () => {
  const db = pgliteAdapter(new PGlite());
  await migrate(db);
  const tenantId = await ensureDefaultTenant(db);
  await seedTenant(db, tenantId);

  const host = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    const ok = req.headers.authorization === `Bearer ${diTokenFor(body.agent)}`;
    res.setHeader("Content-Type", "application/json");
    if (!ok) return res.writeHead(401).end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    try {
      const result = await runTool({ db, tenantId: () => tenantId }, body);
      res.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      res.writeHead(400).end(JSON.stringify({ ok: false, error: describeError(error) }));
    }
  });
  await new Promise((r) => host.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${host.address().port}`;

  const connect = async (agent, token = diTokenFor(agent)) => {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [SERVER],
        env: { ...process.env, DI_AGENT: agent, DI_TOKEN: token, DI_URL: url },
      }),
    );
    return client;
  };

  try {
    const clerk = await connect("di-records");
    const names = (await clerk.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, toolsFor("di-records").map((t) => t.name).sort());
    assert.ok(!names.includes("define_custom_field"));

    const saved = await clerk.callTool({
      name: "save_name_card",
      arguments: { card: { person_name: "Aisyah", company_name: "Kedai Maju Enterprise", mobile: "019-888 1234" } },
    });
    assert.equal(saved.isError, undefined);
    assert.match(saved.content[0].text, /C-0001/);

    const bad = await clerk.callTool({ name: "save_product", arguments: { name: "x" } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /unit_price/);
    await clerk.close();

    // a leaked token for one agent can't be replayed as another
    const forged = await connect("di-db", diTokenFor("di-records"));
    const denied = await forged.callTool({ name: "describe_schema", arguments: {} });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /Unauthorized/);
    await forged.close();

    for (const agent of ["di-forms", "di-intake", "di-expenses"]) {
      const client = await connect(agent);
      assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), toolsFor(agent).map((t) => t.name).sort());
      await client.close();
    }

    // the clerk acts for a signed-in user: over MCP, with no identity attached, it refuses
    const expenses = await connect("di-expenses");
    const unsigned = await expenses.callTool({ name: "list_claims", arguments: {} });
    assert.equal(unsigned.isError, true);
    assert.match(unsigned.content[0].text, /Sign-in required/);
    await expenses.close();

    const nobody = await connect("website");
    assert.deepEqual((await nobody.listTools()).tools.map((t) => t.name), ["di_unavailable"]);
    await nobody.close();
  } finally {
    host.close();
  }
});
