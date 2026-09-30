import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = fileURLToPath(new URL("./web-search-mcp-server.mjs", import.meta.url));

/** Stand-in for the host's /api/internal/web-search. Records what the MCP server sends. */
const seen = [];
let host;
let hostUrl;

before(async () => {
  host = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      res.setHeader("Content-Type", "application/json");
      if (body.query === "boom") {
        res.statusCode = 502;
        return res.end(JSON.stringify({ ok: false, error: "All Jina tokens failed (#1: 402)" }));
      }
      if (body.query === "nothing") return res.end(JSON.stringify({ ok: true, query: "nothing", results: [] }));
      res.end(
        JSON.stringify({
          ok: true,
          query: body.query,
          results: [
            { title: "TNB tariff", url: "https://a.example/tariff", snippet: "27.03 sen/kWh" },
            { title: "", url: "https://b.example/", snippet: "", content: body.full ? "page text" : undefined },
          ],
        }),
      );
    });
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  hostUrl = `http://127.0.0.1:${host.address().port}`;
});

after(() => host.close());

async function withClient(env, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, ...env },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

const configured = () => ({ CLOUD_PI_SEARCH_URL: hostUrl, CLOUD_PI_SEARCH_TOKEN: "tok-123" });
const textOf = (result) => result.content.map((c) => c.text).join("\n");

test("exposes a single web_search tool with a usable schema", async () => {
  await withClient(configured(), async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["web_search"]);
    assert.deepEqual(tools[0].inputSchema.required, ["query"]);
    assert.deepEqual(Object.keys(tools[0].inputSchema.properties).sort(), ["full", "num", "query"]);
    assert.match(tools[0].description, /keyword/i);
  });
});

test("web_search calls the host with the bearer and renders a numbered result list", async () => {
  await withClient(configured(), async (client) => {
    const result = await client.callTool({ name: "web_search", arguments: { query: "tnb tariff", num: 2 } });
    assert.notEqual(result.isError, true);
    const text = textOf(result);
    assert.match(text, /^1\. TNB tariff\n {3}https:\/\/a\.example\/tariff\n {3}27\.03 sen\/kWh/);
    assert.match(text, /2\. https:\/\/b\.example\//);
  });
  const call = seen.at(-1);
  assert.equal(call.url, "/api/internal/web-search");
  assert.equal(call.auth, "Bearer tok-123");
  assert.equal(call.body.query, "tnb tariff");
  assert.equal(call.body.num, 2);
});

test("full mode is passed through and page text is included", async () => {
  await withClient(configured(), async (client) => {
    const result = await client.callTool({ name: "web_search", arguments: { query: "x", full: true } });
    assert.match(textOf(result), /page text/);
  });
  assert.equal(seen.at(-1).body.full, true);
});

test("an empty result set is a normal answer, not an error", async () => {
  await withClient(configured(), async (client) => {
    const result = await client.callTool({ name: "web_search", arguments: { query: "nothing" } });
    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /No results/);
  });
});

test("host failures come back as a tool error with the reason", async () => {
  await withClient(configured(), async (client) => {
    const result = await client.callTool({ name: "web_search", arguments: { query: "boom" } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /All Jina tokens failed/);
  });
});

test("without the host env it explains how to configure search instead of crashing", async () => {
  await withClient({ CLOUD_PI_SEARCH_URL: "", CLOUD_PI_SEARCH_TOKEN: "" }, async (client) => {
    const result = await client.callTool({ name: "web_search", arguments: { query: "x" } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Settings -> Keys/);
  });
});
