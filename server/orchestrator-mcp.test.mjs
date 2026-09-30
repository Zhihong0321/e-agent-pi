import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { capabilityCard } from "./orchestrator.mjs";

test("real stdio MCP returns a readable compact roster and forwards synchronous dispatch", async () => {
  const seen = [];
  const host = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    seen.push(body);
    const result = body.action === "list_specialists"
      ? { specialists: [capabilityCard({
        id: "scraper", slug: "web-scraper", name: "Web Scraper",
        headline: "Inspects websites", description: "Finds logos and company facts",
        skills: [{ name: "scrapling", description: "x".repeat(30000) }],
        mcp: [{ name: "Scrapling", description: "x".repeat(30000) }],
      })] }
      : { ok: true, status: "done", task: { result: "Logo URL found" } };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, result: JSON.stringify(result) }));
  });
  await new Promise(resolve => host.listen(0, "127.0.0.1", resolve));
  const client = new Client({ name: "orchestrator-local-test", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("./orchestrator-mcp-server.mjs", import.meta.url))],
      env: { ...process.env, ORCHESTRATOR_DISPATCH_TOKEN: "local-test",
        ORCHESTRATOR_DISPATCH_URL: `http://127.0.0.1:${host.address().port}` },
    }));
    const roster = await client.callTool({ name: "list_specialists", arguments: {} });
    assert.notEqual(roster.isError, true);
    assert.ok(Buffer.byteLength(JSON.stringify(roster)) < 16 * 1024);
    const data = JSON.parse(roster.content[0].text);
    assert.equal(data.specialists[0].slug, "web-scraper");
    assert.equal(data.specialists[0].mcp[0].name, "Scrapling");
    const result = await client.callTool({ name: "dispatch_task", arguments: { taskId: "t1" } });
    assert.equal(JSON.parse(result.content[0].text).status, "done");
    assert.deepEqual(seen, [{ action: "list_specialists" }, { action: "dispatch_task", taskId: "t1" }]);
  } finally {
    await client.close();
    await new Promise(resolve => host.close(resolve));
  }
});
