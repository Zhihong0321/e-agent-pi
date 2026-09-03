/**
 * Machine API for Cursor / operators. Auth: Bearer or X-Api-Key
 * (settings password, CLOUD_PI_MANAGE_KEY, or manage_api_key).
 *
 *   GET    /api/manage
 *   POST   /api/manage/scrapling          { force?, agent? }
 *   GET    /api/manage/agents
 *   POST   /api/manage/agents             { name, rolePrompt?, scrapling?, skillIds?, mcpIds? }
 *          scrapling defaults to true (skill + MCP attached)
 *   GET    /api/manage/agents/:id
 *   PATCH  /api/manage/agents/:id
 *   DELETE /api/manage/agents/:id
 *   POST   /api/manage/agents/:id/attach  { skill?, mcp?, skills?, mcpServers? }
 *   POST   /api/manage/agents/:id/detach  { skill?, mcp?, skills?, mcpServers? }
 *   POST   /api/manage/turn               { message, agent?, sessionId? }
 */

import {
  attachAgentResources,
  createAgent,
  deleteAgent,
  getAgent,
  listAgents,
  listMcpServers,
  listSkills,
  publicAgent,
  publicMcp,
  publicSkill,
  updateAgent,
} from "./catalog.mjs";
import { dbReady } from "./db.mjs";
import { ensureScraplingForWebsite, scraplingPublic } from "./scrapling.mjs";

function flagList(body, ...keys) {
  /** @type {string[]} */
  const out = [];
  for (const key of keys) {
    const value = body?.[key];
    if (Array.isArray(value)) {
      for (const item of value) if (item) out.push(String(item));
    } else if (typeof value === "string" && value.trim()) {
      out.push(value.trim());
    }
  }
  return out;
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {URL} url
 * @param {{
 *   json: (res: import("node:http").ServerResponse, status: number, body: unknown) => void;
 *   readBody: (req: import("node:http").IncomingMessage) => Promise<string>;
 *   sanitizeError: (error: unknown) => string;
 *   resetPi: () => Promise<void>;
 *   runTurn: (input: { message: string; agentId?: string; sessionId?: string; modelId?: string }) => Promise<object>;
 *   snapshot: () => Promise<object>;
 * }} ctx
 */
export async function handleManage(req, res, url, ctx) {
  const { json, readBody, sanitizeError, resetPi, runTurn, snapshot } = ctx;
  const pathname = url.pathname;
  const method = req.method || "GET";

  if (!dbReady()) {
    json(res, 503, { error: "Database is not connected" });
    return true;
  }

  if (method === "GET" && pathname === "/api/manage") {
    const [agents, skills, mcp, scrapling, snap] = await Promise.all([
      listAgents(),
      listSkills(),
      listMcpServers(),
      scraplingPublic(),
      snapshot(),
    ]);
    json(res, 200, {
      ok: true,
      scrapling,
      catalog: {
        agents: agents.map((row) => publicAgent(row, { includeRole: false })),
        skills: skills.map((row) => publicSkill(row)),
        mcp: mcp.map((row) => publicMcp(row, { secrets: false })),
      },
      boot: snap.boot,
      node: snap.node,
      piClient: snap.piClient,
      activeAgentId: snap.activeAgentId,
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/manage/scrapling") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const result = await ensureScraplingForWebsite({ force: Boolean(body.force) });
    if (typeof body.agent === "string" && body.agent.trim()) {
      await attachAgentResources(body.agent.trim(), {
        skills: ["scrapling-official"],
        mcp: result.mcp?.attached ? ["scrapling"] : [],
      });
    }
    await resetPi();
    json(res, 200, { ok: true, ...result });
    return true;
  }

  if (method === "GET" && pathname === "/api/manage/agents") {
    json(res, 200, { agents: (await listAgents()).map((row) => publicAgent(row, { includeRole: true })) });
    return true;
  }

  if (method === "POST" && pathname === "/api/manage/agents") {
    const body = JSON.parse((await readBody(req)) || "{}");
    if (!body.name || typeof body.name !== "string") {
      json(res, 400, { error: "name is required" });
      return true;
    }
    const agent = await createAgent(body);
    json(res, 201, { agent: publicAgent(agent, { includeRole: true }) });
    return true;
  }

  if (method === "POST" && pathname === "/api/manage/turn") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      json(res, 400, { error: "message is required" });
      return true;
    }
    try {
      const result = await runTurn({
        message,
        agentId: typeof body.agent === "string" ? body.agent : body.agentId,
        sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
        modelId: typeof body.modelId === "string" ? body.modelId : undefined,
      });
      json(res, 200, { ok: true, ...result });
    } catch (error) {
      json(res, 500, { ok: false, error: sanitizeError(error) });
    }
    return true;
  }

  const agentMatch = pathname.match(/^\/api\/manage\/agents\/([^/]+)(?:\/(attach|detach))?$/);
  if (agentMatch) {
    const agentId = decodeURIComponent(agentMatch[1]);
    const action = agentMatch[2] || "";
    const existing = await getAgent(agentId);
    if (!existing) {
      json(res, 404, { error: "Agent not found" });
      return true;
    }

    if (method === "GET" && !action) {
      json(res, 200, { agent: publicAgent(existing, { includeRole: true }) });
      return true;
    }

    if (method === "PATCH" && !action) {
      const body = JSON.parse((await readBody(req)) || "{}");
      const agent = await updateAgent(existing.id, body);
      await resetPi();
      json(res, 200, { agent: publicAgent(agent, { includeRole: true }) });
      return true;
    }

    if (method === "DELETE" && !action) {
      try {
        await deleteAgent(existing.id);
      } catch (error) {
        json(res, 400, { error: sanitizeError(error) });
        return true;
      }
      await resetPi();
      json(res, 200, { ok: true, id: existing.id });
      return true;
    }

    if (method === "POST" && (action === "attach" || action === "detach")) {
      const body = JSON.parse((await readBody(req)) || "{}");
      const agent = await attachAgentResources(existing.id, {
        skills: flagList(body, "skill", "skills"),
        mcp: flagList(body, "mcp", "mcpServers"),
        detach: action === "detach",
      });
      await resetPi();
      json(res, 200, { agent: publicAgent(agent, { includeRole: true }) });
      return true;
    }
  }

  return false;
}
