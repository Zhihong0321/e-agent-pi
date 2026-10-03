#!/usr/bin/env node
// Stdio MCP server shared by the four Document Intelligence micro-agents. Spawned
// per-session by Pi; which agent it serves comes from DI_AGENT in that agent's
// process env (server/agent-env.mjs -> document_inteligence/host.mjs diAgentEnv).
//
// It advertises only that agent's tools and forwards every call to the host with a
// per-agent token. The host re-checks the permission and runs the SQL as di_app, so
// this process never sees DATABASE_URL and can't widen its own access.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AGENTS, toolsFor } from "./core/tools.mjs";

const agent = process.env.DI_AGENT || "";
const url = (process.env.DI_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const token = process.env.DI_TOKEN || "";
const MAX_CHARS = 24000;

function reply(value) {
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n…(truncated; narrow the query)`;
  return { content: [{ type: "text", text }] };
}

function fail(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

async function callHost(tool, args) {
  if (!token) throw new Error("DI_TOKEN is missing; the host did not inject Document Intelligence credentials.");
  const res = await fetch(`${url}/api/internal/di`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`,
      'X-DI-Session': process.env.DI_SESSION_ID || '' },
    body: JSON.stringify({ agent, tool, args }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data.result;
}

const server = new McpServer({ name: "document-intelligence", version: "1.0.0" });

if (!AGENTS[agent]) {
  server.registerTool(
    "di_unavailable",
    { title: "Document Intelligence unavailable", description: "Explains why no Document Intelligence tools are loaded.", inputSchema: {} },
    async () => fail(`This session is not a Document Intelligence agent (DI_AGENT="${agent}").`),
  );
} else {
  for (const tool of toolsFor(agent)) {
    const expenseInput = { ...tool.input };
    delete expenseInput.identity;
    server.registerTool(
      tool.name,
      { title: tool.name.replace(/_/g, " "), description: tool.description,
        inputSchema: agent === 'di-expenses' ? expenseInput : tool.input },
      async (args) => {
        try {
          return reply(await callHost(tool.name, args));
        } catch (error) {
          return fail(error?.message || String(error));
        }
      },
    );
  }
}

await server.connect(new StdioServerTransport());
