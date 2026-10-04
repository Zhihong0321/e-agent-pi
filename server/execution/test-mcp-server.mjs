#!/usr/bin/env node
// Local test MCP server for the external-transport acceptance tests.
// Deliberately small: one echo, one isError tool, one slow tool.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "execution-test-external", version: "1.0.0" });

server.registerTool("echo", {
  description: "Echo the message back with a structured note.",
  inputSchema: { message: z.string() },
}, async ({ message }) => ({
  content: [{ type: "text", text: `echo: ${message}` }],
  structuredContent: { text: `echo: ${message}`, note: "structured value" },
}));

server.registerTool("fail_tool", {
  description: "Always reports a tool-level error (isError).",
  inputSchema: {},
}, async () => ({
  content: [{ type: "text", text: "simulated external failure" }],
  isError: true,
}));

server.registerTool("slow_tool", {
  description: "Sleeps longer than any test timeout.",
  inputSchema: {},
}, async () => {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  return { content: [{ type: "text", text: "finally done" }] };
});

await server.connect(new StdioServerTransport());
