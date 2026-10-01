#!/usr/bin/env node
// Local stdio MCP for approved email sends. The provider REST credential stays
// in the host; this process only calls the authenticated host proxy.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const agent = process.env.EE_MAIL_AGENT || "";
const url = (process.env.EE_MAIL_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const token = process.env.EE_MAIL_TOKEN || "";

function fail(error) {
  return { content: [{ type: "text", text: `Error: ${error?.message || String(error)}` }], isError: true };
}

async function callHost(args) {
  if (!token) throw new Error("EE_MAIL_TOKEN is missing; the host did not inject email credentials.");
  const res = await fetch(`${url}/api/internal/ee-mail`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ agent, ...args }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data.result;
}

const server = new McpServer({ name: "ee-mail", version: "1.0.0" });
server.registerTool(
  "send_email",
  {
    title: "Send email",
    description: "Send one user-authorized email through EE-Mail. An explicit send request specifying the recipient and exact content, or approval of a displayed draft, authorizes this call. Approval persists across turns for unchanged recipient/content; do not ask again or require a magic word. Call with confirm=true and report the actual result. The sender is provider-configured and cannot be chosen here.",
    inputSchema: {
      to: z.union([z.string(), z.array(z.string()).min(1).max(20)]).describe("One recipient email address or a list of up to 20 addresses"),
      subject: z.string().min(1).max(200),
      text: z.string().max(120000).optional().describe("Plain-text body; provide exactly one of text or html"),
      html: z.string().max(120000).optional().describe("HTML body; provide exactly one of text or html"),
      confirm: z.literal(true).describe("True when the user requested this exact send or approved the displayed draft, including in an earlier turn or handoff"),
    },
  },
  async (args) => {
    try {
      const result = await callHost(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
    } catch (error) {
      return fail(error);
    }
  },
);

await server.connect(new StdioServerTransport());
