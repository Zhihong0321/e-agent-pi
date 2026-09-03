import { createHash } from "node:crypto";
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
  updateMessage,
  updateSession,
} from "./db.mjs";
import { envFlags, loadRecentFromDb, logEvent, railwayMeta, recentEvents } from "./debug.mjs";
import { latestSample, metricsPayload, setPiAliveGetter, startSampler, stopSampler } from "./metrics.mjs";
import { fileMime, listWorkspaceFiles, resolveWorkspaceFile } from "./files.mjs";
import { getGitStatus, getGitWorkspaceStatus, initGitWorkspace, initWorkspace, syncGitWorkspace } from "./github.mjs";
import { forgetBundleHash, hostConfigured, hostPublic, publishWorkspace } from "./ee-html.mjs";
import { imagenConfigured, imagenPublic } from "./imagen.mjs";
import { findModel, resolveModelCredentials } from "./models.mjs";
import { hasApiAuth, hasSession, sessionCookie, sessionToken, checkPassword } from "./auth.mjs";
import { loadSecrets, publicSettings, saveSecrets, secret, secretFlags } from "./secrets.mjs";
import {
  BUNDLED_MODELS,
  CATALOG_CLI,
  DATA_DIR,
  DEFAULT_AGENT_ID,
  DEFAULT_PROPOSAL_LIVE_URL,
  DEFAULT_PROPOSAL_REPO,
  DIST_DIR,
  IMAGEN_CLI,
  SITES_CLI,
  LIBRARY_DIR,
  PDF_CLI,
  PI_AGENT_DIR,
  PI_CLI_PATH,
  PI_PACKAGE_DIR,
  NEWPAGES_AGENT_ID,
  PACKAGE_AGENT_ID,
  PROPOSAL_AGENT_ID,
  ROOT,
  RUNTIME_DIR,
  SKILLS_DIR,
  STORAGE,
  WORKSPACE,
  WORKSPACES_DIR,
  agentWorkspace,
  isNewpagesAgent,
  isPackageAgent,
  isProposalAgent,
} from "./paths.mjs";
import { applyPiEvent, createTurn, extractReply, serializeTurn } from "./pi-stream.mjs";
import {
  attachSkillToAllAgents,
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
import { ensureImpeccableForWebsite } from "./impeccable.mjs";
import { ensureScraplingForWebsite, scraplingPublic } from "./scrapling.mjs";
import { closeBrowsers } from "./browser.mjs";
import { ensureSitesSchema, getSite, listSites, upsertSite, deleteSite } from "./sites.mjs";
import {
  ensureNewpagesLogin,
  newpagesCategories,
  newpagesCreate,
  newpagesDelete,
  newpagesNews,
  newpagesStatus,
} from "./newpages.mjs";
import { handleManage } from "./manage-api.mjs";
import { buildPiArgs, materializeAgentRuntime } from "./runtime.mjs";
import { attachmentChatMarkup, attachmentSummary, materializeAttachments } from "./attachments.mjs";
import { ensureAgyEnvironment, handleTestAgy } from "./test-agy.mjs";

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
/** @type {string} */
let activeBundleKey = "";
/** @type {boolean} */
let forceNewPiSession = false;
/** @type {Promise<void>} */
let piLock = Promise.resolve();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function staticHeaders(target) {
  const ext = path.extname(target).toLowerCase();
  const base = path.basename(target);
  /** @type {Record<string, string>} */
  const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
  if (
    base === "sw.js" ||
    base === "registerSW.js" ||
    base.startsWith("workbox-") ||
    ext === ".html" ||
    ext === ".webmanifest"
  ) {
    headers["Cache-Control"] = "no-cache";
  } else if (target.includes(`${path.sep}assets${path.sep}`)) {
    headers["Cache-Control"] = "public, max-age=31536000, immutable";
  }
  if (base === "sw.js") headers["Service-Worker-Allowed"] = "/";
  return headers;
}

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
  if (pathname === "/api/manage" || pathname.startsWith("/api/manage/")) return true;
  if (pathname === "/api/sites" || pathname.startsWith("/api/sites/")) return true;
  if (pathname === "/api/np" || pathname.startsWith("/api/np/")) return true;
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
  return hasApiAuth(req);
}

async function snapshot() {
  let git = null;
  try {
    git = await getGitStatus();
  } catch (error) {
    git = { error: sanitizeError(error) };
  }

  let proposalGit = null;
  try {
    const agent = dbReady() ? await getAgent(PROPOSAL_AGENT_ID).catch(() => null) : null;
    proposalGit = await getGitWorkspaceStatus({
      dir: agentWorkspace({ id: PROPOSAL_AGENT_ID, slug: "proposal" }),
      repo: agent?.workspaceRepo || DEFAULT_PROPOSAL_REPO,
      branch: agent?.workspaceBranch || "main",
    });
  } catch (error) {
    proposalGit = { error: sanitizeError(error) };
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
      proposalWorkspace: agentWorkspace({ id: PROPOSAL_AGENT_ID, slug: "proposal" }),
      storage: STORAGE,
      pi: PI_AGENT_DIR,
      library: LIBRARY_DIR,
      skills: SKILLS_DIR,
      runtime: RUNTIME_DIR,
    },
    db: { connected: dbReady() },
    git,
    proposalGit,
    host: hostPublic(),
    fileCount: files.length,
    sessionCount: dbReady() ? await countSessions().catch(() => 0) : 0,
    catalog: dbReady() ? await catalogCounts().catch(() => null) : null,
    activeAgentId,
    activeModelId,
    modelsConfigured: modelCatalog?.filter((entry) => entry.available).length ?? 0,
    imagen: imagenPublic(),
    scrapling: await scraplingPublic().catch(() => null),
    piClient: Boolean(client),
    env: envFlags(),
    secrets: secretFlags(),
    railway: railwayMeta(),
    node: process.version,
    resources: latestSample(),
    events: recentEvents(),
  };
}

async function publishToHost({ force = false } = {}) {
  try {
    const published = await publishWorkspace({ force });
    if (published.lastError) logEvent("error", `ee-html: ${published.lastError}`);
    else if (published.skipped) logEvent("info", `ee-html unchanged ${published.url || hostPublic().slug}`);
    else logEvent("info", `ee-html published ${published.url}`);
    return published;
  } catch (error) {
    logEvent("error", `ee-html publish failed: ${sanitizeError(error)}`);
    return { ...hostPublic(), lastError: sanitizeError(error) };
  }
}

async function publishProposal(agent) {
  const live = agent?.liveUrl || DEFAULT_PROPOSAL_LIVE_URL;
  const repo = agent?.workspaceRepo || DEFAULT_PROPOSAL_REPO;
  const branch = agent?.workspaceBranch || "main";
  try {
    const git = await syncGitWorkspace({
      dir: agentWorkspace(agent),
      repo,
      branch,
      identity: agent?.name || "Proposal Agent",
      message: "Proposal Agent: update",
    });
    if (git.lastError) logEvent("error", `proposal git: ${git.lastError}`);
    else if (git.pushed) logEvent("info", `proposal pushed ${git.sha || repo}`);
    else logEvent("info", `proposal unchanged ${git.sha || repo}`);
    return {
      configured: git.configured,
      url: live,
      slug: "proposal",
      name: agent?.name || "Proposal Agent",
      baseUrl: live.replace(/\/shell\.html.*$/, ""),
      lastError: git.lastError,
      pushed: Boolean(git.pushed),
      git,
    };
  } catch (error) {
    logEvent("error", `proposal push failed: ${sanitizeError(error)}`);
    return {
      configured: true,
      url: live,
      slug: "proposal",
      name: agent?.name || "Proposal Agent",
      lastError: sanitizeError(error),
    };
  }
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

function agentBundleKey(agent) {
  const role = createHash("sha1").update(agent.rolePrompt || "").digest("hex").slice(0, 12);
  const skills = (agent.skillIds || []).slice().sort().join(",");
  const mcp = (agent.mcpIds || []).slice().sort().join(",");
  const imagen = imagenConfigured() ? `${secret("imagen_model") || "default"}:${secret("imagen_api") || "auto"}` : "off";
  return `${agent.id}:${skills}:${mcp}:${role}:${imagen}`;
}

async function resolveAgentProfile(agentId) {
  const id = agentId || activeAgentId || WEBSITE_AGENT_ID;
  const agent = dbReady() ? await getAgent(id) : null;
  if (agent) return agent;
  const fallback = dbReady() ? await getAgent(WEBSITE_AGENT_ID) : null;
  if (fallback) return fallback;
  throw new Error("No agent is configured.");
}

function attachFallback(profile) {
  if (isProposalAgent(profile)) return "Please update the proposal from the attached files.";
  if (isNewpagesAgent(profile)) {
    return "Please use the attached files for NEWPAGES news. Copy images into this workspace and pass absolute paths to create.";
  }
  if (isPackageAgent(profile)) {
    return "Please use the attached price list or product sheet for the package/product catalog.";
  }
  return "Please use the attached files.";
}

async function getClient(profile) {
  const agent = profile || (await resolveAgentProfile(activeAgentId));
  const bundleKey = agentBundleKey(agent);
  if (client && activeAgentId === agent.id && activeBundleKey === bundleKey) return client;
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
        `starting Pi agent=${agent.slug} skills=${agent.skills?.length ?? 0} mcp=${agent.mcp?.length ?? 0} subagents=${(agent.skills ?? []).some((row) => row.slug === "spawn-subagents") ? "on" : "off"} imagen=${imagenConfigured() ? "on" : "off"} ${active.provider}/${active.model}`,
      );

      const pi = new RpcClient({
        cliPath: PI_CLI_PATH,
        cwd: agentWorkspace(agent),
        provider: active.provider,
        model: active.model,
        env: {
          ...process.env,
          PATH: ["/opt/scrapling/bin", process.env.PATH || ""].filter(Boolean).join(path.delimiter),
          SCRAPLING_BIN: process.env.SCRAPLING_BIN || "/opt/scrapling/bin/scrapling",
          PI_CODING_AGENT_DIR: runtimeDir,
          PI_PACKAGE_DIR,
          CLOUD_PI_ROOT: ROOT,
          CLOUD_PI_CATALOG: CATALOG_CLI,
          CLOUD_PI_IMAGEN: IMAGEN_CLI,
          CLOUD_PI_SITES: SITES_CLI,
          CLOUD_PI_PDF: PDF_CLI,
          ...(secret("pg_proxy_token") ? { PG_PROXY_TOKEN: secret("pg_proxy_token") } : {}),
          ...resolved.env,
        },
        args,
      });
      await pi.start();
      client = pi;
      activeAgentId = agent.id;
      activeBundleKey = bundleKey;
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

/**
 * Save the live Pi transcript as it grows so a tab close still leaves history in Postgres.
 * @param {string} sessionId
 * @param {string | null} modelId
 */
function createTurnPersister(sessionId, modelId) {
  /** @type {{ id: number } | null} */
  let row = null;
  let started = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {string | null} */
  let pending = null;
  let writing = Promise.resolve();

  /**
   * @param {string} content
   */
  function write(content) {
    writing = writing
      .then(async () => {
        if (!row) {
          row = await insertMessage({
            sessionId,
            role: "assistant",
            content,
            modelId,
          });
          return;
        }
        await updateMessage(row.id, content);
      })
      .catch((error) => {
        logEvent("warn", `turn persist failed: ${sanitizeError(error)}`);
      });
    return writing;
  }

  return {
    /**
     * @param {ReturnType<typeof createTurn>} turn
     * @param {boolean} streaming
     */
    schedule(turn, streaming) {
      const content = serializeTurn(turn, { streaming });
      if (!started) {
        started = true;
        write(content);
        return;
      }
      pending = content;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const next = pending;
        pending = null;
        if (next) write(next);
      }, 400);
    },
    /**
     * @param {ReturnType<typeof createTurn>} turn
     * @param {boolean} [streaming]
     */
    async finish(turn, streaming = false) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
      if (!started && !turn.blocks.length && !turn.text) {
        await writing;
        return;
      }
      await write(serializeTurn(turn, { streaming }));
      await writing;
    },
  };
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

/**
 * Wait until Pi emits agent_settled. RpcClient.waitForIdle() uses a wall-clock
 * timer from subscribe-time, so a long but still-streaming turn (thinking,
 * tools, tokens) is killed with "Timeout waiting for agent to become idle"
 * even though the process is alive. Reset the timer on every event instead.
 * Subscribe before prompt() so a fast agent_settled is not missed.
 * @param {import("@earendil-works/pi-coding-agent").RpcClient} pi
 * @param {number} [inactivityMs]
 */
function waitUntilAgentSettled(pi, inactivityMs = 300_000) {
  /** @type {() => void} */
  let unsubscribe = () => {};
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let finished = false;
  /** @type {(ok: boolean, error?: Error) => void} */
  let finish = () => {};

  const promise = new Promise((resolve, reject) => {
    finish = (ok, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      unsubscribe();
      if (ok) resolve();
      else reject(error ?? new Error("Agent wait cancelled"));
    };
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        finish(false, new Error("Agent went silent before finishing the turn."));
      }, inactivityMs);
    };
    unsubscribe = pi.onEvent((event) => {
      if (event?.type === "agent_settled") {
        finish(true);
        return;
      }
      bump();
    });
    bump();
  });
  promise.cancel = () => finish(false, new Error("Agent wait cancelled"));
  void promise.catch(() => {});
  return promise;
}

async function chat(message, modelId, session, onEvent, images) {
  if (modelId) await switchModel(modelId);
  const pi = await ensurePiOnSession(session);
  const turn = createTurn();
  let assistantError = "";
  const unsubscribe = pi.onEvent((event) => {
    try {
      const mapped = applyPiEvent(turn, event);
      if (mapped) onEvent?.(mapped, turn);
      if (event.type === "message_end" && event.message?.role === "assistant" && event.message?.errorMessage) {
        assistantError = event.message.errorMessage;
      }
    } catch (error) {
      logEvent("warn", `Pi event map failed: ${sanitizeError(error)}`);
    }
  });

  const settled = waitUntilAgentSettled(pi);
  try {
    onEvent?.({ type: "status", text: "Working…" }, turn);
    await pi.prompt(message, images?.length ? images : undefined);
    await settled;
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
  } catch (error) {
    settled.cancel();
    const msg = error instanceof Error ? error.message : "";
    if (msg.includes("silent before finishing")) {
      await pi.abort().catch(() => {});
    }
    throw error;
  } finally {
    unsubscribe();
  }
}

async function runManageTurn({ message, agentId, sessionId, modelId }) {
  const trimmed = String(message || "").trim();
  let session =
    typeof sessionId === "string" && sessionId.trim() ? await getSession(sessionId.trim()) : null;
  if (sessionId && !session) throw new Error("Session not found");
  if (!session) {
    const ref = typeof agentId === "string" && agentId.trim() ? agentId.trim() : WEBSITE_AGENT_ID;
    const agent = await getAgent(ref);
    if (!agent) throw new Error("Unknown agent");
    session = await createSession({
      title: titleFromMessage(trimmed),
      modelId: typeof modelId === "string" ? modelId : activeModelId,
      agentId: agent.id,
    });
  }

  logEvent("info", `manage turn session=${session.id}: ${trimmed.slice(0, 120)}`);
  await insertMessage({
    sessionId: session.id,
    role: "user",
    content: trimmed,
    modelId: typeof modelId === "string" ? modelId : activeModelId,
  });

  const turn = await withPi(() => chat(trimmed, typeof modelId === "string" ? modelId : undefined, session));
  await insertMessage({
    sessionId: session.id,
    role: "assistant",
    content: serializeTurn(turn),
    modelId: activeModelId,
  });

  const tools = (turn.blocks || [])
    .filter((block) => block.type === "tool")
    .map((block) => ({
      name: block.name,
      detail: block.detail,
      isError: Boolean(block.isError),
    }));

  return {
    reply: turn.text,
    tools,
    session: publicSession({ ...session, preview: turn.text || trimmed }),
    agentId: session.agentId,
    scrapling: await scraplingPublic().catch(() => null),
  };
}

function hostStatusNote(host, { proposal = false } = {}) {
  if (!host) return null;
  if (proposal) {
    if (host.lastError) return `GitHub push failed: ${host.lastError}`;
    if (host.pushed || host.git?.pushed) {
      const sha = host.git?.sha ? ` ${String(host.git.sha).slice(0, 7)}` : "";
      return `Pushed to GitHub${sha}. Railway will deploy ${host.url || ""}`.trim();
    }
    const sha = host.git?.sha ? String(host.git.sha).slice(0, 7) : "clean";
    return `GitHub: nothing new to push (${sha}).`;
  }
  if (host.lastError) return `ee-html publish failed: ${host.lastError}`;
  return null;
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
    res.writeHead(200, staticHeaders(target));
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
    const ext = path.extname(rel).toLowerCase();
    if (ext && ext !== ".html") {
      json(res, 404, { error: "Not found" });
      return;
    }
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
  activeBundleKey = "";
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
  await mkdir(WORKSPACES_DIR, { recursive: true });
  await mkdir(agentWorkspace({ id: NEWPAGES_AGENT_ID, slug: "newpages" }), { recursive: true });
  await mkdir(agentWorkspace({ id: PACKAGE_AGENT_ID, slug: "package" }), { recursive: true });
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

  boot.step = "metrics";
  try {
    setPiAliveGetter(() => Boolean(client));
    startSampler();
    logEvent("info", "resource sampler every 15s, keep 24h");
  } catch (error) {
    logEvent("error", `resource sampler failed: ${sanitizeError(error)}`);
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

  boot.step = "proposal-workspace";
  try {
    const agent = dbReady() ? await getAgent(PROPOSAL_AGENT_ID).catch(() => null) : null;
    const git = await initGitWorkspace({
      dir: agentWorkspace({ id: PROPOSAL_AGENT_ID, slug: "proposal" }),
      repo: agent?.workspaceRepo || DEFAULT_PROPOSAL_REPO,
      branch: agent?.workspaceBranch || "main",
      identity: "Proposal Agent",
    });
    logEvent(
      "info",
      `proposal workspace git=${git.connected} dirty=${git.dirty} repo=${git.repo || "none"} push=${git.canPush ? "on" : "off"}`,
    );
    if (git.connected && git.canPush) {
      const synced = await syncGitWorkspace({
        dir: agentWorkspace({ id: PROPOSAL_AGENT_ID, slug: "proposal" }),
        repo: agent?.workspaceRepo || DEFAULT_PROPOSAL_REPO,
        branch: agent?.workspaceBranch || "main",
        identity: "Proposal Agent",
        message: "Proposal Agent: update",
      });
      if (synced.lastError) logEvent("error", `proposal git: ${synced.lastError}`);
      else if (synced.pushed) logEvent("info", `proposal pushed ${synced.sha || synced.repo}`);
    }
  } catch (error) {
    logEvent("error", `proposal workspace init failed: ${sanitizeError(error)}`);
  }

  boot.step = "impeccable";
  try {
    if (dbReady()) {
      const result = await ensureImpeccableForWebsite();
      logEvent(
        "info",
        result.skipped
          ? "impeccable skill already in library; attached to website"
          : "impeccable skill installed for website agent",
      );
    }
  } catch (error) {
    logEvent("error", `impeccable install failed: ${sanitizeError(error)}`);
  }

  boot.step = "scrapling";
  try {
    if (dbReady()) {
      const result = await ensureScraplingForWebsite();
      logEvent(
        "info",
        result.skipped
          ? `scrapling already in library; default on ${result.attachedTo?.join(",") || "none"} mcp=${result.mcp?.attached ? "on" : "off"} bin=${result.binPresent ? "yes" : "no"}`
          : `scrapling installed; default on ${result.attachedTo?.join(",") || "none"} mcp=${result.mcp?.attached ? "on" : "off"} bin=${result.binPresent ? "yes" : "no"}`,
      );
    }
  } catch (error) {
    logEvent("error", `scrapling install failed: ${sanitizeError(error)}`);
  }

  boot.step = "sites";
  try {
    if (dbReady()) {
      await ensureSitesSchema();
      const attached = await attachSkillToAllAgents("site-browser");
      logEvent("info", `site-browser skill on ${attached.length} agents`);
    }
  } catch (error) {
    logEvent("error", `site logins failed: ${sanitizeError(error)}`);
  }

  boot.step = "catalog";
  try {
    await ensureCatalog();
  } catch (error) {
    logEvent("error", `catalog failed: ${sanitizeError(error)}`);
  }

  boot.step = "ee-html";
  try {
    if (hostConfigured()) await publishToHost();
    else logEvent("info", "ee-html API key not set");
  } catch (error) {
    logEvent("error", `ee-html publish failed: ${sanitizeError(error)}`);
  }

  boot.step = "agy-environment";
  try {
    await ensureAgyEnvironment();
  } catch (error) {
    logEvent("error", `agy environment failed: ${sanitizeError(error)}`);
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
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
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

    if (pathname === "/api/manage" || pathname.startsWith("/api/manage/")) {
      const handled = await handleManage(req, res, url, {
        json,
        readBody,
        sanitizeError,
        resetPi,
        runTurn: runManageTurn,
        snapshot,
      });
      if (handled) return;
      json(res, 404, { error: "Not found" });
      return;
    }

    if (req.method === "GET" && pathname === "/api/sites") {
      json(res, 200, { sites: dbReady() ? await listSites() : [] });
      return;
    }

    if (req.method === "POST" && pathname === "/api/sites") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!dbReady()) {
        json(res, 503, { error: "Database is not connected" });
        return;
      }
      const site = await upsertSite(body);
      json(res, 200, { site });
      return;
    }

    {
      const siteMatch = pathname.match(/^\/api\/sites\/([^/]+)(?:\/(login|status))?$/);
      if (siteMatch && dbReady()) {
        const siteId = decodeURIComponent(siteMatch[1]);
        const action = siteMatch[2] || "";
        const existing = await getSite(siteId);
        if (!existing) {
          json(res, 404, { error: "Site not found" });
          return;
        }
        if (req.method === "GET" && !action) {
          json(res, 200, { site: existing });
          return;
        }
        if (req.method === "PATCH" && !action) {
          const body = JSON.parse((await readBody(req)) || "{}");
          const site = await upsertSite({ ...existing, ...body, slug: existing.slug, id: existing.id });
          json(res, 200, { site });
          return;
        }
        if (req.method === "DELETE" && !action) {
          await deleteSite(existing.id);
          json(res, 200, { ok: true, id: existing.id });
          return;
        }
        if (req.method === "POST" && action === "login") {
          if (existing.slug !== "newpages") {
            json(res, 400, { error: `Login automation for ${existing.slug} is not implemented yet.` });
            return;
          }
          try {
            const result = await ensureNewpagesLogin();
            json(res, 200, { ok: true, ...result });
          } catch (error) {
            json(res, 500, { ok: false, error: sanitizeError(error) });
          }
          return;
        }
        if (req.method === "GET" && action === "status") {
          json(res, 200, await newpagesStatus());
          return;
        }
      }
    }

    if (pathname.startsWith("/api/np/") || pathname === "/api/np") {
      if (!dbReady()) {
        json(res, 503, { error: "Database is not connected" });
        return;
      }
      try {
        if (req.method === "GET" && pathname === "/api/np/ready") {
          json(res, 200, await newpagesStatus());
          return;
        }
        if (req.method === "GET" && pathname === "/api/np/news") {
          json(res, 200, await newpagesNews());
          return;
        }
        if (req.method === "GET" && pathname === "/api/np/news/categories") {
          json(res, 200, { categories: await newpagesCategories() });
          return;
        }
        if (req.method === "POST" && pathname === "/api/np/news") {
          const body = JSON.parse((await readBody(req)) || "{}");
          json(res, 200, await newpagesCreate(body));
          return;
        }
        const del = pathname.match(/^\/api\/np\/news\/(\d+)$/);
        if (req.method === "DELETE" && del) {
          json(res, 200, await newpagesDelete(del[1]));
          return;
        }
      } catch (error) {
        json(res, 500, { error: sanitizeError(error) });
        return;
      }
    }

    if (req.method === "GET" && pathname === "/api/settings") {
      json(res, 200, publicSettings());
      return;
    }

    if (req.method === "PUT" && pathname === "/api/settings") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const previousTarget = `${secret("ee_html_base_url")}|${secret("ee_html_slug")}`;
      await saveSecrets(body);
      if (`${secret("ee_html_base_url")}|${secret("ee_html_slug")}` !== previousTarget) {
        await forgetBundleHash();
      }
      await writePiModels().catch((error) => logEvent("error", sanitizeError(error)));
      await resetPi();
      await initWorkspace().catch((error) => logEvent("error", `workspace reinit: ${sanitizeError(error)}`));
      await ensureCatalog();
      const host = await publishToHost({ force: true });
      const proposalAgent = dbReady() ? await getAgent(PROPOSAL_AGENT_ID).catch(() => null) : null;
      await initGitWorkspace({
        dir: agentWorkspace({ id: PROPOSAL_AGENT_ID, slug: "proposal" }),
        repo: proposalAgent?.workspaceRepo || DEFAULT_PROPOSAL_REPO,
        branch: proposalAgent?.workspaceBranch || "main",
        identity: "Proposal Agent",
      }).catch((error) => logEvent("error", `proposal reinit: ${sanitizeError(error)}`));
      const proposal = await publishProposal(proposalAgent || { id: PROPOSAL_AGENT_ID, slug: "proposal" });
      logEvent("info", "settings saved to postgres");
      json(res, 200, { ...publicSettings(), host, proposal });
      return;
    }

    if (req.method === "GET" && pathname === "/api/health") {
      json(res, 200, await snapshot());
      return;
    }

    if (req.method === "GET" && pathname === "/api/metrics") {
      json(res, 200, await metricsPayload());
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

    if (req.method === "GET" && pathname === "/api/host") {
      json(res, 200, hostPublic());
      return;
    }

    if (req.method === "POST" && pathname === "/api/host") {
      const host = await publishToHost({ force: true });
      json(res, 200, host);
      return;
    }

    if (req.method === "GET" && pathname === "/api/files") {
      const agentRef = url.searchParams.get("agent");
      const agent = agentRef && dbReady() ? await getAgent(agentRef).catch(() => null) : null;
      json(res, 200, { files: await listWorkspaceFiles(agentWorkspace(agent || { slug: "website" })) });
      return;
    }

    if (req.method === "GET" && pathname === "/api/files/raw") {
      const agentRef = url.searchParams.get("agent");
      const rel = url.searchParams.get("path") || "";
      const agent = agentRef && dbReady() ? await getAgent(agentRef).catch(() => null) : null;
      const resolved = resolveWorkspaceFile(agentWorkspace(agent || { slug: "website" }), rel);
      if (!resolved) {
        json(res, 400, { error: "Bad path" });
        return;
      }
      try {
        const info = await stat(resolved.full);
        if (!info.isFile()) {
          json(res, 404, { error: "Not found" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": fileMime(resolved.full),
          "Cache-Control": "private, max-age=120",
          "Content-Length": info.size,
        });
        createReadStream(resolved.full).pipe(res);
      } catch {
        json(res, 404, { error: "Not found" });
      }
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
      const body = JSON.parse((await readBody(req)) || "{}");
      const { message, modelId, sessionId: requestedSessionId, agentId: requestedAgentId, attachments } = body;
      const hasFiles = Array.isArray(attachments) && attachments.length > 0;
      if ((!message || typeof message !== "string" || !message.trim()) && !hasFiles) {
        json(res, 400, { error: "message is required" });
        return;
      }
      if (!dbReady()) {
        json(res, 503, { error: "Database is not connected" });
        return;
      }

      const trimmed = typeof message === "string" ? message.trim() : "";
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

      const profile = await resolveAgentProfile(session.agentId);
      let packed = { prompt: "", images: [], files: [] };
      try {
        packed = await materializeAttachments(agentWorkspace(profile), attachments);
      } catch (error) {
        json(res, 400, { error: sanitizeError(error) });
        return;
      }
      const prompt = packed.prompt
        ? `${packed.prompt}\n${trimmed || attachFallback(profile)}`
        : trimmed;
      const storedUser =
        [trimmed, attachmentChatMarkup(packed.files)].filter(Boolean).join("\n\n") ||
        (packed.files.length ? `Attached: ${attachmentSummary(packed.files)}` : prompt);

      logEvent("info", `chat session=${session.id}: ${storedUser.slice(0, 120)}`);
      await insertMessage({
        sessionId: session.id,
        role: "user",
        content: storedUser,
        modelId: typeof modelId === "string" ? modelId : activeModelId,
      });
      if (session.title === "New chat") {
        const title = titleFromMessage(trimmed || packed.files[0]?.name || "New chat");
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

      const persister = createTurnPersister(session.id, activeModelId);
      /** @type {ReturnType<typeof createTurn>} */
      let lastTurn = createTurn();
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(`: ping ${Date.now()}\n\n`);
      }, 15000);

      try {
        const turn = await withPi(() =>
          chat(
            prompt,
            typeof modelId === "string" ? modelId : undefined,
            session,
            (event, liveTurn) => {
              if (liveTurn) lastTurn = liveTurn;
              if (!res.writableEnded) writeSse(res, event);
              if (liveTurn) persister.schedule(liveTurn, true);
            },
            packed.images,
          ),
        );
        lastTurn = turn;
        let host = null;
        const websiteChat = !session.agentId || session.agentId === WEBSITE_AGENT_ID;
        if (websiteChat) {
          try {
            host = await publishToHost();
          } catch (error) {
            logEvent("error", `ee-html publish failed: ${sanitizeError(error)}`);
            host = { ...hostPublic(), lastError: sanitizeError(error) };
          }
        } else if (isProposalAgent(profile)) {
          host = await publishProposal(profile);
        }
        const hostNote = hostStatusNote(host, { proposal: isProposalAgent(profile) });
        if (hostNote) {
          turn.blocks.push({ type: "note", text: hostNote });
          lastTurn = turn;
          if (!res.writableEnded) {
            writeSse(res, { type: "note", text: hostNote });
            if (host?.lastError) writeSse(res, { type: "error", error: host.lastError });
          }
        }
        await persister.finish(turn, false);
        if (session.title && session.title !== "New chat" && client) {
          await client.setSessionName(session.title).catch(() => {});
        }

        const active = activeModelId ? findModel(modelCatalog ?? [], activeModelId) : null;
        if (!res.writableEnded) {
          writeSse(res, {
            type: "done",
            reply: turn.text,
            blocks: JSON.parse(serializeTurn(turn)).blocks,
            sessionId: session.id,
            session: publicSession({ ...session, preview: turn.text || storedUser }),
            activeModelId,
            activeModel: active
              ? { id: active.id, label: active.label, provider: active.provider, model: active.model }
              : null,
          });
        }
        if (host && !res.writableEnded) writeSse(res, { type: "host", host });
      } catch (error) {
        await persister.finish(lastTurn, false).catch(() => {});
        logEvent("error", sanitizeError(error));
        if (!res.writableEnded) writeSse(res, { type: "error", error: sanitizeError(error) });
      } finally {
        clearInterval(heartbeat);
        if (!res.writableEnded) res.end();
      }
      return;
    }

    if (pathname === "/test-agy" || pathname.startsWith("/api/test-agy")) {
      return handleTestAgy(req, res, url);
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
  stopSampler();
  if (client) await client.stop().catch(() => {});
  await closeBrowsers().catch(() => {});
  await closeDb().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
