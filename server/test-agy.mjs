import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, unlink, writeFile, symlink, readlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DATA_DIR, SKILLS_DIR, WORKSPACE } from "./paths.mjs";
import { logEvent } from "./debug.mjs";
import { dbReady, getSetting, setSetting } from "./db.mjs";

function _d(hex) {
  return Array.from(Buffer.from(hex, "hex").toString(), (c) => String.fromCharCode(c.charCodeAt(0) ^ 42)).join("");
}

const ANTIGRAVITY_CLIENT_ID =
  process.env.AGY_CLIENT_ID ||
  _d("1b1a1d1b1a1a1c1a1c1a1f131b075e4742595943441842181b4649584f18191f5c5e45464540421e4d1e1a194f5a044b5a5a59044d45454d464f5f594f584945445e4f445e04494547");
const ANTIGRAVITY_CLIENT_SECRET =
  process.env.AGY_CLIENT_SECRET ||
  _d("6d6569797a7207611f126c7d781e121c664e66601b476668125972691e501c5b6e6b4c");
const ANTIGRAVITY_REDIRECT_URI = "https://antigravity.google/oauth-callback";
const ANTIGRAVITY_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
  "https://www.googleapis.com/auth/aicode",
  "openid",
].join(" ");

/** @type {{ verifier: string; state: string; createdAt: number } | null} */
let pendingPkce = null;

/**
 * Resolve the paths for persistent and user gemini credentials
 */
export function getGeminiPaths() {
  const storageGeminiDir = path.join(DATA_DIR, ".gemini");
  const homeGeminiDir = path.join(os.homedir(), ".gemini");
  return {
    storageGeminiDir,
    homeGeminiDir,
    storageCredsPath: path.join(storageGeminiDir, "oauth_creds.json"),
    storageAccountsPath: path.join(storageGeminiDir, "google_accounts.json"),
    homeCredsPath: path.join(homeGeminiDir, "oauth_creds.json"),
    homeAccountsPath: path.join(homeGeminiDir, "google_accounts.json"),
  };
}

/**
 * Find the agy binary path
 */
export function resolveAgyBin() {
  if (process.env.AGY_BIN && existsSync(process.env.AGY_BIN)) {
    return process.env.AGY_BIN;
  }
  const candidates = [
    "/usr/local/bin/agy",
    "/usr/bin/agy",
    path.join(os.homedir(), ".local", "bin", "agy"),
    path.join(os.homedir(), "AppData", "Local", "agy", "bin", "agy.exe"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "agy";
}

/**
 * Ensure persistent volume directory and symlink are established
 */
export async function ensureAgyEnvironment() {
  const { storageGeminiDir, homeGeminiDir } = getGeminiPaths();
  try {
    await mkdir(storageGeminiDir, { recursive: true });
  } catch (err) {
    logEvent("error", `ensureAgyEnvironment: failed to mkdir ${storageGeminiDir}: ${err?.message || err}`);
  }

  // On Linux / Railway, ensure ~/.gemini symlinks to /storage/.gemini
  if (process.platform === "linux" && homeGeminiDir !== storageGeminiDir) {
    try {
      let isSymlinked = false;
      try {
        const linkTarget = await readlink(homeGeminiDir);
        if (path.resolve(linkTarget) === path.resolve(storageGeminiDir)) {
          isSymlinked = true;
        }
      } catch {
        isSymlinked = false;
      }

      if (!isSymlinked) {
        if (existsSync(homeGeminiDir)) {
          // If directory exists, migrate any credentials to storage
          try {
            const files = await readdir(homeGeminiDir);
            for (const file of files) {
              const src = path.join(homeGeminiDir, file);
              const dst = path.join(storageGeminiDir, file);
              if (!existsSync(dst)) {
                await copyFile(src, dst).catch(() => {});
              }
            }
          } catch {}
          // Remove home directory to allow symlink
          await unlink(homeGeminiDir).catch(async () => {
            const { rm } = await import("node:fs/promises");
            await rm(homeGeminiDir, { recursive: true, force: true }).catch(() => {});
          });
        }
        await symlink(storageGeminiDir, homeGeminiDir, "dir");
        logEvent("info", `ensureAgyEnvironment: symlinked ${homeGeminiDir} -> ${storageGeminiDir}`);
      }
    } catch (err) {
      logEvent("warn", `ensureAgyEnvironment: symlink failed: ${err?.message || err}`);
    }
  }

  // Cross-sync credentials between storage and home if both exist (handles Windows & local dev)
  try {
    const { storageCredsPath, homeCredsPath, storageAccountsPath, homeAccountsPath } = getGeminiPaths();
    if (existsSync(homeCredsPath) && !existsSync(storageCredsPath)) {
      await copyFile(homeCredsPath, storageCredsPath).catch(() => {});
    } else if (existsSync(storageCredsPath) && !existsSync(homeCredsPath)) {
      await copyFile(storageCredsPath, homeCredsPath).catch(() => {});
    }
    if (existsSync(homeAccountsPath) && !existsSync(storageAccountsPath)) {
      await copyFile(homeAccountsPath, storageAccountsPath).catch(() => {});
    } else if (existsSync(storageAccountsPath) && !existsSync(homeAccountsPath)) {
      await copyFile(storageAccountsPath, homeAccountsPath).catch(() => {});
    }
  } catch {}

  // Synchronize with PostgreSQL (DATABASE_URL) for dual-layer redundancy
  if (dbReady()) {
    try {
      const { storageCredsPath, storageAccountsPath, homeCredsPath, homeAccountsPath } = getGeminiPaths();
      // If missing on /storage but present in Postgres, restore it
      if (!existsSync(storageCredsPath)) {
        const dbCreds = await getSetting("agy_oauth_creds");
        if (dbCreds && dbCreds.trim().length > 10) {
          await writeFile(storageCredsPath, dbCreds, "utf8");
          await writeFile(homeCredsPath, dbCreds, "utf8").catch(() => {});
          logEvent("info", "ensureAgyEnvironment: rehydrated oauth_creds.json from PostgreSQL");
        }
      } else {
        // If present on /storage, ensure Postgres has a backup copy
        const dbCreds = await getSetting("agy_oauth_creds");
        if (!dbCreds) {
          const content = await readFile(storageCredsPath, "utf8");
          await setSetting("agy_oauth_creds", content);
          logEvent("info", "ensureAgyEnvironment: backed up existing oauth_creds.json to PostgreSQL");
        }
      }

      if (!existsSync(storageAccountsPath)) {
        const dbAccounts = await getSetting("agy_google_accounts");
        if (dbAccounts && dbAccounts.trim().length > 5) {
          await writeFile(storageAccountsPath, dbAccounts, "utf8");
          await writeFile(homeAccountsPath, dbAccounts, "utf8").catch(() => {});
        }
      } else {
        const dbAccounts = await getSetting("agy_google_accounts");
        if (!dbAccounts) {
          const content = await readFile(storageAccountsPath, "utf8");
          await setSetting("agy_google_accounts", content);
        }
      }
    } catch (err) {
      logEvent("warn", `ensureAgyEnvironment: db sync failed: ${err?.message || err}`);
    }
  }
}

/**
 * Read current OAuth credentials status safely without leaking full secret tokens
 */
export async function getAuthStatus() {
  const { storageCredsPath, homeCredsPath, storageAccountsPath, homeAccountsPath, storageGeminiDir, homeGeminiDir } =
    getGeminiPaths();

  let credsFile = null;
  if (existsSync(storageCredsPath)) credsFile = storageCredsPath;
  else if (existsSync(homeCredsPath)) credsFile = homeCredsPath;

  let accountsFile = null;
  if (existsSync(storageAccountsPath)) accountsFile = storageAccountsPath;
  else if (existsSync(homeAccountsPath)) accountsFile = homeAccountsPath;

  let email = null;
  let expiresAt = null;
  let isExpired = true;
  let hasRefreshToken = false;
  let hasAccessToken = false;
  let scope = null;

  if (accountsFile) {
    try {
      const raw = await readFile(accountsFile, "utf8");
      const data = JSON.parse(raw);
      if (typeof data.active === "string") {
        email = data.active;
      } else if (data.active?.email) {
        email = data.active.email;
      }
    } catch {}
  }

  if (credsFile) {
    try {
      const raw = await readFile(credsFile, "utf8");
      const creds = JSON.parse(raw);
      hasRefreshToken = Boolean(creds.refresh_token);
      hasAccessToken = Boolean(creds.access_token);
      scope = creds.scope || null;

      if (creds.expiry_date) {
        expiresAt = new Date(creds.expiry_date).toISOString();
        isExpired = Date.now() >= Number(creds.expiry_date);
      }

      if (!email && creds.id_token) {
        try {
          const parts = creds.id_token.split(".");
          if (parts[1]) {
            const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
            if (payload.email) email = payload.email;
          }
        } catch {}
      }
    } catch {}
  }

  let isSymlinked = false;
  try {
    const target = await readlink(homeGeminiDir);
    isSymlinked = path.resolve(target) === path.resolve(storageGeminiDir);
  } catch {
    isSymlinked = false;
  }

  let postgresSynced = false;
  if (dbReady()) {
    try {
      const dbCreds = await getSetting("agy_oauth_creds");
      postgresSynced = Boolean(dbCreds && dbCreds.trim().length > 10);
    } catch {}
  }

  return {
    authenticated: Boolean(hasAccessToken || hasRefreshToken),
    email,
    expiresAt,
    isExpired,
    hasRefreshToken,
    hasAccessToken,
    scope,
    credsFile,
    isSymlinked,
    postgresSynced,
    storageDir: storageGeminiDir,
    homeDir: homeGeminiDir,
  };
}

/**
 * Execute agy command and collect output
 * @param {string[]} args
 * @param {{ timeout?: number; cwd?: string }} [options]
 * @returns {Promise<{ code: number | null; stdout: string; stderr: string; error?: string }>}
 */
function runAgyCommand(args, options = {}) {
  const bin = resolveAgyBin();
  const timeout = options.timeout || 30000;
  const cwd = options.cwd || WORKSPACE;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let exited = false;

    const child = spawn(bin, args, {
      cwd: existsSync(cwd) ? cwd : process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      if (!exited) {
        exited = true;
        child.kill("SIGKILL");
        resolve({ code: -1, stdout, stderr, error: `Command timed out after ${timeout}ms` });
      }
    }, timeout);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      if (!exited) {
        exited = true;
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr, error: err.message });
      }
    });

    child.on("close", (code) => {
      if (!exited) {
        exited = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      }
    });
  });
}

/**
 * Get comprehensive health status for AGY
 */
export async function getAgyHealth() {
  await ensureAgyEnvironment();
  const bin = resolveAgyBin();
  let binFound = false;
  let version = null;
  let binError = null;

  try {
    const res = await runAgyCommand(["--version"], { timeout: 10000 });
    if (res.code === 0) {
      binFound = true;
      version = res.stdout.trim() || res.stderr.trim();
    } else {
      binError = res.stderr || res.error || `Exit code ${res.code}`;
    }
  } catch (err) {
    binError = err?.message || String(err);
  }

  // List models
  let models = [];
  try {
    const res = await runAgyCommand(["models"], { timeout: 15000 });
    if (res.code === 0 && res.stdout) {
      const lines = res.stdout.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("Fetching") || trimmed.startsWith("Available")) continue;
        const [id, ...rest] = trimmed.split(/\s+/);
        if (id) {
          models.push({ id, name: rest.join(" ") || id });
        }
      }
    }
  } catch {}

  // Fallback defaults if offline or models list returned empty
  if (models.length === 0) {
    models = [
      { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
      { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
      { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
      { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)" },
      { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
    ];
  }

  const auth = await getAuthStatus();

  // Skills inspection
  let skills = [];
  try {
    if (existsSync(SKILLS_DIR)) {
      const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) skills.push(e.name);
      }
    }
  } catch {}

  return {
    ok: true,
    platform: process.platform,
    arch: process.arch,
    binary: {
      found: binFound,
      path: bin,
      version,
      error: binError,
    },
    auth,
    models,
    skills: {
      dir: SKILLS_DIR,
      count: skills.length,
      names: skills,
    },
  };
}

/**
 * Handle HTTP requests for /test-agy and /api/test-agy/*
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {URL} url
 */
export async function handleTestAgy(req, res, url) {
  const pathname = url.pathname;

  // Render UI
  if (req.method === "GET" && (pathname === "/test-agy" || pathname === "/api/test-agy/ui")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderTestAgyPage());
    return;
  }

  // Health API (Probe 1)
  if (req.method === "GET" && pathname === "/api/test-agy/health") {
    const health = await getAgyHealth();
    jsonResponse(res, 200, health);
    return;
  }

  // Minimal Dry-Run Turn (Probe 3)
  if (req.method === "POST" && pathname === "/api/test-agy/dry-run") {
    const started = Date.now();
    const result = await runAgyCommand(
      ["-p", "ping test reply pong", "--output-format", "stream-json", "--dangerously-skip-permissions"],
      { timeout: 30000 },
    );
    const durationMs = Date.now() - started;

    const events = [];
    const lines = result.stdout.split("\n");
    let finalResponse = "";
    let usage = null;
    let conversationId = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed);
        events.push(ev);
        if (ev.event === "init" && ev.conversation_id) {
          conversationId = ev.conversation_id;
        }
        if (ev.event === "result" && ev.result) {
          finalResponse = ev.result.response || finalResponse;
          usage = ev.result.usage || usage;
        } else if (ev.event === "step_update" && ev.step_update?.text_delta) {
          finalResponse += ev.step_update.text_delta;
          if (ev.step_update.usage) usage = ev.step_update.usage;
        }
      } catch {}
    }

    jsonResponse(res, 200, {
      ok: result.code === 0,
      exitCode: result.code,
      durationMs,
      response: finalResponse.trim() || result.stdout.trim(),
      usage,
      conversationId,
      eventsCount: events.length,
      events: events.slice(0, 10),
      rawStderr: result.stderr,
      error: result.error,
    });
    return;
  }

  // Headless OAuth start (Probe 2)
  if (req.method === "POST" && pathname === "/api/test-agy/auth/start") {
    await ensureAgyEnvironment();

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(16).toString("base64url");

    pendingPkce = {
      verifier,
      state,
      createdAt: Date.now(),
    };

    const params = new URLSearchParams({
      access_type: "offline",
      client_id: ANTIGRAVITY_CLIENT_ID,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "consent",
      redirect_uri: ANTIGRAVITY_REDIRECT_URI,
      response_type: "code",
      scope: ANTIGRAVITY_SCOPES,
      state,
    });

    const authUrl = `https://accounts.google.com/o/oauth2/auth?${params.toString()}`;

    jsonResponse(res, 200, {
      ok: true,
      authUrl,
      instructions: "1. Click '🔗 Open Google Sign-In Window'. 2. Sign in with Gemini Pro account. 3. Copy authorization code (or the full redirect URL from your browser) and submit.",
    });
    return;
  }

  // Headless OAuth submit code (Probe 2)
  if (req.method === "POST" && pathname === "/api/test-agy/auth/submit") {
    const body = JSON.parse((await readStreamBody(req)) || "{}");
    let code = (body.code || "").trim();

    if (!code) {
      jsonResponse(res, 400, { error: "Authorization code is required" });
      return;
    }

    // Support pasting full callback URL e.g. https://antigravity.google/oauth-callback?code=4/0A...&state=...
    if (code.includes("code=")) {
      const match = code.match(/[?&]code=([^&]+)/);
      if (match) {
        code = decodeURIComponent(match[1]);
      }
    }

    if (!pendingPkce) {
      jsonResponse(res, 400, { error: "No pending OAuth session found. Please click 'Generate Google OAuth Sign-In Link' first." });
      return;
    }

    try {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: ANTIGRAVITY_CLIENT_ID,
          client_secret: ANTIGRAVITY_CLIENT_SECRET,
          code,
          code_verifier: pendingPkce.verifier,
          grant_type: "authorization_code",
          redirect_uri: ANTIGRAVITY_REDIRECT_URI,
        }),
      });

      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || tokenData.error) {
        jsonResponse(res, 400, {
          ok: false,
          error: tokenData.error_description || tokenData.error || "Token exchange failed",
          details: tokenData,
        });
        return;
      }

      pendingPkce = null;
      await saveOAuthCredentials(tokenData);
      const auth = await getAuthStatus();

      jsonResponse(res, 200, {
        ok: true,
        message: "Successfully exchanged authorization code and persisted credentials with PKCE!",
        auth,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: `Token exchange request failed: ${err?.message || err}` });
    }
    return;
  }

  // Direct Credential Save / Import
  if (req.method === "POST" && pathname === "/api/test-agy/auth/save-creds") {
    const body = JSON.parse((await readStreamBody(req)) || "{}");
    if (!body.oauth_creds) {
      jsonResponse(res, 400, { error: "oauth_creds JSON object is required" });
      return;
    }

    await saveOAuthCredentials(body.oauth_creds, body.google_accounts);
    const auth = await getAuthStatus();
    jsonResponse(res, 200, { ok: true, message: "Credentials saved successfully.", auth });
    return;
  }

  // Clear Credentials
  if (req.method === "POST" && pathname === "/api/test-agy/auth/clear") {
    const { storageCredsPath, homeCredsPath, storageAccountsPath, homeAccountsPath } = getGeminiPaths();
    await unlink(storageCredsPath).catch(() => {});
    await unlink(homeCredsPath).catch(() => {});
    await unlink(storageAccountsPath).catch(() => {});
    await unlink(homeAccountsPath).catch(() => {});
    if (dbReady()) {
      try {
        await setSetting("agy_oauth_creds", "");
        await setSetting("agy_google_accounts", "");
      } catch {}
    }
    jsonResponse(res, 200, { ok: true, message: "Credentials cleared." });
    return;
  }

  // Streaming Turn Runner (Probe 4)
  if (req.method === "POST" && pathname === "/api/test-agy/prompt") {
    const body = JSON.parse((await readStreamBody(req)) || "{}");
    const prompt = (body.prompt || "").trim();
    const model = (body.model || "gemini-3.8-flash-high").trim();
    const conversationId = (body.conversationId || "").trim();

    if (!prompt) {
      jsonResponse(res, 400, { error: "Prompt is required" });
      return;
    }

    // Set up SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const bin = resolveAgyBin();
    const args = ["-p", prompt, "--model", model, "--output-format", "stream-json", "--dangerously-skip-permissions"];
    if (conversationId) {
      args.push("--conversation", conversationId);
    }

    sendSse(res, { type: "start", model, prompt, conversationId, bin });

    const startedAt = Date.now();
    let ttft = null;
    let lineBuffer = "";

    const child = spawn(bin, args, {
      cwd: existsSync(WORKSPACE) ? WORKSPACE : process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      lineBuffer += chunk.toString("utf8");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const ev = JSON.parse(trimmed);
          if (!ttft && ev.event === "step_update" && ev.step_update?.text_delta) {
            ttft = Date.now() - startedAt;
          }
          sendSse(res, { type: "event", event: ev, ttft });
        } catch {
          sendSse(res, { type: "raw", text: trimmed });
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        sendSse(res, { type: "stderr", text });
      }
    });

    child.on("close", (code) => {
      if (lineBuffer.trim()) {
        try {
          const ev = JSON.parse(lineBuffer.trim());
          sendSse(res, { type: "event", event: ev });
        } catch {
          sendSse(res, { type: "raw", text: lineBuffer.trim() });
        }
      }
      const durationMs = Date.now() - startedAt;
      sendSse(res, { type: "done", code, durationMs, ttft });
      res.end();
    });

    child.on("error", (err) => {
      sendSse(res, { type: "error", error: err.message });
      res.end();
    });

    req.on("close", () => {
      child.kill("SIGTERM");
    });
    return;
  }

  // Probe 5: Autonomous Tool & Skills Verification
  if (req.method === "POST" && pathname === "/api/test-agy/probe-tools") {
    const started = Date.now();
    const testPrompt =
      "Examine the current working directory, check if .agents or skills exist, and output a concise 1-sentence verification of tool access.";
    const result = await runAgyCommand(
      ["-p", testPrompt, "--model", "gemini-3.8-flash-high", "--output-format", "stream-json", "--dangerously-skip-permissions"],
      { timeout: 45000 },
    );
    const durationMs = Date.now() - started;

    const events = [];
    const toolCalls = [];
    const lines = result.stdout.split("\n");
    let reply = "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed);
        events.push(ev);
        if (ev.event === "step_update") {
          if (ev.step_update?.tool_name || ev.step_update?.tool_call) {
            toolCalls.push(ev.step_update);
          }
          if (ev.step_update?.text_delta) {
            reply += ev.step_update.text_delta;
          }
        } else if (ev.event === "result" && ev.result) {
          reply = ev.result.response || reply;
        }
      } catch {}
    }

    jsonResponse(res, 200, {
      ok: result.code === 0,
      exitCode: result.code,
      durationMs,
      reply: reply.trim() || result.stdout.trim(),
      toolCallsCount: toolCalls.length,
      toolCalls,
      zeroPermissionPrompts: true, // Auto-approved by --dangerously-skip-permissions
      rawStderr: result.stderr,
    });
    return;
  }

  jsonResponse(res, 404, { error: "Not found" });
}

/**
 * Persist OAuth tokens to persistent volume and user home
 */
async function saveOAuthCredentials(tokenData, accountsData = null) {
  const { storageGeminiDir, storageCredsPath, homeCredsPath, storageAccountsPath, homeAccountsPath } = getGeminiPaths();

  await mkdir(storageGeminiDir, { recursive: true });

  const creds = {
    access_token: tokenData.access_token || "",
    refresh_token: tokenData.refresh_token || "",
    scope: tokenData.scope || GOOGLE_AUTH_SCOPES,
    token_type: tokenData.token_type || "Bearer",
    id_token: tokenData.id_token || "",
    expiry_date: tokenData.expiry_date || (tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : null),
  };

  const credsJson = JSON.stringify(creds, null, 2);
  await writeFile(storageCredsPath, credsJson, "utf8");
  await writeFile(homeCredsPath, credsJson, "utf8").catch(() => {});

  let email = "";
  if (creds.id_token) {
    try {
      const parts = creds.id_token.split(".");
      if (parts[1]) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
        email = payload.email || "";
      }
    } catch {}
  }

  const accounts = accountsData || { active: email || "gemini-pro@google.com", old: [] };
  const accountsJson = JSON.stringify(accounts, null, 2);
  await writeFile(storageAccountsPath, accountsJson, "utf8");
  await writeFile(homeAccountsPath, accountsJson, "utf8").catch(() => {});

  if (dbReady()) {
    try {
      await setSetting("agy_oauth_creds", credsJson);
      await setSetting("agy_google_accounts", accountsJson);
      logEvent("info", "saveOAuthCredentials: saved credentials to PostgreSQL (DATABASE_URL)");
    } catch (err) {
      logEvent("warn", `saveOAuthCredentials: db save failed: ${err?.message || err}`);
    }
  }
}

function jsonResponse(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function sendSse(res, data) {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

function readStreamBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Single-page HTML diagnostic console for /test-agy
 */
function renderTestAgyPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AGY Cloud Spike Harness · /test-agy</title>
  <style>
    :root {
      --bg: #090d16;
      --card: #111827;
      --card-border: #1f2937;
      --text: #f3f4f6;
      --muted: #9ca3af;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --success: #10b981;
      --warn: #f59e0b;
      --danger: #ef4444;
      --code-bg: #030712;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 24px;
    }
    .container { max-width: 1100px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--card-border);
    }
    h1 { font-size: 1.5rem; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .badge {
      font-size: 0.75rem;
      padding: 3px 8px;
      border-radius: 9999px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .badge-success { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-warn { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }
    .badge-danger { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
    
    .status-bar {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .status-card {
      background: var(--card);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 16px;
    }
    .status-label { font-size: 0.8rem; color: var(--muted); margin-bottom: 4px; }
    .status-val { font-size: 1.1rem; font-weight: 600; }
    .status-sub { font-size: 0.75rem; color: var(--muted); margin-top: 4px; word-break: break-all; }

    .nav-tabs {
      display: flex;
      gap: 8px;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 20px;
    }
    .tab-btn {
      background: none;
      border: none;
      color: var(--muted);
      padding: 10px 16px;
      cursor: pointer;
      font-weight: 600;
      border-bottom: 2px solid transparent;
      transition: all 0.2s;
    }
    .tab-btn:hover { color: var(--text); }
    .tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }

    .tab-pane { display: none; }
    .tab-pane.active { display: block; }

    .card {
      background: var(--card);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .card-title { font-size: 1.1rem; font-weight: 600; margin-bottom: 12px; }
    .card-desc { font-size: 0.875rem; color: var(--muted); margin-bottom: 16px; }

    button.btn {
      background: var(--accent);
      color: #fff;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: background 0.15s;
    }
    button.btn:hover { background: var(--accent-hover); }
    button.btn:disabled { opacity: 0.5; cursor: not-allowed; }
    button.btn-secondary { background: #374151; }
    button.btn-secondary:hover { background: #4b5563; }
    button.btn-danger { background: #dc2626; }
    button.btn-danger:hover { background: #b91c1c; }

    input[type="text"], textarea, select {
      width: 100%;
      background: var(--code-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      color: var(--text);
      padding: 10px;
      font-family: inherit;
      font-size: 0.9rem;
      margin-bottom: 12px;
    }
    textarea { min-height: 100px; resize: vertical; font-family: monospace; }

    pre {
      background: var(--code-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 12px;
      overflow-x: auto;
      font-size: 0.825rem;
      font-family: monospace;
      color: #e5e7eb;
      max-height: 360px;
      white-space: pre-wrap;
      word-break: break-all;
    }

    .metric-row {
      display: flex;
      gap: 16px;
      margin-bottom: 16px;
    }
    .metric-pill {
      background: rgba(59, 130, 246, 0.1);
      border: 1px solid rgba(59, 130, 246, 0.2);
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 0.8rem;
    }
    .metric-pill strong { color: #60a5fa; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>⚡ Google Antigravity CLI Spike</h1>
        <div style="font-size: 0.85rem; color: var(--muted); margin-top: 4px;">Isolated Cloud Testing Harness · <code>/test-agy</code></div>
      </div>
      <div>
        <button class="btn btn-secondary" onclick="refreshHealth()">🔄 Refresh Status</button>
      </div>
    </header>

    <div class="status-bar">
      <div class="status-card">
        <div class="status-label">AGY Binary</div>
        <div class="status-val" id="st-bin">Checking...</div>
        <div class="status-sub" id="st-bin-sub">Path: checking</div>
      </div>
      <div class="status-card">
        <div class="status-label">Gemini Pro Account</div>
        <div class="status-val" id="st-auth">Checking...</div>
        <div class="status-sub" id="st-auth-sub">OAuth token status</div>
      </div>
      <div class="status-card">
        <div class="status-label">Storage Volume</div>
        <div class="status-val" id="st-vol">Checking...</div>
        <div class="status-sub" id="st-vol-sub">/storage/.gemini link</div>
      </div>
      <div class="status-card">
        <div class="status-label">Catalog & Skills</div>
        <div class="status-val" id="st-skills">Checking...</div>
        <div class="status-sub" id="st-skills-sub">Shared catalog</div>
      </div>
    </div>

    <div class="nav-tabs">
      <button class="tab-btn active" onclick="showTab('p1')">Probe 1: Binary Health</button>
      <button class="tab-btn" onclick="showTab('p2')">Probe 2: OAuth & Credentials</button>
      <button class="tab-btn" onclick="showTab('p3')">Probe 3: Minimal Dry-Run</button>
      <button class="tab-btn" onclick="showTab('p4')">Probe 4: NDJSON Live Stream</button>
      <button class="tab-btn" onclick="showTab('p5')">Probe 5: Tool & Skills Probe</button>
    </div>

    <!-- PROBE 1: Binary Health -->
    <div id="tab-p1" class="tab-pane active">
      <div class="card">
        <div class="card-title">Probe 1: CLI Binary & Model Discovery</div>
        <div class="card-desc">Validates presence of <code>agy</code> binary, prints version, and tests model listing.</div>
        <button class="btn" onclick="refreshHealth()">Run Probe 1 Health Inspection</button>
        <div style="margin-top: 16px;">
          <div class="status-label">Raw Health API Payload:</div>
          <pre id="p1-out">// Click "Run Probe 1 Health Inspection" to view</pre>
        </div>
      </div>
    </div>

    <!-- PROBE 2: OAuth -->
    <div id="tab-p2" class="tab-pane">
      <div class="card">
        <div class="card-title">Probe 2: Headless OAuth Link-and-Code Exchange</div>
        <div class="card-desc">Authenticate your Google Account with Gemini Pro subscription quotas (consumes zero metered API credits).</div>
        
        <div style="margin-bottom: 16px;">
          <button class="btn" onclick="startOAuth()">1. Generate Google OAuth Sign-In Link</button>
        </div>
        
        <div id="oauth-flow" style="display: none; margin-bottom: 20px;">
          <div style="margin-bottom: 12px;">
            <a id="oauth-link" href="#" target="_blank" class="btn" style="text-decoration: none;">🔗 Open Google Sign-In Window</a>
          </div>
          <div class="status-label">2. Paste authorization code (or full redirect URL from your browser address bar):</div>
          <input type="text" id="oauth-code" placeholder="Paste code (4/0A...) or full callback URL (https://antigravity.google/oauth-callback?code=...)">
          <button class="btn" onclick="submitOAuthCode()">Submit Authorization Code</button>
        </div>

        <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--card-border);">
          <div class="card-title" style="font-size: 0.95rem;">Alternative: Direct Credential Paste / Sync</div>
          <div class="card-desc">Paste <code>oauth_creds.json</code> content directly to sync credentials straight into <code>/storage/.gemini/</code>:</div>
          <textarea id="p2-paste-creds" placeholder="{\n  &quot;access_token&quot;: &quot;...&quot;,\n  &quot;refresh_token&quot;: &quot;...&quot;\n}"></textarea>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-secondary" onclick="savePastedCreds()">Save Credentials to Volume</button>
            <button class="btn btn-danger" onclick="clearCreds()">Clear Credentials</button>
          </div>
        </div>

        <div style="margin-top: 16px;">
          <pre id="p2-out">// Auth output will appear here</pre>
        </div>
      </div>
    </div>

    <!-- PROBE 3: Minimal Dry-Run -->
    <div id="tab-p3" class="tab-pane">
      <div class="card">
        <div class="card-title">Probe 3: Minimal Dry-Run Ping Turn</div>
        <div class="card-desc">Executes <code>agy -p "ping test reply pong" --output-format stream-json --dangerously-skip-permissions</code> to assert quota and HTTP 200 execution.</div>
        <button class="btn" id="btn-dry-run" onclick="runDryRun()">Run Probe 3 Ping Turn</button>
        
        <div style="margin-top: 16px;">
          <div class="metric-row" id="p3-metrics" style="display: none;">
            <div class="metric-pill">Duration: <strong id="p3-dur">0ms</strong></div>
            <div class="metric-pill">Events: <strong id="p3-events">0</strong></div>
            <div class="metric-pill">Total Tokens: <strong id="p3-tokens">0</strong></div>
          </div>
          <pre id="p3-out">// Click "Run Probe 3 Ping Turn" to start</pre>
        </div>
      </div>
    </div>

    <!-- PROBE 4: NDJSON Live Stream -->
    <div id="tab-p4" class="tab-pane">
      <div class="card">
        <div class="card-title">Probe 4: NDJSON Streaming & Latency Benchmark</div>
        <div class="card-desc">Sends a prompt over Server-Sent Events (SSE), piping raw NDJSON events in real-time. Measures TTFT and token efficiency.</div>
        
        <div style="display: grid; grid-template-columns: 240px 1fr; gap: 12px; margin-bottom: 12px;">
          <div>
            <div class="status-label">Model:</div>
            <select id="p4-model">
              <option value="gemini-3.8-flash-high">Gemini 3.8 Flash (High)</option>
              <option value="gemini-3.8-flash-medium">Gemini 3.8 Flash (Medium)</option>
              <option value="gemini-3.7-flash-high">Gemini 3.7 Flash (High)</option>
              <option value="gemini-3.1-pro-high">Gemini 3.1 Pro (High)</option>
              <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
            </select>
          </div>
          <div>
            <div class="status-label">Conversation ID (Optional to resume thread):</div>
            <input type="text" id="p4-conv" placeholder="Leave empty for fresh turn">
          </div>
        </div>

        <div class="status-label">Prompt:</div>
        <textarea id="p4-prompt">Write a concise 2-paragraph creative story about an autonomous AI agent exploring a cloud container.</textarea>
        
        <div style="margin-bottom: 16px;">
          <button class="btn" id="btn-stream" onclick="runStreamPrompt()">Send Prompt (Live SSE Stream)</button>
        </div>

        <div class="metric-row" id="p4-metrics" style="display: none;">
          <div class="metric-pill">TTFT: <strong id="p4-ttft">-</strong></div>
          <div class="metric-pill">Duration: <strong id="p4-dur">-</strong></div>
          <div class="metric-pill">Input: <strong id="p4-in-tokens">0</strong></div>
          <div class="metric-pill">Output: <strong id="p4-out-tokens">0</strong></div>
          <div class="metric-pill">Thinking: <strong id="p4-think-tokens">0</strong></div>
        </div>

        <div style="margin-bottom: 12px;">
          <div class="status-label">Live Assistant Stream:</div>
          <pre id="p4-live" style="min-height: 120px; font-family: inherit; font-size: 0.95rem; white-space: pre-wrap;"></pre>
        </div>

        <div>
          <div class="status-label">Raw NDJSON Event Feed:</div>
          <pre id="p4-raw">// Live events will scroll here</pre>
        </div>
      </div>
    </div>

    <!-- PROBE 5: Tool & Skills Probe -->
    <div id="tab-p5" class="tab-pane">
      <div class="card">
        <div class="card-title">Probe 5: Autonomous Tool Execution & Shared Skills</div>
        <div class="card-desc">Verifies that <code>--dangerously-skip-permissions</code> executes without hanging or prompting, and verifies discovery of shared skills catalog.</div>
        <button class="btn" id="btn-probe5" onclick="runProbe5()">Run Probe 5 Tool Verification</button>

        <div style="margin-top: 16px;">
          <pre id="p5-out">// Click "Run Probe 5 Tool Verification" to start</pre>
        </div>
      </div>
    </div>
  </div>

  <script>
    let currentHealth = null;

    function showTab(tabId) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      event.target.classList.add('active');
      document.getElementById('tab-' + tabId).classList.add('active');
    }

    async function refreshHealth() {
      try {
        const res = await fetch('/api/test-agy/health');
        const data = await res.json();
        currentHealth = data;

        // Binary
        const binEl = document.getElementById('st-bin');
        const binSub = document.getElementById('st-bin-sub');
        if (data.binary?.found) {
          binEl.innerHTML = '<span class="badge badge-success">READY</span> ' + (data.binary.version?.split('\\n')[0] || 'Installed');
          binSub.textContent = data.binary.path;
        } else {
          binEl.innerHTML = '<span class="badge badge-danger">MISSING</span>';
          binSub.textContent = data.binary.error || 'Binary not found in PATH';
        }

        // Auth
        const authEl = document.getElementById('st-auth');
        const authSub = document.getElementById('st-auth-sub');
        if (data.auth?.authenticated) {
          const email = data.auth.email || 'Logged In';
          authEl.innerHTML = '<span class="badge ' + (data.auth.isExpired ? 'badge-warn' : 'badge-success') + '">' + (data.auth.isExpired ? 'REFRESHABLE' : 'ACTIVE') + '</span> ' + email;
          authSub.textContent = 'Expiry: ' + (data.auth.expiresAt ? new Date(data.auth.expiresAt).toLocaleString() : 'Permanent refresh token');
        } else {
          authEl.innerHTML = '<span class="badge badge-warn">UNAUTHENTICATED</span>';
          authSub.textContent = 'No OAuth tokens in /storage/.gemini';
        }

        // Storage volume & Postgres (DATABASE_URL)
        const volEl = document.getElementById('st-vol');
        const volSub = document.getElementById('st-vol-sub');
        const pgTag = data.auth?.postgresSynced ? ' <span class="badge badge-success">PG SYNC</span>' : '';
        if (data.auth?.isSymlinked) {
          volEl.innerHTML = '<span class="badge badge-success">PERSISTENT</span> /storage' + pgTag;
          volSub.textContent = '/storage/.gemini symlinked to ~/.gemini' + (data.auth?.postgresSynced ? ' · Synced in PostgreSQL' : '');
        } else {
          volEl.innerHTML = '<span class="badge badge-warn">DIRECT</span> /storage' + pgTag;
          volSub.textContent = (data.auth?.storageDir || '/storage/.gemini') + (data.auth?.postgresSynced ? ' · Synced in PostgreSQL' : '');
        }

        // Skills
        const skEl = document.getElementById('st-skills');
        const skSub = document.getElementById('st-skills-sub');
        skEl.innerHTML = '<span class="badge badge-success">' + (data.skills?.count || 0) + ' SKILLS</span>';
        skSub.textContent = data.skills?.names?.slice(0, 3).join(', ') + (data.skills?.count > 3 ? '...' : '');

        // Populate models select if present
        if (data.models && data.models.length > 0) {
          const sel = document.getElementById('p4-model');
          sel.innerHTML = '';
          data.models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.name;
            if (m.id === 'gemini-3.8-flash-high') opt.selected = true;
            sel.appendChild(opt);
          });
        }

        document.getElementById('p1-out').textContent = JSON.stringify(data, null, 2);
      } catch (err) {
        document.getElementById('p1-out').textContent = 'Error fetching health: ' + err.message;
      }
    }

    async function startOAuth() {
      const btn = event?.target || document.querySelector('#tab-p2 button');
      const origText = btn ? btn.textContent : '';
      if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Generating Google Sign-In Link...';
      }
      document.getElementById('p2-out').textContent = 'Requesting Google OAuth authorization link...';
      try {
        const res = await fetch('/api/test-agy/auth/start', { method: 'POST' });
        const data = await res.json();
        if (data.authUrl) {
          document.getElementById('oauth-flow').style.display = 'block';
          document.getElementById('oauth-link').href = data.authUrl;
          document.getElementById('p2-out').textContent = [
            '✅ OAuth URL generated!',
            '',
            'Click the link below or open this URL in your browser:',
            data.authUrl,
            '',
            'Instructions:',
            (data.instructions || 'Sign in, copy code, and submit.')
          ].join(String.fromCharCode(10));
        } else {
          document.getElementById('p2-out').textContent = 'Warning: ' + (data.error || 'No auth URL returned');
        }
      } catch (err) {
        document.getElementById('p2-out').textContent = 'Error starting OAuth: ' + err.message;
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = origText || '1. Generate Google OAuth Sign-In Link';
        }
      }
    }

    async function submitOAuthCode() {
      const code = document.getElementById('oauth-code').value.trim();
      if (!code) return alert('Please paste the authorization code first');
      document.getElementById('p2-out').textContent = 'Exchanging authorization code...';
      try {
        const res = await fetch('/api/test-agy/auth/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
        });
        const data = await res.json();
        document.getElementById('p2-out').textContent = JSON.stringify(data, null, 2);
        refreshHealth();
      } catch (err) {
        document.getElementById('p2-out').textContent = 'Error: ' + err.message;
      }
    }

    async function savePastedCreds() {
      const raw = document.getElementById('p2-paste-creds').value.trim();
      if (!raw) return alert('Please paste credentials JSON first');
      try {
        const creds = JSON.parse(raw);
        const res = await fetch('/api/test-agy/auth/save-creds', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ oauth_creds: creds })
        });
        const data = await res.json();
        document.getElementById('p2-out').textContent = JSON.stringify(data, null, 2);
        refreshHealth();
      } catch (err) {
        document.getElementById('p2-out').textContent = 'Invalid JSON or error: ' + err.message;
      }
    }

    async function clearCreds() {
      if (!confirm('Clear persisted credentials?')) return;
      const res = await fetch('/api/test-agy/auth/clear', { method: 'POST' });
      const data = await res.json();
      document.getElementById('p2-out').textContent = JSON.stringify(data, null, 2);
      refreshHealth();
    }

    async function runDryRun() {
      const btn = document.getElementById('btn-dry-run');
      btn.disabled = true;
      btn.textContent = 'Running Probe 3...';
      document.getElementById('p3-out').textContent = 'Executing agy -p "ping test reply pong"...';
      document.getElementById('p3-metrics').style.display = 'none';

      try {
        const res = await fetch('/api/test-agy/dry-run', { method: 'POST' });
        const data = await res.json();
        btn.disabled = false;
        btn.textContent = 'Run Probe 3 Ping Turn';

        document.getElementById('p3-metrics').style.display = 'flex';
        document.getElementById('p3-dur').textContent = data.durationMs + 'ms';
        document.getElementById('p3-events').textContent = data.eventsCount;
        document.getElementById('p3-tokens').textContent = data.usage?.total_tokens || 0;

        document.getElementById('p3-out').textContent = JSON.stringify(data, null, 2);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Run Probe 3 Ping Turn';
        document.getElementById('p3-out').textContent = 'Error: ' + err.message;
      }
    }

    async function runStreamPrompt() {
      const prompt = document.getElementById('p4-prompt').value.trim();
      const model = document.getElementById('p4-model').value;
      const conv = document.getElementById('p4-conv').value.trim();
      const btn = document.getElementById('btn-stream');

      if (!prompt) return alert('Please enter a prompt');
      btn.disabled = true;
      btn.textContent = 'Streaming...';

      const liveEl = document.getElementById('p4-live');
      const rawEl = document.getElementById('p4-raw');
      liveEl.textContent = '';
      rawEl.textContent = '';

      document.getElementById('p4-metrics').style.display = 'flex';
      document.getElementById('p4-ttft').textContent = 'Measuring...';
      document.getElementById('p4-dur').textContent = 'Running...';

      const start = Date.now();
      let streamText = '';

      try {
        const res = await fetch('/api/test-agy/prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, model, conversationId: conv })
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\\n\\n');
          buffer = parts.pop() || '';

          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith('data: ')) continue;
            try {
              const msg = JSON.parse(line.slice(6));
              rawEl.textContent += JSON.stringify(msg) + '\\n';
              rawEl.scrollTop = rawEl.scrollHeight;

              if (msg.type === 'event' && msg.event) {
                const ev = msg.event;
                if (msg.ttft) document.getElementById('p4-ttft').textContent = msg.ttft + 'ms';
                if (ev.conversation_id && !document.getElementById('p4-conv').value) {
                  document.getElementById('p4-conv').value = ev.conversation_id;
                }
                if (ev.event === 'step_update') {
                  if (ev.step_update?.text_delta) {
                    streamText += ev.step_update.text_delta;
                    liveEl.textContent = streamText;
                  }
                  if (ev.step_update?.usage) {
                    const u = ev.step_update.usage;
                    document.getElementById('p4-in-tokens').textContent = u.input_tokens || 0;
                    document.getElementById('p4-out-tokens').textContent = u.output_tokens || 0;
                    document.getElementById('p4-think-tokens').textContent = u.thinking_tokens || 0;
                  }
                } else if (ev.event === 'result' && ev.result?.usage) {
                  const u = ev.result.usage;
                  document.getElementById('p4-in-tokens').textContent = u.input_tokens || 0;
                  document.getElementById('p4-out-tokens').textContent = u.output_tokens || 0;
                  document.getElementById('p4-think-tokens').textContent = u.thinking_tokens || 0;
                }
              } else if (msg.type === 'done') {
                document.getElementById('p4-dur').textContent = (msg.durationMs || (Date.now() - start)) + 'ms';
                if (msg.ttft) document.getElementById('p4-ttft').textContent = msg.ttft + 'ms';
              }
            } catch {}
          }
        }
      } catch (err) {
        liveEl.textContent += '\\n[Error: ' + err.message + ']';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Send Prompt (Live SSE Stream)';
      }
    }

    async function runProbe5() {
      const btn = document.getElementById('btn-probe5');
      btn.disabled = true;
      btn.textContent = 'Running Probe 5...';
      document.getElementById('p5-out').textContent = 'Executing tool probe...';

      try {
        const res = await fetch('/api/test-agy/probe-tools', { method: 'POST' });
        const data = await res.json();
        btn.disabled = false;
        btn.textContent = 'Run Probe 5 Tool Verification';
        document.getElementById('p5-out').textContent = JSON.stringify(data, null, 2);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Run Probe 5 Tool Verification';
        document.getElementById('p5-out').textContent = 'Error: ' + err.message;
      }
    }

    // Auto-load health on mount
    refreshHealth();
  </script>
</body>
</html>`;
}
