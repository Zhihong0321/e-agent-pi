import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EE_MAIL_DISPATCH_TOKEN } from "./ee-mail.mjs";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "ee-mail-mcp-server.mjs");

test("ee-mail MCP is a separate send tool with host authorization", async () => {
  let body;
  const host = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    body = JSON.parse(raw || "{}");
    const authorized = req.headers.authorization === `Bearer ${EE_MAIL_DISPATCH_TOKEN}` && ["di-documents", "orchestrator"].includes(body.agent);
    res.setHeader("Content-Type", "application/json");
    if (!authorized) return res.writeHead(401).end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    res.end(JSON.stringify({ ok: true, result: { sent: true, provider: { messageId: "test-1" } } }));
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${host.address().port}`;
  const connect = async (token = EE_MAIL_DISPATCH_TOKEN, agent = "di-documents") => {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { ...process.env, EE_MAIL_AGENT: agent, EE_MAIL_URL: url, EE_MAIL_TOKEN: token },
    }));
    return client;
  };
  try {
    for (const agent of ["di-documents", "orchestrator"]) {
      const client = await connect(EE_MAIL_DISPATCH_TOKEN, agent);
      try {
        const tools = await client.listTools();
        assert.deepEqual(tools.tools.map((tool) => tool.name), ["send_email"]);
        const sent = await client.callTool({ name: "send_email", arguments: {
          to: "a@example.com", subject: "Hello", text: "Hello",
        } });
        assert.equal(sent.isError, undefined);
        assert.equal(body.agent, agent);
      } finally {
        await client.close();
      }
    }

    const forged = await connect("wrong-token");
    const denied = await forged.callTool({ name: "send_email", arguments: {
      to: "a@example.com", subject: "No", text: "Should fail",
    } });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /Unauthorized/);
    await forged.close();
  } finally {
    host.close();
  }
});
