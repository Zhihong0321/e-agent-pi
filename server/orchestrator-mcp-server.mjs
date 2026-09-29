#!/usr/bin/env node
// Stdio MCP server for Orchestrator. Spawned per-session by the Pi runtime
// (see server/orchestrator-mcp.mjs). It inherits ORCHESTRATOR_DISPATCH_URL and
// ORCHESTRATOR_DISPATCH_TOKEN from that agent's process env (server/agent-env.mjs)
// and calls the host — it has no specialist tools or secrets of its own.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

function fail(error) {
  return { content: [{ type: "text", text: `Error: ${error?.message || error}` }], isError: true };
}

function reply(text) {
  return { content: [{ type: "text", text: String(text || "") }] };
}

function dispatchUrl() {
  return (process.env.ORCHESTRATOR_DISPATCH_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
}

function dispatchToken() {
  return process.env.ORCHESTRATOR_DISPATCH_TOKEN || "";
}

async function callHost(action, body = {}) {
  const token = dispatchToken();
  if (!token) throw new Error("ORCHESTRATOR_DISPATCH_TOKEN is missing — host did not inject dispatch credentials.");
  const res = await fetch(`${dispatchUrl()}/api/internal/orchestrator`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || data.result || `HTTP ${res.status}`);
  }
  return data.result ?? JSON.stringify(data);
}

const taskShape = z.object({
  id: z.string().optional().describe("Optional task id (t1, t2, …). Used in dependsOn."),
  agent: z.string().describe("Specialist id or slug from list_specialists"),
  title: z.string().optional().describe("Short task title"),
  prompt: z.string().describe("Self-contained instructions for the specialist"),
  dependsOn: z.array(z.string()).optional().describe("Task ids that must finish first"),
});

const server = new McpServer({ name: "orchestrator-dispatch", version: "1.0.0" });

server.registerTool(
  "get_company_setup",
  { title: "Company setup readiness", description: "Read live minimum Company Profile readiness, missing fields, revision, onboarding agent and manual form link. Call after profile edits; do not rely on previous chat status.", inputSchema: {} },
  async () => { try { return reply(await callHost("get_company_setup")); } catch (error) { return fail(error); } },
);

server.registerTool(
  "list_specialists",
  {
    title: "List specialist agents",
    description:
      "Live catalog of every specialist you can dispatch to, with headline, description, tool profile, skills, and MCP. Call this before planning. Never cache it across turns.",
    inputSchema: {},
  },
  async () => {
    try {
      return reply(await callHost("list_specialists"));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "create_plan",
  {
    title: "Create a plan",
    description:
      "Persist an ordered plan of specialist tasks for this chat. Use one task for a simple read; several tasks with dependsOn for a pipeline.",
    inputSchema: {
      title: z.string().describe("Short plan title"),
      summary: z.string().optional().describe("Optional one-line intent"),
      tasks: z.array(taskShape).describe("Ordered tasks"),
    },
  },
  async ({ title, summary, tasks }) => {
    try {
      return reply(await callHost("create_plan", { title, summary, tasks }));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "update_plan",
  {
    title: "Update a plan",
    description: "Change plan title/status, cancel pending tasks, or append tasks.",
    inputSchema: {
      planId: z.string().describe("Plan id from create_plan"),
      title: z.string().optional(),
      summary: z.string().optional(),
      status: z.string().optional().describe("draft | running | done | cancelled"),
      cancelTaskIds: z.array(z.string()).optional(),
      addTasks: z.array(taskShape).optional(),
    },
  },
  async (args) => {
    try {
      return reply(await callHost("update_plan", args));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "dispatch_task",
  {
    title: "Dispatch a task",
    description:
      "Run one pending task on its specialist. The specialist cannot see this chat — the task prompt must stand alone. background=true for long coding jobs.",
    inputSchema: {
      taskId: z.string().describe("Task id (t1, t2, …) from create_plan"),
      background: z.boolean().optional().describe("Return immediately and let the specialist run in the background"),
    },
  },
  async ({ taskId, background }) => {
    try {
      return reply(await callHost("dispatch_task", { taskId, background }));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "task_status",
  {
    title: "Plan and task status",
    description: "Latest plan for this chat, or a specific plan, with task statuses and result snippets.",
    inputSchema: {
      planId: z.string().optional().describe("Plan id; omit to use the latest plan on this chat"),
    },
  },
  async ({ planId }) => {
    try {
      return reply(await callHost("task_status", { planId }));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "stop_task",
  {
    title: "Stop a running task",
    description: "Abort a specialist that is still running.",
    inputSchema: {
      taskId: z.string().describe("Task id to stop"),
    },
  },
  async ({ taskId }) => {
    try {
      return reply(await callHost("stop_task", { taskId }));
    } catch (error) {
      return fail(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
