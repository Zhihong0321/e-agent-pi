#!/usr/bin/env node
// Stdio MCP for the shared persistent Chromium profile. Chromium itself lives
// in the host process (server/browser-session.mjs); this process only calls
// /api/browser/act so two agents cannot launch a second browser on the same
// user-data dir.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = process.env.BROWSER_API?.trim() || "http://127.0.0.1:8080";
const TOKEN = process.env.BROWSER_MCP_TOKEN?.trim() || "";

async function act(op, extra = {}) {
  const res = await fetch(`${BASE}/api/browser/act`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ op, ...extra }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `browser ${op} failed (${res.status})`);
  return data;
}

function reply(data) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(error) {
  return { content: [{ type: "text", text: `Error: ${error?.message || error}` }], isError: true };
}

const server = new McpServer({ name: "browser", version: "1.0.0" });

server.registerTool(
  "browser_tabs",
  {
    title: "List browser tabs",
    description: "List tabs in the shared persistent browser (Google and other signed-in sessions live here).",
    inputSchema: {},
  },
  async () => {
    try {
      return reply(await act("tabs"));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "browser_navigate",
  {
    title: "Open a URL",
    description: "Navigate the current tab. Cookies/localStorage persist on the host volume — do not log out of Google.",
    inputSchema: { url: z.string().describe("Absolute http(s) URL") },
  },
  async ({ url }) => {
    try {
      return reply(await act("navigate", { url }));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "browser_snapshot",
  {
    title: "Page snapshot",
    description: "Accessibility tree of the current page with refs for browser_click / browser_type.",
    inputSchema: {},
  },
  async () => {
    try {
      return reply(await act("snapshot"));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "browser_click",
  {
    title: "Click",
    description: "Click a snapshot ref from browser_snapshot.",
    inputSchema: { ref: z.string().describe("aria-ref from the last snapshot, e.g. e12") },
  },
  async ({ ref }) => {
    try {
      return reply(await act("click", { ref }));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "browser_type",
  {
    title: "Type text",
    description: "Type into the focused field, or click a snapshot ref first. Never type passwords the owner has not given.",
    inputSchema: {
      text: z.string(),
      ref: z.string().optional().describe("Optional snapshot ref to focus first"),
      submit: z.boolean().optional().describe("Press Enter after typing"),
    },
  },
  async (args) => {
    try {
      return reply(await act("type", args));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "browser_screenshot",
  {
    title: "Screenshot",
    description: "JPEG of the current tab. Use for captchas or to show the owner proof. Prefer browser_snapshot for driving the page.",
    inputSchema: {},
  },
  async () => {
    try {
      const data = await act("screenshot");
      if (data.image) {
        return {
          content: [
            { type: "text", text: `url: ${data.url}` },
            { type: "image", data: data.image, mimeType: "image/jpeg" },
          ],
        };
      }
      return reply(data);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "browser_auth_status",
  {
    title: "Auth status",
    description:
      "Whether the shared profile looks signed in (Google cookies, or cookies for origin). If signed out, tell the owner to open /signin and complete login. Do not try to fill Google passwords yourself.",
    inputSchema: {
      origin: z.string().optional().describe("Origin to probe, e.g. https://accounts.google.com"),
      slug: z.string().optional().describe("Sign-in slug, e.g. google"),
    },
  },
  async (args) => {
    try {
      return reply(await act("auth_status", args));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "browser_wait",
  {
    title: "Wait",
    description: "Pause or wait until the URL contains a substring.",
    inputSchema: {
      timeoutMs: z.number().optional(),
      urlIncludes: z.string().optional(),
    },
  },
  async (args) => {
    try {
      return reply(await act("wait", args));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "browser_new_tab",
  {
    title: "New tab",
    description: "Open a new tab in the shared profile.",
    inputSchema: { url: z.string().optional() },
  },
  async ({ url }) => {
    try {
      return reply(await act("new_tab", { url }));
    } catch (error) {
      return fail(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
