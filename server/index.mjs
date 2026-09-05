import { createHash, randomBytes } from "node:crypto";
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
  lastPiSession,
  listMessages,
  listSessions,
  setSetting,
  updateMessage,
  updateSession,
} from "./db.mjs";
import { envFlags, loadRecentFromDb, logEvent, railwayMeta, recentEvents } from "./debug.mjs";
import { cgroupMemory, latestSample, metricsPayload, setPiAliveGetter, startSampler, stopSampler } from "./metrics.mjs";
import { childrenOf, descendants, envInt, killTree, pidAlive, reapLeakedChildren, rpcClientPid } from "./proc.mjs";
import { memoryPressure, pickEvictable, pickIdleSlots } from "./pi-idle.mjs";
import { fileMime, listWorkspaceFiles, resolveWorkspaceFile, workspaceFingerprint } from "./files.mjs";
import { getGitStatus, getGitWorkspaceStatus, initGitWorkspace, initWorkspace, syncGitWorkspace } from "./github.mjs";
import { forgetBundleHash, hostConfigured, hostPublic, publishWorkspace } from "./ee-html.mjs";
import { imagenConfigured, imagenPublic } from "./imagen.mjs";
import { findModel, normalizeCavotiBaseUrl, resolveModelCredentials } from "./models.mjs";
import { hasApiAuth, hasSession, hasStockAuth, sessionCookie, sessionToken, checkPassword } from "./auth.mjs";
import { loadSecrets, publicSettings, rememberSecret, saveSecrets, secret, secretFlags } from "./secrets.mjs";
import {
  adjustStockItem,
  ensureStockSchema,
  listStockItems,
  listStockMovements,
  seedStockItems,
  setStockItem,
  setStockItems,
} from "./stock.mjs";
import {
  BUNDLED_MODELS,
  DATA_DIR,
  DEFAULT_PROPOSAL_LIVE_URL,
  DEFAULT_PROPOSAL_REPO,
  DIST_DIR,
  LIBRARY_DIR,
  PI_AGENT_DIR,
  PI_CLI_PATH,
  PI_PACKAGE_DIR,
  NEWPAGES_AGENT_ID,
  PACKAGE_AGENT_ID,
  PROPOSAL_AGENT_ID,
  SETTINGS_AGENT_ID,
  AFA_AGENT_ID,
  SALES_AGENT_ID,
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
import { ensureSalesMcp } from "./sales-mcp.mjs";
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
import { newpagesHealth } from "./newpages-health.mjs";
import { handleManage } from "./manage-api.mjs";
import { buildPiArgs, materializeAgentRuntime } from "./runtime.mjs";
import { agentEnv } from "./agent-env.mjs";
import {
  AUTO_CONTINUE_PROMPT,
  appendStateJournal,
  contextPackFingerprint,
  enrichRestartPrompt,
  mergeTurns,
  needsAutoContinue,
  previewContextPack,
  turnMetrics,
} from "./context-pack.mjs";
import { healWebsiteWorkspace } from "./workspace-heal.mjs";
import { attachmentChatMarkup, attachmentSummary, materializeAttachments } from "./attachments.mjs";
import { ensureAgyEnvironment, handleTestAgy } from "./test-agy.mjs";
import { chatAgy, AGY_MODELS } from "./agy-stream.mjs";

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT) || 8080;
const startedAt = Date.now();

/** @type {{ step: string; error: string | null; ready: boolean }} */
const boot = { step: "starting", error: null, ready: false };

/**
 * @typedef {{
 *   key: string,
 *   runtimeKey: string,
 *   client: RpcClient | undefined,
 *   booting: Promise<RpcClient> | undefined,
 *   agentId: string,
 *   agentSlug: string,
 *   modelId: string,
 *   activeStudioSessionId: string | null,
 *   resumeSessionFile: string | null,
 *   forceNewPiSession: boolean,
 *   pid: number | null,
 *   busy: boolean,
 *   lock: Promise<void>,
 *   lastUsedAt: number,
 *   exits: number[],
 *   runtimeHash: string,
 *   bootedAt: number,
 *   readyAt: number,
 *   lastEnsure: { getStateMs: number; switchMs: number; mode: string } | null,
 * }} PiSlot
 */
/** @type {Map<string, PiSlot>} */
const piPool = new Map();
const MAX_PI_SLOTS = envInt("PI_POOL_SIZE", 3, { min: 1, max: 16 });
const PI_SLOT_IDLE_MS = envInt("PI_SLOT_IDLE_MS", 180_000, { min: 15_000 });
const PI_KEEP_WARM = envInt("PI_KEEP_WARM", 2, { min: 1, max: 8 });
const PI_IDLE_SWEEP_MS = envInt("PI_IDLE_SWEEP_MS", 30_000, { min: 10_000, max: 300_000 });
/** Agent ids or slugs the idle sweep never evicts (comma separated). */
const PI_PIN_AGENTS = new Set(
  String(process.env.PI_PIN_AGENTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
/** Agents to boot a Pi for right after startup (comma separated ids/slugs); the last-used one is always added. */
const PI_PREWARM_AGENTS = String(process.env.PI_PREWARM_AGENTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
/** Above this share of the cgroup limit the sweep drops warm extras immediately. */
const PI_MEM_SOFT = envInt("PI_MEM_SOFT_PCT", 60, { min: 10, max: 100 }) / 100;
/** Above this share a new Pi is only started after freeing memory, else refused. */
const PI_MEM_HARD = envInt("PI_MEM_HARD_PCT", 75, { min: 10, max: 100 }) / 100;
/** Re-warm an idle slot after an unexpected exit at most this many times per 10 min. */
const PI_REWARM_MAX = 2;
const PI_REWARM_WINDOW_MS = 10 * 60_000;
const PI_REWARM_DELAY_MS = 5_000;
const PI_LAST_SLOT_SETTING = "pi_last_slot";
/** @type {Promise<void>} */
let poolReserveLock = Promise.resolve();
/** @type {Map<string, Promise<void>>} */
const agentLocks = new Map();

/** @type {import("./models.mjs").CatalogEntry[] | null} */
let modelCatalog = null;
/** @type {string | null} */
let defaultModelId = null;
let turnsInFlight = 0;

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
  if (pathname === "/api/np/health") return false;
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
    defaultModelId,
    modelsConfigured: modelCatalog?.filter((entry) => entry.available).length ?? 0,
    imagen: imagenPublic(),
    scrapling: await scraplingPublic().catch(() => null),
    piPoolSize: piPool.size,
    piPoolMax: MAX_PI_SLOTS,
    piKeepWarm: PI_KEEP_WARM,
    piIdleMs: PI_SLOT_IDLE_MS,
    piPinned: [...PI_PIN_AGENTS],
    piMemory: { soft: PI_MEM_SOFT, hard: PI_MEM_HARD, ratio: await memoryRatio() },
    piWarm: poolWarmSummary(),
    env: envFlags(),
    secrets: secretFlags(),
    railway: railwayMeta(),
    node: process.version,
    resources: latestSample(),
    events: recentEvents(),
  };
}

/** Workspace fingerprint at the last publish that left the host in sync (published or unchanged). */
let publishedFingerprint = "";

async function publishToHost({ force = false } = {}) {
  try {
    // Zipping and hashing the whole workspace every turn is the expensive
    // part; a count/bytes/mtime walk is not. Skip the zip when nothing moved.
    const fingerprint = await workspaceFingerprint(WORKSPACE).catch(() => "");
    if (!force && fingerprint && fingerprint === publishedFingerprint && secret("ee_html_url")) {
      return { ...hostPublic(), skipped: true };
    }
    const published = await publishWorkspace({ force });
    if (published.lastError) logEvent("error", `ee-html: ${published.lastError}`);
    else if (published.skipped) logEvent("info", `ee-html unchanged ${published.url || hostPublic().slug}`);
    else logEvent("info", `ee-html published ${published.url}`);
    if (!published.lastError && fingerprint) publishedFingerprint = fingerprint;
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
  if (!defaultModelId) {
    defaultModelId = (await getSetting("active_model_id").catch(() => null)) ?? resolved.defaultModelId;
  }
  return modelCatalog;
}

async function agentBundleKey(agent, modelId) {
  const role = createHash("sha1").update(agent.rolePrompt || "").digest("hex").slice(0, 12);
  const pack = await contextPackFingerprint(agent);
  const skills = (agent.skillIds || []).slice().sort().join(",");
  const mcp = (agent.mcpIds || []).slice().sort().join(",");
  const imagen = imagenConfigured() ? `${secret("imagen_model") || "default"}:${secret("imagen_api") || "auto"}` : "off";
  return `${agent.id}:${skills}:${mcp}:${role}:${pack}:${modelId || "none"}:${imagen}`;
}

async function resolveAgentProfile(agentId) {
  const id = agentId || WEBSITE_AGENT_ID;
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

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withPoolReserve(fn) {
  const run = poolReserveLock.then(fn, fn);
  poolReserveLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * @param {string} agentId
 * @param {() => Promise<T>} fn
 * @template T
 * @returns {Promise<T>}
 */
function withAgentLock(agentId, fn) {
  const prev = agentLocks.get(agentId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  agentLocks.set(
    agentId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * @param {PiSlot} slot
 * @param {() => Promise<T>} fn
 * @template T
 * @returns {Promise<T>}
 */
function withSlotLock(slot, fn) {
  const wrapped = async () => {
    slot.busy = true;
    try {
      return await fn();
    } finally {
      slot.busy = false;
      slot.lastUsedAt = Date.now();
    }
  };
  const run = slot.lock.then(wrapped, wrapped);
  slot.lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Which agents actually have a live Pi right now (a slot entry alone is not proof). */
function poolWarmSummary() {
  return [...piPool.values()]
    .filter((slot) => slot.client && slot.pid && pidAlive(slot.pid))
    .map((slot) => ({
      agent: slot.agentSlug,
      model: slot.modelId,
      pid: slot.pid,
      busy: slot.busy,
      idleSec: Math.round((Date.now() - (slot.lastUsedAt || 0)) / 1000),
    }));
}

function liveKeepPids() {
  return [...piPool.values()].map((slot) => slot.pid || rpcClientPid(slot.client)).filter(Boolean);
}

/**
 * Stop a slot after any in-flight turn, then kill the Pi process tree
 * (MCP / Scrapling children). On Railway the host is PID 1, so those
 * children get reparented here if we only call client.stop().
 * @param {PiSlot} slot
 */
async function stopSlot(slot) {
  if (!slot) return;
  piPool.delete(slot.key);
  const run = slot.lock.then(async () => {
    const client = slot.client;
    const pid = slot.pid || rpcClientPid(client);
    slot.client = undefined;
    slot.booting = undefined;
    slot.pid = null;
    if (client) await client.stop().catch(() => {});
    await killTree(pid);
  });
  slot.lock = run.then(
    () => undefined,
    () => undefined,
  );
  await run;
}

function evictSlot(slot) {
  void stopSlot(slot);
}

function evictIfNeeded() {
  const over = piPool.size - MAX_PI_SLOTS;
  if (over <= 0) return;
  const oldest = [...piPool.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt).slice(0, over);
  for (const slot of oldest) evictSlot(slot);
}

/**
 * Share of the container memory limit in use, or null when the host does not
 * expose a cgroup limit (then the pool never throttles on memory).
 */
async function memoryRatio() {
  try {
    return memoryPressure(await cgroupMemory());
  } catch {
    return null;
  }
}

function pct(ratio) {
  return `${Math.round(ratio * 100)}%`;
}

/**
 * Before spawning another Pi: if the container is above the hard threshold,
 * stop least-recently-used idle slots (never the one we are booting for,
 * never a busy one) until there is room, else refuse with a clear message
 * instead of letting the kernel OOM-kill whatever it likes.
 * @param {PiSlot} slot
 */
async function ensureMemoryHeadroom(slot) {
  for (let round = 0; round < MAX_PI_SLOTS + 1; round += 1) {
    const ratio = await memoryRatio();
    if (ratio == null || ratio < PI_MEM_HARD) return;
    const victim = pickEvictable([...piPool.values()], { keepWarm: 0, exclude: slot })[0];
    if (!victim) {
      throw new Error(
        `Host is at memory capacity (${pct(ratio)} of the container limit) and no idle Pi can be stopped. Try again in a minute.`,
      );
    }
    logEvent("warn", `memory ${pct(ratio)} >= hard ${pct(PI_MEM_HARD)}: evicting agent=${victim.agentSlug} to start agent=${slot.agentSlug}`);
    await stopSlot(victim);
  }
}

async function sweepIdleSlots() {
  const slots = [...piPool.values()];

  // A Pi that died (OOM, crash) must not look warm. The exit listener
  // normally clears it first; this catches anything it missed.
  for (const slot of slots) {
    if (slot.client && !slot.booting && slot.pid && !pidAlive(slot.pid)) {
      logEvent("warn", `Pi pid=${slot.pid} agent=${slot.agentSlug} is gone; dropping slot`);
      await stopSlot(slot);
    }
  }

  const idle = pickIdleSlots([...piPool.values()], {
    idleMs: PI_SLOT_IDLE_MS,
    keepWarm: PI_KEEP_WARM,
    pinned: PI_PIN_AGENTS,
  });
  for (const slot of idle) {
    logEvent("info", `idle-evict agent=${slot.agentSlug} keepWarm=${PI_KEEP_WARM} live=${piPool.size}/${MAX_PI_SLOTS}`);
    await stopSlot(slot);
  }

  const ratio = await memoryRatio();
  if (ratio != null && ratio >= PI_MEM_SOFT) {
    const extras = pickEvictable([...piPool.values()], { keepWarm: PI_KEEP_WARM, pinned: PI_PIN_AGENTS });
    for (const slot of extras) {
      logEvent("warn", `memory ${pct(ratio)} >= soft ${pct(PI_MEM_SOFT)}: evicting warm extra agent=${slot.agentSlug}`);
      await stopSlot(slot);
    }
  }

  const leaked = await reapLeakedChildren({ keepPids: liveKeepPids() }).catch(() => 0);
  if (leaked) logEvent("warn", `reaped ${leaked} leaked Pi/MCP child process(es)`);
}

/**
 * Everything the runtime files are built from. The pool key already covers
 * role, pack, skills, MCP ids, model and imagen; MCP server config and the
 * provider base URLs are the only inputs it does not.
 * @param {PiSlot} slot
 */
function runtimeInputsHash(slot, agent, modelsJson) {
  return createHash("sha1")
    .update(slot.key)
    .update("\0")
    .update(modelsJson)
    .update("\0")
    .update(JSON.stringify(agent.mcp ?? []))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Rewrite the slot's runtime files only when their inputs changed. Before
 * this ran on every turn of a warm slot (models.json + ROLE.md + mcp.json +
 * settings.json) for no effect: Pi read ROLE.md once at spawn.
 * @param {PiSlot} slot
 */
async function refreshSlotRuntime(slot, agent, modelId) {
  const modelsJson = await buildPiModelsJson();
  const hash = runtimeInputsHash(slot, agent, modelsJson);
  if (slot.runtimeHash === hash) return false;
  await writePiModels(modelsJson);
  await materializeAgentRuntime(agent, agent.mcp ?? [], modelsJson, { modelId, runtimeKey: slot.runtimeKey });
  slot.runtimeHash = hash;
  return true;
}

/**
 * @param {PiSlot} slot
 */
async function startSlotClient(slot, agent, modelId) {
  const resolved = await resolveModelCredentials();
  modelCatalog = resolved.models;
  const active = findModel(modelCatalog, modelId);
  if (!active?.available) {
    throw new Error("No model configured. Add API keys on the Settings page.");
  }

  const modelsJson = await writePiModels();
  const runtimeDir = await materializeAgentRuntime(agent, agent.mcp ?? [], modelsJson, {
    modelId,
    runtimeKey: slot.runtimeKey,
  });
  slot.runtimeHash = runtimeInputsHash(slot, agent, modelsJson);
  const sessionFile = slot.resumeSessionFile;
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
    `starting Pi agent=${agent.slug} skills=${agent.skills?.length ?? 0} mcp=${agent.mcp?.length ?? 0} subagents=${(agent.skills ?? []).some((row) => row.slug === "spawn-subagents") ? "on" : "off"} imagen=${imagenConfigured() ? "on" : "off"} ${active.provider}/${active.model} pool=${piPool.size}/${MAX_PI_SLOTS}`,
  );

  const workspace = agentWorkspace(agent);
  await mkdir(workspace, { recursive: true });
  await ensureMemoryHeadroom(slot);
  const beforeKids = new Set(await childrenOf(process.pid).catch(() => []));
  const spawnedAt = Date.now();
  const pi = new RpcClient({
    cliPath: PI_CLI_PATH,
    cwd: workspace,
    provider: active.provider,
    model: active.model,
    env: agentEnv(agent, {
      PI_CODING_AGENT_DIR: runtimeDir,
      PI_PACKAGE_DIR,
    }),
    args,
  });
  await pi.start();
  slot.client = pi;
  slot.pid = rpcClientPid(pi);
  if (!slot.pid) {
    const born = (await childrenOf(process.pid).catch(() => [])).filter((pid) => !beforeKids.has(pid));
    slot.pid = born[0] ?? null;
  }
  slot.lastUsedAt = Date.now();
  slot.bootedAt = spawnedAt;
  slot.readyAt = 0;
  watchSlotExit(slot, pi, agent, modelId);
  logEvent(
    "info",
    `Pi client started pid=${slot.pid || "?"} spawnMs=${Date.now() - spawnedAt}${sessionFile ? ` session=${sessionFile}` : ""}`,
  );
  return pi;
}

/**
 * First successful get_state after a spawn marks the process ready: Pi has
 * loaded skills, extensions and any --session file by then. This is the
 * number the "boot beat" in the UI should be sized from.
 * @param {PiSlot} slot
 */
function markSlotReady(slot) {
  if (slot.readyAt || !slot.bootedAt) return;
  slot.readyAt = Date.now();
  logEvent("info", `Pi ready agent=${slot.agentSlug} pid=${slot.pid || "?"} readyMs=${slot.readyAt - slot.bootedAt}`);
}

/**
 * Notice a Pi that dies on its own (OOM kill, crash). Without this the slot
 * looks warm until the next turn's get_state times out 30s later. Planned
 * stops clear `slot.client` before killing, so they never reach the body.
 * @param {PiSlot} slot
 * @param {RpcClient} pi
 */
function watchSlotExit(slot, pi, agent, modelId) {
  /** @type {import("node:child_process").ChildProcess | undefined} */
  const child = pi.process ?? pi.child ?? pi._process;
  if (!child || typeof child.once !== "function") return;
  const pid = slot.pid;
  child.once("exit", (code, signal) => {
    if (slot.client !== pi) return;
    slot.client = undefined;
    slot.pid = null;
    const wasBusy = slot.busy;
    logEvent(
      "warn",
      `Pi exited unexpectedly agent=${slot.agentSlug} pid=${pid || "?"} code=${code ?? "?"} signal=${signal ?? "-"} busy=${wasBusy}`,
    );
    void killTree(pid);
    if (wasBusy) return; // the turn's own error path restarts it
    const now = Date.now();
    slot.exits = (slot.exits || []).filter((ts) => now - ts < PI_REWARM_WINDOW_MS);
    slot.exits.push(now);
    if (slot.exits.length > PI_REWARM_MAX) {
      logEvent("error", `Pi agent=${slot.agentSlug} exited ${slot.exits.length}x in 10 min; not re-warming`);
      piPool.delete(slot.key);
      return;
    }
    const timer = setTimeout(() => {
      if (piPool.get(slot.key) !== slot || slot.client || slot.booting) return;
      void prewarmSlot(agent.id, modelId, "re-warm after exit");
    }, PI_REWARM_DELAY_MS);
    timer.unref?.();
  });
}

/**
 * Boot a Pi for an agent nobody is waiting on yet (startup, or after an
 * unexpected exit) so the next message starts warm. Never throws.
 * @param {string} agentRef id or slug
 * @param {string | null | undefined} modelId
 * @param {string} reason
 */
async function prewarmSlot(agentRef, modelId, reason) {
  if (!dbReady()) return false;
  try {
    const agent = await getAgent(agentRef);
    if (!agent) {
      logEvent("warn", `prewarm skipped (${reason}): unknown agent ${agentRef}`);
      return false;
    }
    await ensureCatalog();
    const wanted = modelId || defaultModelId || "";
    let model = findModel(modelCatalog ?? [], wanted);
    if (!model?.available && defaultModelId && defaultModelId !== wanted) {
      model = findModel(modelCatalog ?? [], defaultModelId);
    }
    if (!model?.available) {
      logEvent("warn", `prewarm skipped (${reason}): model ${wanted || "none"} unavailable for agent=${agent.slug}`);
      return false;
    }
    const startedAt = Date.now();
    const slot = await getOrCreatePiSlot(agent, model.id);
    // Force Pi to finish loading now, not when the first message arrives.
    if (slot.client) {
      await slot.client.getState();
      markSlotReady(slot);
    }
    logEvent("info", `prewarmed agent=${agent.slug} model=${model.id} pid=${slot.pid || "?"} readyMs=${Date.now() - startedAt} (${reason})`);
    return true;
  } catch (error) {
    logEvent("warn", `prewarm failed (${reason}) agent=${agentRef}: ${sanitizeError(error)}`);
    return false;
  }
}

/**
 * Remember which agent+model was used last so the next boot can pre-warm it.
 * @param {PiSlot} slot
 */
function rememberLastSlot(slot) {
  if (!dbReady()) return;
  void setSetting(PI_LAST_SLOT_SETTING, JSON.stringify({ agentId: slot.agentId, modelId: slot.modelId })).catch(() => {});
}

/**
 * Sequential so two cold starts never stack their memory spikes.
 */
async function prewarmOnBoot() {
  if (!dbReady()) return;
  /** @type {{ ref: string; modelId: string | null; reason: string }[]} */
  const targets = PI_PREWARM_AGENTS.map((ref) => ({ ref, modelId: null, reason: "PI_PREWARM_AGENTS" }));
  try {
    const raw = await getSetting(PI_LAST_SLOT_SETTING);
    const last = raw ? JSON.parse(raw) : null;
    if (last?.agentId) {
      targets.unshift({ ref: last.agentId, modelId: last.modelId || null, reason: "last used" });
    } else {
      // No record yet (first boot on this code): fall back to the newest Pi chat.
      const recent = await lastPiSession().catch(() => null);
      if (recent?.agentId) targets.unshift({ ref: recent.agentId, modelId: recent.modelId || null, reason: "latest session" });
    }
  } catch (error) {
    logEvent("warn", `prewarm lookup failed: ${sanitizeError(error)}`);
  }
  if (!targets.length) {
    logEvent("info", "prewarm: nothing to warm yet (no Pi session on record, PI_PREWARM_AGENTS empty)");
    return;
  }
  const seen = new Set();
  for (const target of targets.slice(0, PI_KEEP_WARM)) {
    if (seen.has(target.ref)) continue;
    seen.add(target.ref);
    await prewarmSlot(target.ref, target.modelId, `boot: ${target.reason}`);
  }
}

/**
 * Stop and restart a slot's client in place (used when getState() fails on
 * an otherwise-tracked slot), keeping the same pool key.
 * @param {PiSlot} slot
 */
async function restartSlotClient(slot, agent, modelId) {
  const oldPid = slot.pid || rpcClientPid(slot.client);
  if (slot.client) await slot.client.stop().catch(() => {});
  slot.client = undefined;
  slot.booting = undefined;
  slot.pid = null;
  await killTree(oldPid);
  if (!slot.booting) slot.booting = startSlotClient(slot, agent, modelId);
  try {
    return await slot.booting;
  } finally {
    slot.booting = undefined;
  }
}

/**
 * Get or start the pooled Pi process for this agent+model combo. Different
 * agents/models never share a process (or a lock), so switching one never
 * stalls another. The reservation lock only guards the cheap key lookup —
 * `pi.start()` itself runs outside it, so a slow cold start on one agent
 * never blocks another agent's slot reservation.
 * @param {{id:string,slug:string,name:string,rolePrompt:string,skillIds?:string[],mcpIds?:string[],skills?:object[],mcp?:object[]}} agent
 * @param {string} modelId
 * @param {{ sessionFile?: string | null }} [opts]
 * @returns {Promise<PiSlot>}
 */
async function getOrCreatePiSlot(agent, modelId, { sessionFile } = {}) {
  const slot = await withPoolReserve(async () => {
    const key = await agentBundleKey(agent, modelId);
    let s = piPool.get(key);
    if (!s) {
      s = {
        key,
        runtimeKey: `${agent.id}-${createHash("sha1").update(key).digest("hex").slice(0, 10)}`,
        client: undefined,
        booting: undefined,
        agentId: agent.id,
        agentSlug: agent.slug || agent.id,
        modelId,
        activeStudioSessionId: null,
        resumeSessionFile: sessionFile ?? null,
        forceNewPiSession: false,
        pid: null,
        busy: false,
        lock: Promise.resolve(),
        lastUsedAt: 0,
        exits: [],
        runtimeHash: "",
        bootedAt: 0,
        readyAt: 0,
        lastEnsure: null,
      };
      piPool.set(key, s);
    }
    return s;
  });
  slot.lastUsedAt = Date.now();
  if (slot.client) {
    await refreshSlotRuntime(slot, agent, modelId);
    evictIfNeeded();
    rememberLastSlot(slot);
    return slot;
  }
  if (!slot.booting) slot.booting = startSlotClient(slot, agent, modelId);
  try {
    await slot.booting;
  } finally {
    slot.booting = undefined;
  }
  evictIfNeeded();
  rememberLastSlot(slot);
  return slot;
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
 * Bind this studio chat to its slot's Pi session so history/context stay isolated.
 * @param {PiSlot} slot
 * @param {object} profile
 * @param {{ id: string; title: string; agentId?: string | null; piSessionId?: string | null; piSessionFile?: string | null }} session
 */
async function ensurePiOnSlot(slot, profile, session) {
  if (session.agentId && session.agentId !== profile.id) {
    await updateSession(session.id, { agentId: profile.id });
    session.agentId = profile.id;
  }
  if (!session.agentId) session.agentId = profile.id;

  let pi = slot.client;
  let state;
  const ensure = { getStateMs: 0, switchMs: 0, mode: "same" };
  slot.lastEnsure = ensure;
  const t0 = Date.now();
  try {
    if (!pi) throw new Error("slot has no live client");
    state = await pi.getState();
  } catch (error) {
    logEvent("error", `Pi get_state failed: ${sanitizeError(error)}`);
    slot.resumeSessionFile = session.piSessionFile ?? null;
    pi = await restartSlotClient(slot, profile, slot.modelId);
    state = await pi.getState();
    ensure.mode = "restart";
  }
  ensure.getStateMs = Date.now() - t0;
  markSlotReady(slot);

  if (session.piSessionFile && state.sessionFile === session.piSessionFile) {
    slot.activeStudioSessionId = session.id;
    slot.resumeSessionFile = session.piSessionFile;
    slot.forceNewPiSession = false;
    return pi;
  }

  if (session.piSessionFile) {
    const t1 = Date.now();
    try {
      const switched = await pi.switchSession(session.piSessionFile);
      ensure.switchMs = Date.now() - t1;
      if (!switched?.cancelled) {
        if (ensure.mode === "same") ensure.mode = "switch";
        slot.activeStudioSessionId = session.id;
        slot.resumeSessionFile = session.piSessionFile;
        slot.forceNewPiSession = false;
        return pi;
      }
    } catch (error) {
      ensure.switchMs = Date.now() - t1;
      logEvent("warn", `Pi switch_session failed: ${sanitizeError(error)}`);
    }
    logEvent("warn", `Pi session file missing, starting a new one for ${session.id}`);
  }

  const needNew = Boolean(slot.activeStudioSessionId || slot.forceNewPiSession);
  if (needNew) {
    const t2 = Date.now();
    const created = await pi.newSession();
    if (created?.cancelled) throw new Error("Could not start a new agent session.");
    state = await pi.getState();
    ensure.switchMs += Date.now() - t2;
  }
  if (ensure.mode === "same") ensure.mode = "new";
  slot.forceNewPiSession = false;

  const next = await updateSession(session.id, {
    piSessionId: state.sessionId,
    piSessionFile: state.sessionFile ?? null,
    agentId: profile.id,
  });
  session.piSessionId = next?.piSessionId ?? state.sessionId;
  session.piSessionFile = next?.piSessionFile ?? state.sessionFile ?? null;
  session.agentId = next?.agentId ?? profile.id;
  slot.activeStudioSessionId = session.id;
  slot.resumeSessionFile = session.piSessionFile ?? null;
  if (session.title && session.title !== "New chat") {
    await pi.setSessionName(session.title).catch(() => {});
  }
  return pi;
}

function publicSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    title: session.title,
    engine: session.engine || "pi",
    agyConversationId: session.agyConversationId ?? null,
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

/**
 * Set the default model for new sessions/turns. Cheap and lock-free — it
 * never touches the pi process pool, so this always returns instantly
 * regardless of how many turns are in flight elsewhere.
 */
async function setDefaultModel(modelId) {
  const catalog = await ensureCatalog();
  const entry = findModel(catalog, modelId);
  if (!entry) throw new Error(`Unknown model: ${modelId}`);
  if (!entry.available) throw new Error(`${entry.label} is missing its API key.`);
  defaultModelId = modelId;
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
  await ensureCatalog();
  const profile = await resolveAgentProfile(session.agentId);
  const resolvedModelId = modelId || session.modelId || defaultModelId;
  const entry = findModel(modelCatalog, resolvedModelId ?? "");
  if (!entry) throw new Error(`Unknown model: ${resolvedModelId}`);
  if (!entry.available) throw new Error(`${entry.label} is missing its API key.`);

  const t0 = Date.now();
  const slot = await getOrCreatePiSlot(profile, resolvedModelId, { sessionFile: session.piSessionFile });
  const slotMs = Date.now() - t0;
  const coldStart = slot.bootedAt >= t0;
  return withSlotLock(slot, async () => {
    turnsInFlight += 1;
    try {
      const tEnsure = Date.now();
      const pi = await ensurePiOnSlot(slot, profile, session);
      const ensureMs = Date.now() - tEnsure;
      const turn = createTurn();
      let assistantError = "";
      /** Per-turn timing, all relative to this call. Logged as `turn metrics`. */
      const timing = {
        coldStart,
        slotMs,
        ensureMs,
        getStateMs: slot.lastEnsure?.getStateMs ?? 0,
        switchMs: slot.lastEnsure?.switchMs ?? 0,
        sessionMode: slot.lastEnsure?.mode ?? "same",
        firstEventMs: null,
        firstTokenMs: null,
        firstToolMs: null,
        totalMs: 0,
        childrenAtEnd: null,
      };
      let promptedAt = 0;
      const unsubscribe = pi.onEvent((event) => {
        try {
          if (promptedAt) {
            const dt = Date.now() - promptedAt;
            if (timing.firstEventMs == null) timing.firstEventMs = dt;
            if (timing.firstTokenMs == null && (event.type === "message_update" || event.type === "message_start")) {
              timing.firstTokenMs = dt;
            }
            if (timing.firstToolMs == null && event.type === "tool_execution_start") timing.firstToolMs = dt;
          }
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
        promptedAt = Date.now();
        await pi.prompt(message, images?.length ? images : undefined);
        await settled;
        const text = (await pi.getLastAssistantText())?.trim() || turn.text.trim();
        if (text) {
          turn.text = text;
          if (!turn.blocks.some((block) => block.type === "text")) {
            turn.blocks.push({ type: "text", text });
          }
        }
        timing.totalMs = Date.now() - t0;
        if (process.platform === "linux" && slot.pid) {
          timing.childrenAtEnd = (await descendants(slot.pid).catch(() => [])).length;
        }
        turn.timing = timing;
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
    } finally {
      turnsInFlight = Math.max(0, turnsInFlight - 1);
    }
  });
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
      modelId: typeof modelId === "string" ? modelId : defaultModelId,
      agentId: agent.id,
    });
  }

  logEvent("info", `manage turn session=${session.id}: ${trimmed.slice(0, 120)}`);
  await insertMessage({
    sessionId: session.id,
    role: "user",
    content: trimmed,
    modelId: typeof modelId === "string" ? modelId : defaultModelId,
  });

  const profile = await resolveAgentProfile(session.agentId);
  const turn =
    session.engine === "agy"
      ? await chatAgy({
          message: trimmed,
          modelId: typeof modelId === "string" ? modelId : undefined,
          session,
          profile,
        })
      : await withAgentLock(session.agentId, () =>
          chat(trimmed, typeof modelId === "string" ? modelId : undefined, session),
        );
  await insertMessage({
    sessionId: session.id,
    role: "assistant",
    content: serializeTurn(turn),
    modelId: session.engine === "agy" ? (modelId || session.modelId || "gemini-3.8-flash-high") : defaultModelId,
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

/**
 * Wipe every pooled slot for a given agent (or all slots if none given).
 * Used for admin actions (settings/skills/mcp/agent changes) where every
 * live process needs to pick up the change — deferred through each slot's
 * own lock so an in-flight turn is never killed mid-prompt.
 * @param {{ agentId?: string }} [opts]
 */
async function resetPiPool({ agentId } = {}) {
  modelCatalog = null;
  const targets = [...piPool.values()].filter((slot) => !agentId || slot.agentId === agentId);
  await Promise.all(targets.map((slot) => stopSlot(slot)));
}

/** The models.json text Pi should see: bundled catalog plus saved provider base URLs. Pure. */
async function buildPiModelsJson() {
  const raw = JSON.parse(await readFile(BUNDLED_MODELS, "utf8"));
  const cavoti = secret("cavoti_base_url");
  const kimi = secret("kimi_base_url");
  const glm53 = secret("glm53_base_url");
  const opencodeGo = secret("opencode_go_base_url");
  if (cavoti) raw.providers.cavoti.baseUrl = normalizeCavotiBaseUrl(cavoti);
  if (kimi) raw.providers["kimi-k3"].baseUrl = kimi;
  if (glm53) raw.providers.glm53.baseUrl = glm53;
  if (opencodeGo) raw.providers["opencode-go"].baseUrl = opencodeGo;
  return JSON.stringify(raw, null, 2);
}

/**
 * @param {string} [text] prebuilt models.json; built when omitted
 */
async function writePiModels(text) {
  await mkdir(PI_AGENT_DIR, { recursive: true });
  const body = text ?? (await buildPiModelsJson());
  await writeFile(path.join(PI_AGENT_DIR, "models.json"), body);
  return body;
}

async function prepareDirs() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(WORKSPACE, { recursive: true });
  await mkdir(WORKSPACES_DIR, { recursive: true });
  await mkdir(agentWorkspace({ id: NEWPAGES_AGENT_ID, slug: "newpages" }), { recursive: true });
  await mkdir(agentWorkspace({ id: PACKAGE_AGENT_ID, slug: "package" }), { recursive: true });
  await mkdir(agentWorkspace({ id: SETTINGS_AGENT_ID, slug: "settings" }), { recursive: true });
  await mkdir(agentWorkspace({ id: AFA_AGENT_ID, slug: "afa-rate" }), { recursive: true });
  await mkdir(agentWorkspace({ id: SALES_AGENT_ID, slug: "sales" }), { recursive: true });
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
    setPiAliveGetter(() => [...piPool.values()].some((slot) => Boolean(slot.client)));
    startSampler();
    const idleSweep = setInterval(() => void sweepIdleSlots(), PI_IDLE_SWEEP_MS);
    idleSweep.unref?.();
    logEvent(
      "info",
      `resource sampler every 15s; Pi idle extras ${PI_SLOT_IDLE_MS / 1000}s, keep ${PI_KEEP_WARM} warm, pinned=${[...PI_PIN_AGENTS].join(",") || "none"}, memory soft/hard ${pct(PI_MEM_SOFT)}/${pct(PI_MEM_HARD)}`,
    );
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
    await healWebsiteWorkspace();
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
      const result = await ensureImpeccableForWebsite({ attach: false });
      logEvent(
        "info",
        result.skipped
          ? "impeccable skill already in library; not auto-attached"
          : "impeccable skill installed in library; not auto-attached",
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

  boot.step = "sales-mcp";
  try {
    if (dbReady()) {
      await ensureSalesMcp();
      logEvent("info", "sales-data mcp registered and attached to sales agent");
    }
  } catch (error) {
    logEvent("error", `sales-data mcp failed: ${sanitizeError(error)}`);
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

  boot.step = "stock";
  try {
    if (dbReady()) {
      await ensureStockSchema();
      if (!secret("stock_api_token")) {
        await rememberSecret("stock_api_token", randomBytes(24).toString("hex"));
      }
      logEvent("info", "stock inventory ready");
    }
  } catch (error) {
    logEvent("error", `stock schema failed: ${sanitizeError(error)}`);
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

  // Not part of boot: the health check must not wait on a Pi cold start.
  void prewarmOnBoot();
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

  if (pathname === "/test-agy" || pathname.startsWith("/api/test-agy")) {
    return handleTestAgy(req, res, url);
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
        resetPi: resetPiPool,
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

    if (req.method === "GET" && pathname === "/api/np/health") {
      json(res, 200, await newpagesHealth({ probe: url.searchParams.get("probe") || "" }));
      return;
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

    if (pathname === "/api/stock" || pathname.startsWith("/api/stock/")) {
      if (!hasStockAuth(req) && !authorized(req)) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }
      if (!dbReady()) {
        json(res, 503, { error: "Database is not connected" });
        return;
      }
      try {
        if (req.method === "GET" && pathname === "/api/stock") {
          json(res, 200, { items: await listStockItems() });
          return;
        }
        if (req.method === "POST" && pathname === "/api/stock") {
          const body = JSON.parse((await readBody(req)) || "{}");
          json(res, 200, { item: await setStockItem(body) });
          return;
        }
        if (req.method === "POST" && pathname === "/api/stock/bulk") {
          const body = JSON.parse((await readBody(req)) || "{}");
          json(res, 200, await setStockItems(body));
          return;
        }
        if (req.method === "POST" && pathname === "/api/stock/seed") {
          const body = JSON.parse((await readBody(req)) || "{}");
          json(res, 200, await seedStockItems(body));
          return;
        }
        if (req.method === "POST" && pathname === "/api/stock/adjust") {
          const body = JSON.parse((await readBody(req)) || "{}");
          json(res, 200, { item: await adjustStockItem(body) });
          return;
        }
        if (req.method === "GET" && pathname === "/api/stock/movements") {
          const productKey = url.searchParams.get("productKey") || undefined;
          const limit = url.searchParams.get("limit") || undefined;
          json(res, 200, { movements: await listStockMovements({ productKey, limit }) });
          return;
        }
      } catch (error) {
        json(res, 400, { error: sanitizeError(error) });
        return;
      }
      json(res, 404, { error: "Not found" });
      return;
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
      await resetPiPool();
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
      // Railway hits this on a 30s timer. snapshot() walks git + the workspace and
      // will fail the check (SIGTERM mid-turn) if a fetch hangs. Keep this cheap.
      json(res, 200, {
        ok: true,
        boot,
        db: { connected: dbReady() },
        host: hostPublic(),
        defaultModelId,
        piPoolSize: piPool.size,
        piPoolMax: MAX_PI_SLOTS,
        piKeepWarm: PI_KEEP_WARM,
        piWarm: poolWarmSummary(),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/metrics") {
      json(res, 200, await metricsPayload());
      return;
    }

    if (req.method === "GET" && pathname === "/api/debug") {
      // ?limit=200&level=warn&since=2026-09-05T00:00:00Z&match=prewarm
      const body = await snapshot();
      body.dbEvents = await loadRecentFromDb({
        limit: url.searchParams.get("limit") || 200,
        level: url.searchParams.get("level"),
        since: url.searchParams.get("since"),
        match: url.searchParams.get("match"),
      });
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

    {
      const contextMatch = pathname.match(/^\/api\/agents\/([^/]+)\/context$/);
      if (contextMatch && req.method === "GET") {
        if (!dbReady()) {
          json(res, 503, { error: "Database is not connected" });
          return;
        }
        const existing = await getAgent(decodeURIComponent(contextMatch[1]));
        if (!existing) {
          json(res, 404, { error: "Agent not found" });
          return;
        }
        json(
          res,
          200,
          await previewContextPack(existing, {
            modelId: typeof existing.modelId === "string" ? existing.modelId : defaultModelId,
          }),
        );
        return;
      }
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
          await resetPiPool({ agentId: existing.id });
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
          await resetPiPool({ agentId: existing.id });
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
          await resetPiPool();
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
          await resetPiPool();
          json(res, 200, { server: publicMcp(server, { secrets: true }) });
          return;
        }
        if (req.method === "DELETE") {
          await deleteMcpServer(existing.id);
          await resetPiPool();
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
      const requestedEngine =
        body.engine === "agy" ? "agy" : body.engine === "pi" ? "pi" : agent.engine || "pi";
      const session = await createSession({
        title,
        modelId:
          typeof body.modelId === "string"
            ? body.modelId
            : requestedEngine === "agy"
              ? "gemini-3.8-flash-high"
              : defaultModelId,
        agentId: agent.id,
        engine: requestedEngine,
        agyConversationId: typeof body.agyConversationId === "string" ? body.agyConversationId : undefined,
      });
      logEvent("info", `session created ${session.id} (engine=${session.engine || "pi"})`);
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
          const patch = {};
          if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim();
          if (body.engine === "agy" || body.engine === "pi") patch.engine = body.engine;
          if (typeof body.modelId === "string" && body.modelId.trim()) patch.modelId = body.modelId.trim();
          if (typeof body.agyConversationId === "string" && body.agyConversationId.trim()) {
            patch.agyConversationId = body.agyConversationId.trim();
          }
          if (!Object.keys(patch).length) {
            json(res, 400, { error: "title, engine, or modelId is required" });
            return;
          }
          const updated = await updateSession(sessionId, patch);
          if (patch.title) {
            for (const slot of piPool.values()) {
              if (slot.activeStudioSessionId === sessionId && slot.client) {
                await slot.client.setSessionName(patch.title).catch(() => {});
              }
            }
          }
          json(res, 200, { session: publicSession(updated) });
          return;
        }

        if (req.method === "DELETE") {
          await deleteSession(sessionId);
          for (const slot of piPool.values()) {
            if (slot.activeStudioSessionId === sessionId) {
              slot.activeStudioSessionId = null;
              slot.forceNewPiSession = true;
            }
          }
          json(res, 200, { ok: true, id: sessionId });
          return;
        }
      }
    }

    if (req.method === "GET" && pathname === "/api/models") {
      const catalog = await ensureCatalog();
      json(res, 200, {
        activeModelId: defaultModelId,
        models: publicModels(catalog),
        agyModels: AGY_MODELS,
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/model") {
      const { modelId } = JSON.parse((await readBody(req)) || "{}");
      if (!modelId || typeof modelId !== "string") {
        json(res, 400, { error: "modelId is required" });
        return;
      }
      const entry = await setDefaultModel(modelId);
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
        const requestedEngine =
          body.engine === "agy" ? "agy" : body.engine === "pi" ? "pi" : agent.engine || "pi";
        session = await createSession({
          modelId:
            typeof modelId === "string"
              ? modelId
              : requestedEngine === "agy"
                ? "gemini-3.8-flash-high"
                : defaultModelId,
          agentId: agent.id,
          engine: requestedEngine,
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
      const chatPrompt = await enrichRestartPrompt(prompt, profile);
      const storedUser =
        [trimmed, attachmentChatMarkup(packed.files)].filter(Boolean).join("\n\n") ||
        (packed.files.length ? `Attached: ${attachmentSummary(packed.files)}` : prompt);
      const turnStartedAt = Date.now();

      logEvent("info", `chat session=${session.id} (engine=${session.engine || "pi"}): ${storedUser.slice(0, 120)}`);
      await insertMessage({
        sessionId: session.id,
        role: "user",
        content: storedUser,
        modelId: typeof modelId === "string" ? modelId : session.modelId || defaultModelId,
      });
      let titleSetThisTurn = false;
      if (session.title === "New chat") {
        const title = titleFromMessage(trimmed || packed.files[0]?.name || "New chat");
        const updated = await updateSession(session.id, {
          title,
          modelId: session.engine === "agy" ? (modelId || session.modelId || "gemini-3.8-flash-high") : defaultModelId,
        });
        if (updated) {
          session = updated;
          titleSetThisTurn = true;
        }
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

      const persister = createTurnPersister(
        session.id,
        session.engine === "agy" ? (modelId || session.modelId || "gemini-3.8-flash-high") : defaultModelId,
      );
      /** @type {ReturnType<typeof createTurn>} */
      let lastTurn = createTurn();
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(`: ping ${Date.now()}\n\n`);
      }, 15000);

      try {
        const onEvent = (event, liveTurn) => {
          if (liveTurn) lastTurn = liveTurn;
          if (!res.writableEnded) writeSse(res, event);
          if (liveTurn) persister.schedule(liveTurn, true);
        };
        const runOnce = (text, images) =>
          session.engine === "agy"
            ? chatAgy({
                message: text,
                modelId: typeof modelId === "string" ? modelId : session.modelId || undefined,
                session,
                profile,
                onEvent,
                images,
              })
            : chat(text, typeof modelId === "string" ? modelId : undefined, session, onEvent, images);

        // Same-agent turns (and the publish/journal work below, which shares
        // the agent's git workspace) serialize per agent; different agents
        // run fully concurrently — see withAgentLock.
        await withAgentLock(profile.id, async () => {
          let turn = await runOnce(chatPrompt, packed.images);
          lastTurn = turn;
          const timing = turn.timing ?? null;
          let autoContinues = 0;
          while (autoContinues < 2 && needsAutoContinue(turn)) {
            autoContinues += 1;
            turn.blocks.push({ type: "note", text: "Continuing…" });
            lastTurn = turn;
            if (!res.writableEnded) writeSse(res, { type: "note", text: "Continuing…" });
            persister.schedule(turn, true);
            const next = await runOnce(AUTO_CONTINUE_PROMPT);
            turn = mergeTurns(turn, next);
            lastTurn = turn;
          }

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

          const active =
            session.engine === "agy"
              ? AGY_MODELS.find((m) => m.id === (modelId || session.modelId)) || AGY_MODELS[0]
              : defaultModelId
                ? findModel(modelCatalog ?? [], defaultModelId)
                : null;
          if (!res.writableEnded) {
            writeSse(res, {
              type: "done",
              reply: turn.text,
              blocks: JSON.parse(serializeTurn(turn)).blocks,
              sessionId: session.id,
              session: publicSession({ ...session, preview: turn.text || storedUser }),
              activeModelId: active?.id ?? defaultModelId,
              activeModel: active
                ? { id: active.id, label: active.label, provider: active.provider, model: active.model }
                : null,
            });
          }
          if (host && !res.writableEnded) writeSse(res, { type: "host", host });

          // Host bookkeeping runs after the reply is on the wire. It stays
          // inside the agent lock so the next turn sees the journal.
          await appendStateJournal(profile, {
            sessionId: session.id,
            text: turn.text,
            host,
            startedAt: turnStartedAt,
          }).catch((error) => logEvent("warn", `STATE.md journal failed: ${sanitizeError(error)}`));
          if (titleSetThisTurn && session.title && session.engine !== "agy") {
            for (const slot of piPool.values()) {
              if (slot.activeStudioSessionId === session.id && slot.client) {
                await slot.client.setSessionName(session.title).catch(() => {});
              }
            }
          }
          logEvent("info", "turn metrics", {
            ...turnMetrics(turn, { autoContinues, timing }),
            wallMs: Date.now() - turnStartedAt,
            agent: profile.slug,
            engine: session.engine || "pi",
          });
        });
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
  logEvent("info", turnsInFlight ? `shutdown during ${turnsInFlight} in-flight turn(s)` : "shutdown");
  stopSampler();
  await Promise.allSettled([...piPool.values()].map((slot) => stopSlot(slot)));
  await closeBrowsers().catch(() => {});
  await closeDb().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
