import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import {
  closeDb,
  connectDb,
  countSessions,
  createSession,
  dbReady,
  deleteSession,
  getSession,
  getSetting,
  insertMessage,
  listMessages,
  listSessions,
  setSetting,
  updateSession,
} from "./db.mjs";
import { envFlags, loadRecentFromDb, logEvent, railwayMeta, recentEvents } from "./debug.mjs";
import { listWorkspaceFiles } from "./files.mjs";
import { getGitStatus, initWorkspace, syncWorkspace } from "./github.mjs";
import { findModel, resolveModelCredentials } from "./models.mjs";
import { hasSession, sessionCookie, sessionToken, checkPassword } from "./auth.mjs";
import { loadSecrets, publicSettings, saveSecrets, secret, secretFlags } from "./secrets.mjs";
import {
  BUNDLED_MODELS,
  DATA_DIR,
  DEFAULT_AGENT_ID,
  DIST_DIR,
  LIBRARY_DIR,
  PI_AGENT_DIR,
  PI_CLI_PATH,
  PI_PACKAGE_DIR,
  RUNTIME_DIR,
  SKILLS_DIR,
  STORAGE,
  WORKSPACE,
} from "./paths.mjs";
import { applyPiEvent, createTurn, extractReply, serializeTurn } from "./pi-stream.mjs";
import {
  catalogCounts,
  createAgent,
  createMcpServer,
  deleteAgent,
  deleteMcpServer,
  deleteSkill,
  getAgent,
  getMcpServer,
  getSkill,
  installSkill,
  listAgents,
  listMcpServers,
  publicAgent,
  publicMcp,
  publicSkill,
  rescanSkillLibrary,
  seedAgentCatalog,
  updateAgent,
  updateMcpServer,
  WEBSITE_AGENT_ID,
} from "./catalog.mjs";
import { buildPiArgs, materializeAgentRuntime } from "./runtime.mjs";

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT) || 8080;
const startedAt = Date.now();

/** @type {{ step: string; error: string | null; ready: boolean }} */
const boot = { step: "starting", error: null, ready: false };

/** @type {RpcClient | undefined} */
let client;
/** @type {Promise<RpcClient> | undefined} */
let booting;
/** @type {import("./models.mjs").CatalogEntry[] | null} */
let modelCatalog = null;
/** @type {string | null} */
let activeModelId = null;
/** @type {string | null} */
let resumeSessionFile = null;
/** @type {string | null} */
let activeStudioSessionId = null;
/** @type {string} */
let activeAgentId = DEFAULT_AGENT_ID;
/** @type {boolean} */
let forceNewPiSession = false;
/** @type {Promise<void>} */
let piLock = Promise.resolve();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function sanitizeError(error) {
  const raw = error instanceof Error ? error.message : "Agent error";
  if (raw.includes("Cannot find module")) {
    return "Pi failed to start (wrong CLI path).";
  }
  return raw.length > 280 ? `${raw.slice(0, 280)}…` : raw;
}

function publicModels(catalog) {
  return catalog.map(({ id, label, shortLabel, provider, model, available }) => ({
    id,
    label,
    shortLabel,
    provider,
    model,
    available,
  }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function wantsAuth(pathname, method = "GET") {
  if (pathname === "/api/settings") return true;
  const mutating = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  if (!mutating) return false;
  return (
    pathname === "/api/agents" ||
    pathname.startsWith("/api/agents/") ||
    pathname === "/api/skills" ||
    pathname.startsWith("/api/skills/") ||
    pathname === "/api/mcp" ||
    pathname.startsWith("/api/mcp/")
  );
}

function authorized(req) {
  return hasSession(req);
}

async function snapshot() {
  let git = null;
  try {
    git = await getGitStatus();
  } catch (error) {
    git = { error: sanitizeError(error) };
  }

  let files = [];
  try {
    files = await listWorkspaceFiles();
  } catch {
    files = [];
  }

  return {
    ok: boot.ready && !boot.error,
    boot,
    now: new Date().toISOString(),
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    listen: { host: HOST, port: PORT },
    paths: {
      dataDir: DATA_DIR,
      workspace: WORKSPACE,
      storage: STORAGE,
      pi: PI_AGENT_DIR,
      library: LIBRARY_DIR,
      skills: SKILLS_DIR,
      runtime: RUNTIME_DIR,
    },
    db: { connected: dbReady() },
    git,
    fileCount: files.length,
    sessionCount: dbReady() ? await countSessions().catch(() => 0) : 0,
    catalog: dbReady() ? await catalogCounts().catch(() => null) : null,
    activeAgentId,
    activeModelId,
    modelsConfigured: modelCatalog?.filter((entry) => entry.available).length ?? 0,
    piClient: Boolean(client),
    env: envFlags(),
    secrets: secretFlags(),
    railway: railwayMeta(),
    node: process.version,
    events: recentEvents(),
  };
}

async function ensureCatalog() {
  if (modelCatalog) return modelCatalog;
  const resolved = await resolveModelCredentials();
  modelCatalog = resolved.models;
  if (!activeModelId) {
    activeModelId = (await getSetting("active_model_id").catch(() => null)) ?? resolved.defaultModelId;
  }
  return modelCatalog;
}

async function resolveAgentProfile(agentId) {
  const id = agentId || activeAgentId || WEBSITE_AGENT_ID;
  const agent = dbReady() ? await getAgent(id) : null;
  if (agent) return agent;
  const fallback = dbReady() ? await getAgent(WEBSITE_AGENT_ID) : null;
  if (fallback) return fallback;
  throw new Error("No agent is configured.");
}

async function getClient(profile) {
  const agent = profile || (await resolveAgentProfile(activeAgentId));
  if (client && activeAgentId === agent.id) return client;
  if (client) {
    await client.stop().catch(() => {});
    client = undefined;
    booting = undefined;
  }
  if (!booting) {
    booting = (async () => {
      const resolved = await resolveModelCredentials();
      modelCatalog = resolved.models;
      activeModelId = activeModelId ?? resolved.defaultModelId;
      const active = findModel(modelCatalog, activeModelId ?? "");
      if (!active?.available) {
        throw new Error("No model configured. Add API keys on the Settings page.");
      }

      const modelsJson = await writePiModels();
      const runtimeDir = await materializeAgentRuntime(agent, agent.mcp ?? [], modelsJson);
      const sessionFile = resumeSessionFile;
      const args = buildPiArgs({
        agent,
        skills: agent.skills ?? [],
        mcpCount: agent.mcp?.length ?? 0,
        runtimeDir,
        provider: active.provider,
        model: active.model,
        sessionFile,
      });
      logEvent(
        "info",
        `starting Pi agent=${agent.slug} skills=${agent.skills?.length ?? 0} mcp=${agent.mcp?.length ?? 0} ${active.provider}/${active.model}`,
      );

      const pi = new RpcClient({
        cliPath: PI_CLI_PATH,
        cwd: WORKSPACE,
        provider: active.provider,
        model: active.model,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: runtimeDir,
          PI_PACKAGE_DIR,
          ...resolved.env,
        },
        args,
      });
      await pi.start();
      client = pi;
      activeAgentId = agent.id;
      logEvent("info", sessionFile ? `Pi client started session=${sessionFile}` : "Pi client started");
      return pi;
    })();
  }
  return booting;
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withPi(fn) {
  const run = piLock.then(fn, fn);
  piLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * @param {string} text
 */
function titleFromMessage(text) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "New chat";
  return compact.length > 48 ? `${compact.slice(0, 47)}…` : compact;
}

/**
 * Bind this studio chat to its own Pi session so history/context stay isolated.
 * @param {{ id: string; title: string; agentId?: string | null; piSessionId?: string | null; piSessionFile?: string | null }} session
 */
async function ensurePiOnSession(session) {
  const profile = await resolveAgentProfile(session.agentId);
  if (session.agentId && session.agentId !== profile.id) {
    await updateSession(session.id, { agentId: profile.id });
    session.agentId = profile.id;
  }
  if (!session.agentId) session.agentId = profile.id;

  if (client && activeAgentId !== profile.id) {
    await resetPi();
    resumeSessionFile = session.piSessionFile ?? null;
  }

  const pi = await getClient(profile);
  let state;
  try {
    state = await pi.getState();
  } catch (error) {
    logEvent("error", `Pi get_state failed: ${sanitizeError(error)}`);
    await resetPi();
    resumeSessionFile = session.piSessionFile ?? null;
    const restarted = await getClient(profile);
    state = await restarted.getState();
  }

  if (session.piSessionFile && state.sessionFile === session.piSessionFile) {
    activeStudioSessionId = session.id;
    resumeSessionFile = session.piSessionFile;
    forceNewPiSession = false;
    return client ?? pi;
  }

  if (session.piSessionFile) {
    try {
      const switched = await (client ?? pi).switchSession(session.piSessionFile);
      if (!switched?.cancelled) {
        activeStudioSessionId = session.id;
        resumeSessionFile = session.piSessionFile;
        forceNewPiSession = false;
        return client ?? pi;
      }
    } catch (error) {
      logEvent("warn", `Pi switch_session failed: ${sanitizeError(error)}`);
    }
  }

  const agentClient = client ?? pi;
  const needNew = Boolean(session.piSessionId || session.piSessionFile || activeStudioSessionId || forceNewPiSession);
  if (needNew) {
    const created = await agentClient.newSession();
    if (created?.cancelled) throw new Error("Could not start a new agent session.");
    state = await agentClient.getState();
  }
  forceNewPiSession = false;

  const next = await updateSession(session.id, {
    piSessionId: state.sessionId,
    piSessionFile: state.sessionFile ?? null,
    agentId: profile.id,
  });
  session.piSessionId = next?.piSessionId ?? state.sessionId;
  session.piSessionFile = next?.piSessionFile ?? state.sessionFile ?? null;
  session.agentId = next?.agentId ?? profile.id;
  activeStudioSessionId = session.id;
  activeAgentId = profile.id;
  resumeSessionFile = session.piSessionFile ?? null;
  if (session.title && session.title !== "New chat") {
    await agentClient.setSessionName(session.title).catch(() => {});
  }
  return agentClient;
}

function publicSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    title: session.title,
    modelId: session.modelId ?? null,
    agentId: session.agentId ?? null,
    preview: session.preview ? extractReply(session.preview) : null,
    messageCount: session.messageCount ?? undefined,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function writeSse(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function switchModel(modelId) {
  const catalog = await ensureCatalog();
  const entry = findModel(catalog, modelId);
  if (!entry) throw new Error(`Unknown model: ${modelId}`);
  if (!entry.available) throw new Error(`${entry.label} is missing its API key.`);
  if (activeModelId === modelId && client) return entry;

  if (client) {
    await client.stop();
    client = undefined;
    booting = undefined;
  }
  activeModelId = modelId;
  await setSetting("active_model_id", modelId).catch(() => {});
  return entry;
}

async function chat(message, modelId, session, onEvent) {
  if (modelId) await switchModel(modelId);
  const pi = await ensurePiOnSession(session);
  const turn = createTurn();
  let assistantError = "";
  const unsubscribe = pi.onEvent((event) => {
    try {
      const mapped = applyPiEvent(turn, event);
      if (mapped) onEvent?.(mapped);
      if (event.type === "message_end" && event.message?.role === "assistant" && event.message?.errorMessage) {
        assistantError = event.message.errorMessage;
      }
    } catch (error) {
      logEvent("warn", `Pi event map failed: ${sanitizeError(error)}`);
    }
  });

  try {
    onEvent?.({ type: "status", text: "Working…" });
    await pi.prompt(message);
    await pi.waitForIdle(300_000);
    const text = (await pi.getLastAssistantText())?.trim() || turn.text.trim();
    if (text) {
      turn.text = text;
      if (!turn.blocks.some((block) => block.type === "text")) {
        turn.blocks.push({ type: "text", text });
      }
    }
    if (!text && assistantError) throw new Error(assistantError);
    if (!text && !turn.blocks.length) throw new Error("No response from agent.");
    return turn;
  } finally {
    unsubscribe();
  }
}

async function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(DIST_DIR, rel));
  if (!file.startsWith(DIST_DIR)) {
    json(res, 400, { error: "Bad path" });
    return;
  }

  const send = async (target) => {
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    createReadStream(target).pipe(res);
  };

  try {
    const info = await stat(file);
    if (info.isDirectory()) {
      await send(path.join(file, "index.html"));
      return;
    }
    await send(file);
  } catch {
    try {
      await send(path.join(DIST_DIR, "index.html"));
    } catch {
      json(res, 503, { error: "UI build missing. Run npm run build.", boot });
    }
  }
}

async function resetPi() {
  modelCatalog = null;
  activeStudioSessionId = null;
  forceNewPiSession = true;
  if (client) {
    await client.stop().catch(() => {});
    client = undefined;
    booting = undefined;
  }
}

async function writePiModels() {
  await mkdir(PI_AGENT_DIR, { recursive: true });
  const raw = JSON.parse(await readFile(BUNDLED_MODELS, "utf8"));
  const cavoti = secret("cavoti_base_url");
  const kimi = secret("kimi_base_url");
  if (cavoti) raw.providers.cavoti.baseUrl = cavoti;
  if (kimi) raw.providers["kimi-k3"].baseUrl = kimi;
  const text = JSON.stringify(raw, null, 2);
  await writeFile(path.join(PI_AGENT_DIR, "models.json"), text);
  return text;
}

async function prepareDirs() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(WORKSPACE, { recursive: true });
  await mkdir(STORAGE, { recursive: true });
  await mkdir(PI_AGENT_DIR, { recursive: true });
  await mkdir(LIBRARY_DIR, { recursive: true });
  await mkdir(SKILLS_DIR, { recursive: true });
  await mkdir(RUNTIME_DIR, { recursive: true });
}

async function bootServices() {
  boot.step = "directories";
  try {
    await prepareDirs();
    logEvent("info", `data dir ${DATA_DIR}`);
  } catch (error) {
    boot.error = sanitizeError(error);
    logEvent("error", `volume/dirs failed: ${boot.error}`);
  }

  boot.step = "postgres";
  try {
    await connectDb();
    await loadSecrets();
    logEvent("info", "postgres connected");
  } catch (error) {
    boot.error = sanitizeError(error);
    logEvent("error", `postgres failed: ${boot.error}`);
  }

  boot.step = "pi-config";
  try {
    await writePiModels();
  } catch (error) {
    logEvent("error", `pi models copy failed: ${sanitizeError(error)}`);
  }

  boot.step = "workspace";
  try {
    await initWorkspace();
    const git = await getGitStatus();
    logEvent("info", `workspace ready git=${git.connected} dirty=${git.dirty}`);
  } catch (error) {
    logEvent("error", `workspace init failed: ${sanitizeError(error)}`);
  }

  boot.step = "agent-catalog";
  try {
    if (dbReady()) {
      await seedAgentCatalog();
      const counts = await catalogCounts();
      logEvent("info", `agents=${counts.agents} skills=${counts.skills} mcp=${counts.mcp}`);
    }
  } catch (error) {
    logEvent("error", `agent catalog failed: ${sanitizeError(error)}`);
  }

  boot.step = "catalog";
  try {
    await ensureCatalog();
  } catch (error) {
    logEvent("error", `catalog failed: ${sanitizeError(error)}`);
  }

  boot.step = "ready";
  boot.ready = true;
  logEvent("info", "boot complete");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  if (wantsAuth(pathname, req.method) && !authorized(req)) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }

  try {
    if (req.method === "GET" && pathname === "/api/auth/me") {
      json(res, 200, { ok: hasSession(req) });
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/login") {
      const { password } = JSON.parse((await readBody(req)) || "{}");
      if (!checkPassword(password)) {
        json(res, 401, { error: "Wrong password" });
        return;
      }
      json(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(sessionToken()) });
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/logout") {
      json(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", true) });
      return;
    }

    if (req.method === "GET" && pathname === "/api/settings") {
      json(res, 200, publicSettings());
      return;
    }

    if (req.method === "PUT" && pathname === "/api/settings") {
      const body = JSON.parse((await readBody(req)) || "{}");
      await saveSecrets(body);
      await writePiModels().catch((error) => logEvent("error", sanitizeError(error)));
      await resetPi();
      await initWorkspace().catch((error) => logEvent("error", `workspace reinit: ${sanitizeError(error)}`));
      await ensureCatalog();
      logEvent("info", "settings saved to postgres");
      json(res, 200, publicSettings());
      return;
    }

    if (req.method === "GET" && pathname === "/api/health") {
      json(res, 200, await snapshot());
      return;
    }

    if (req.method === "GET" && pathname === "/api/debug") {
      const body = await snapshot();
      body.dbEvents = await loadRecentFromDb();
      json(res, 200, body);
      return;
    }

    if (req.method === "GET" && pathname === "/api/git") {
      json(res, 200, await getGitStatus());
      return;
    }

    if (req.method === "GET" && pathname === "/api/files") {
      json(res, 200, { files: await listWorkspaceFiles() });
      return;
    }

    if (req.method === "GET" && pathname === "/api/agents") {
      json(res, 200, {
        agents: dbReady() ? (await listAgents()).map((row) => publicAgent(row, { includeRole: authorized(req) })) : [],
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/agents") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!body.name || typeof body.name !== "string") {
        json(res, 400, { error: "name is required" });
        return;
      }
      const agent = await createAgent(body);
      json(res, 201, { agent: publicAgent(agent, { includeRole: true }) });
      return;
    }

    {
      const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
      if (agentMatch && dbReady()) {
        const agentId = decodeURIComponent(agentMatch[1]);
        const existing = await getAgent(agentId);
        if (!existing) {
          json(res, 404, { error: "Agent not found" });
          return;
        }
        if (req.method === "GET") {
          json(res, 200, { agent: publicAgent(existing, { includeRole: authorized(req) }) });
          return;
        }
        if (req.method === "PATCH") {
          const body = JSON.parse((await readBody(req)) || "{}");
          const agent = await updateAgent(existing.id, body);
          if (activeAgentId === existing.id) await resetPi();
          json(res, 200, { agent: publicAgent(agent, { includeRole: true }) });
          return;
        }
        if (req.method === "DELETE") {
          try {
            await deleteAgent(existing.id);
          } catch (error) {
            json(res, 400, { error: sanitizeError(error) });
            return;
          }
          if (activeAgentId === existing.id) await resetPi();
          json(res, 200, { ok: true, id: existing.id });
          return;
        }
      }
    }

    if (req.method === "GET" && pathname === "/api/skills") {
      const skills = dbReady() ? await rescanSkillLibrary() : [];
      json(res, 200, { skills: skills.map((row) => publicSkill(row)) });
      return;
    }

    if (req.method === "POST" && pathname === "/api/skills") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (body.rescan) {
        const skills = await rescanSkillLibrary();
        json(res, 200, { skills: skills.map((row) => publicSkill(row)) });
        return;
      }
      const skill = await installSkill(body);
      json(res, 201, { skill: publicSkill(skill) });
      return;
    }

    {
      const skillMatch = pathname.match(/^\/api\/skills\/([^/]+)$/);
      if (skillMatch && dbReady()) {
        const skillId = decodeURIComponent(skillMatch[1]);
        const existing = await getSkill(skillId);
        if (!existing) {
          json(res, 404, { error: "Skill not found" });
          return;
        }
        if (req.method === "GET") {
          json(res, 200, { skill: { ...publicSkill(existing), content: existing.content } });
          return;
        }
        if (req.method === "DELETE") {
          await deleteSkill(existing.id);
          if (client) await resetPi();
          json(res, 200, { ok: true, id: existing.id });
          return;
        }
      }
    }

    if (req.method === "GET" && pathname === "/api/mcp") {
      const authed = authorized(req);
      json(res, 200, {
        servers: dbReady() ? (await listMcpServers()).map((row) => publicMcp(row, { secrets: authed })) : [],
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/mcp") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!body.name || typeof body.name !== "string") {
        json(res, 400, { error: "name is required" });
        return;
      }
      const server = await createMcpServer(body);
      json(res, 201, { server: publicMcp(server, { secrets: true }) });
      return;
    }

    {
      const mcpMatch = pathname.match(/^\/api\/mcp\/([^/]+)$/);
      if (mcpMatch && dbReady()) {
        const mcpId = decodeURIComponent(mcpMatch[1]);
        const existing = await getMcpServer(mcpId);
        if (!existing) {
          json(res, 404, { error: "MCP server not found" });
          return;
        }
        if (req.method === "GET") {
          json(res, 200, { server: publicMcp(existing, { secrets: authorized(req) }) });
          return;
        }
        if (req.method === "PATCH") {
          const body = JSON.parse((await readBody(req)) || "{}");
          const server = await updateMcpServer(existing.id, body);
          if (client) await resetPi();
          json(res, 200, { server: publicMcp(server, { secrets: true }) });
          return;
        }
        if (req.method === "DELETE") {
          await deleteMcpServer(existing.id);
          if (client) await resetPi();
          json(res, 200, { ok: true, id: existing.id });
          return;
        }
      }
    }

    if (req.method === "GET" && pathname === "/api/messages") {
      const sessionId = url.searchParams.get("sessionId")?.trim();
      if (!sessionId) {
        json(res, 400, { error: "sessionId is required" });
        return;
      }
      json(res, 200, { sessionId, messages: dbReady() ? await listMessages(sessionId) : [] });
      return;
    }

    if (req.method === "GET" && pathname === "/api/sessions") {
      const agentId = url.searchParams.get("agentId")?.trim() || undefined;
      json(res, 200, {
        sessions: dbReady() ? (await listSessions(agentId)).map((row) => publicSession(row)) : [],
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/sessions") {
      if (!dbReady()) {
        json(res, 503, { error: "Database is not connected" });
        return;
      }
      const body = JSON.parse((await readBody(req)) || "{}");
      const title = typeof body.title === "string" ? body.title : undefined;
      const requestedAgent =
        typeof body.agentId === "string" && body.agentId.trim() ? body.agentId.trim() : WEBSITE_AGENT_ID;
      const agent = await getAgent(requestedAgent);
      if (!agent) {
        json(res, 400, { error: "Unknown agent" });
        return;
      }
      const session = await createSession({
        title,
        modelId: typeof body.modelId === "string" ? body.modelId : activeModelId,
        agentId: agent.id,
      });
      logEvent("info", `session created ${session.id}`);
      json(res, 201, { session: publicSession(session) });
      return;
    }

    {
      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch) {
        if (!dbReady()) {
          json(res, 503, { error: "Database is not connected" });
          return;
        }
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const session = await getSession(sessionId);
        if (!session) {
          json(res, 404, { error: "Session not found" });
          return;
        }

        if (req.method === "GET") {
          json(res, 200, {
            session: publicSession(session),
            messages: await listMessages(sessionId),
          });
          return;
        }

        if (req.method === "PATCH") {
          const body = JSON.parse((await readBody(req)) || "{}");
          const title = typeof body.title === "string" ? body.title.trim() : "";
          if (!title) {
            json(res, 400, { error: "title is required" });
            return;
          }
          const updated = await updateSession(sessionId, { title });
          if (activeStudioSessionId === sessionId && client) {
            await client.setSessionName(title).catch(() => {});
          }
          json(res, 200, { session: publicSession(updated) });
          return;
        }

        if (req.method === "DELETE") {
          await deleteSession(sessionId);
          if (activeStudioSessionId === sessionId) {
            activeStudioSessionId = null;
            forceNewPiSession = true;
          }
          json(res, 200, { ok: true, id: sessionId });
          return;
        }
      }
    }

    if (req.method === "GET" && pathname === "/api/models") {
      const catalog = await ensureCatalog();
      json(res, 200, { activeModelId, models: publicModels(catalog) });
      return;
    }

    if (req.method === "POST" && pathname === "/api/model") {
      const { modelId } = JSON.parse((await readBody(req)) || "{}");
      if (!modelId || typeof modelId !== "string") {
        json(res, 400, { error: "modelId is required" });
        return;
      }
      const entry = await withPi(() => switchModel(modelId));
      json(res, 200, {
        activeModelId: entry.id,
        activeModel: { id: entry.id, label: entry.label, provider: entry.provider, model: entry.model },
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/chat") {
      const { message, modelId, sessionId: requestedSessionId, agentId: requestedAgentId } = JSON.parse(
        (await readBody(req)) || "{}",
      );
      if (!message || typeof message !== "string") {
        json(res, 400, { error: "message is required" });
        return;
      }
      if (!dbReady()) {
        json(res, 503, { error: "Database is not connected" });
        return;
      }

      const trimmed = message.trim();
      let session =
        typeof requestedSessionId === "string" && requestedSessionId.trim()
          ? await getSession(requestedSessionId.trim())
          : null;
      if (requestedSessionId && !session) {
        json(res, 404, { error: "Session not found" });
        return;
      }
      if (!session) {
        const agent = await getAgent(
          typeof requestedAgentId === "string" && requestedAgentId.trim() ? requestedAgentId.trim() : WEBSITE_AGENT_ID,
        );
        if (!agent) {
          json(res, 400, { error: "Unknown agent" });
          return;
        }
        session = await createSession({
          modelId: typeof modelId === "string" ? modelId : activeModelId,
          agentId: agent.id,
        });
      }

      logEvent("info", `chat session=${session.id}: ${trimmed.slice(0, 120)}`);
      await insertMessage({
        sessionId: session.id,
        role: "user",
        content: trimmed,
        modelId: typeof modelId === "string" ? modelId : activeModelId,
      });
      if (session.title === "New chat") {
        const title = titleFromMessage(trimmed);
        const updated = await updateSession(session.id, { title, modelId: activeModelId });
        if (updated) session = updated;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      });
      if (typeof res.flushHeaders === "function") res.flushHeaders();
      res.socket?.setNoDelay?.(true);
      writeSse(res, { type: "session", sessionId: session.id, session: publicSession(session) });

      let finished = false;
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(`: ping ${Date.now()}\n\n`);
      }, 15000);
      const abortIfOpen = () => {
        if (!finished) client?.abort().catch(() => {});
      };
      req.on("close", abortIfOpen);

      try {
        const turn = await withPi(() =>
          chat(trimmed, typeof modelId === "string" ? modelId : undefined, session, (event) => {
            if (!res.writableEnded) writeSse(res, event);
          }),
        );
        await insertMessage({
          sessionId: session.id,
          role: "assistant",
          content: serializeTurn(turn),
          modelId: activeModelId,
        });
        if (session.title && session.title !== "New chat" && client) {
          await client.setSessionName(session.title).catch(() => {});
        }

        const active = activeModelId ? findModel(modelCatalog ?? [], activeModelId) : null;
        writeSse(res, {
          type: "done",
          reply: turn.text,
          blocks: JSON.parse(serializeTurn(turn)).blocks,
          sessionId: session.id,
          session: publicSession({ ...session, preview: turn.text || trimmed }),
          activeModelId,
          activeModel: active
            ? { id: active.id, label: active.label, provider: active.provider, model: active.model }
            : null,
        });

        let git = null;
        try {
        git = await syncWorkspace(`${session.title || "Agent"}: ${trimmed.slice(0, 72)}`);
        } catch (error) {
          logEvent("error", `git sync failed: ${sanitizeError(error)}`);
          git = await getGitStatus().catch(() => null);
        }
        if (git && !res.writableEnded) writeSse(res, { type: "git", git });
      } catch (error) {
        logEvent("error", sanitizeError(error));
        if (!res.writableEnded) writeSse(res, { type: "error", error: sanitizeError(error) });
      } finally {
        finished = true;
        clearInterval(heartbeat);
        req.off("close", abortIfOpen);
        if (!res.writableEnded) res.end();
      }
      return;
    }

    if (pathname.startsWith("/api/")) {
      json(res, 404, { error: "Not found" });
      return;
    }

    await serveStatic(res, pathname);
  } catch (error) {
    logEvent("error", sanitizeError(error));
    json(res, 500, { error: sanitizeError(error), boot });
  }
});

process.on("uncaughtException", (error) => {
  logEvent("error", `uncaughtException: ${error?.message || error}`);
});
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  logEvent("error", `unhandledRejection: ${message}`);
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.listen(PORT, HOST, () => {
  logEvent("info", `listening on ${HOST}:${PORT}`);
  void bootServices();
});

async function shutdown() {
  logEvent("info", "shutdown");
  if (client) await client.stop().catch(() => {});
  await closeDb().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
