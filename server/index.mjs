import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { closeDb, connectDb, dbReady, getSetting, insertMessage, listMessages, setSetting } from "./db.mjs";
import { envFlags, loadRecentFromDb, logEvent, railwayMeta, recentEvents } from "./debug.mjs";
import { listWorkspaceFiles } from "./files.mjs";
import { getGitStatus, initWorkspace, syncWorkspace } from "./github.mjs";
import { findModel, resolveModelCredentials } from "./models.mjs";
import {
  BUNDLED_MODELS,
  DATA_DIR,
  DIST_DIR,
  PI_AGENT_DIR,
  PI_CLI_PATH,
  PI_PACKAGE_DIR,
  ROLE_FILE,
  ROOT,
  STORAGE,
  WORKSPACE,
} from "./paths.mjs";

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

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
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

function wantsAuth(pathname) {
  if (!process.env.APP_TOKEN?.trim()) return false;
  return pathname.startsWith("/api/") && pathname !== "/api/health" && pathname !== "/api/debug";
}

function authorized(req) {
  const token = process.env.APP_TOKEN?.trim();
  if (!token) return true;
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${token}`;
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
    paths: { dataDir: DATA_DIR, workspace: WORKSPACE, storage: STORAGE, pi: PI_AGENT_DIR },
    db: { connected: dbReady() },
    git,
    fileCount: files.length,
    activeModelId,
    modelsConfigured: modelCatalog?.filter((entry) => entry.available).length ?? 0,
    piClient: Boolean(client),
    env: envFlags(),
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

async function getClient() {
  if (client) return client;
  if (!booting) {
    booting = (async () => {
      const resolved = await resolveModelCredentials();
      modelCatalog = resolved.models;
      activeModelId = activeModelId ?? resolved.defaultModelId;
      const active = findModel(modelCatalog, activeModelId ?? "");
      if (!active?.available) {
        throw new Error("No model configured. Set CAVOTI_API_KEY and/or KIMI_API_KEY.");
      }

      logEvent("info", `starting Pi ${active.provider}/${active.model}`);
      const pi = new RpcClient({
        cliPath: PI_CLI_PATH,
        cwd: WORKSPACE,
        provider: active.provider,
        model: active.model,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: PI_AGENT_DIR,
          PI_PACKAGE_DIR,
          ...resolved.env,
        },
        args: [
          "--append-system-prompt",
          ROLE_FILE,
          "--session-dir",
          STORAGE,
          "--session-id",
          "website-dev",
          "--name",
          "Website Dev Agent",
          "--provider",
          active.provider,
          "--model",
          active.model,
        ],
      });
      await pi.start();
      client = pi;
      logEvent("info", "Pi client started");
      return pi;
    })();
  }
  return booting;
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

async function chat(message, modelId) {
  if (modelId) await switchModel(modelId);
  const pi = await getClient();
  const events = await pi.promptAndWait(message, undefined, 300_000);
  const text = await pi.getLastAssistantText();
  if (text?.trim()) return text;

  const assistantError = [...events]
    .reverse()
    .find((event) => event.type === "message_end" && event.message?.role === "assistant")
    ?.message?.errorMessage;
  if (assistantError) throw new Error(assistantError);
  throw new Error("No response from agent.");
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

async function writePiModels() {
  await mkdir(PI_AGENT_DIR, { recursive: true });
  const raw = JSON.parse(await readFile(BUNDLED_MODELS, "utf8"));
  if (process.env.CAVOTI_BASE_URL?.trim()) raw.providers.cavoti.baseUrl = process.env.CAVOTI_BASE_URL.trim();
  if (process.env.KIMI_BASE_URL?.trim()) raw.providers["kimi-k3"].baseUrl = process.env.KIMI_BASE_URL.trim();
  await writeFile(path.join(PI_AGENT_DIR, "models.json"), JSON.stringify(raw, null, 2));
}

async function prepareDirs() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(WORKSPACE, { recursive: true });
  await mkdir(STORAGE, { recursive: true });
  await mkdir(PI_AGENT_DIR, { recursive: true });
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
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  if (wantsAuth(pathname) && !authorized(req)) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }

  try {
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

    if (req.method === "GET" && pathname === "/api/messages") {
      json(res, 200, { messages: dbReady() ? await listMessages() : [] });
      return;
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
      const entry = await switchModel(modelId);
      json(res, 200, {
        activeModelId: entry.id,
        activeModel: { id: entry.id, label: entry.label, provider: entry.provider, model: entry.model },
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/chat") {
      const { message, modelId } = JSON.parse((await readBody(req)) || "{}");
      if (!message || typeof message !== "string") {
        json(res, 400, { error: "message is required" });
        return;
      }
      const trimmed = message.trim();
      logEvent("info", `chat: ${trimmed.slice(0, 120)}`);
      if (dbReady()) await insertMessage({ role: "user", content: trimmed, modelId: modelId ?? activeModelId });
      const reply = await chat(trimmed, typeof modelId === "string" ? modelId : undefined);
      if (dbReady()) await insertMessage({ role: "assistant", content: reply, modelId: activeModelId });
      let git = null;
      try {
        git = await syncWorkspace(`Website Dev Agent: ${trimmed.slice(0, 72)}`);
      } catch (error) {
        logEvent("error", `git sync failed: ${sanitizeError(error)}`);
        git = await getGitStatus().catch(() => null);
      }
      const active = activeModelId ? findModel(modelCatalog ?? [], activeModelId) : null;
      json(res, 200, {
        reply,
        activeModelId,
        activeModel: active
          ? { id: active.id, label: active.label, provider: active.provider, model: active.model }
          : null,
        git,
      });
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
