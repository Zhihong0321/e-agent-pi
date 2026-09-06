// Boots the Go WhatsApp sidecar (whatsmeow) as a long-lived child process,
// restarting it if it exits, and registers its MCP server in the catalog
// attached to the WhatsApp Assistant agent. See whatsapp-auto-plan.md.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import {
  WHATSAPP_AGENT_ID,
  WHATSAPP_DATA_DIR,
  WHATSAPP_MCP_ADDR,
  WHATSAPP_MCP_SLUG,
  WHATSAPP_SIDECAR_BIN,
} from "./paths.mjs";
import { createMcpServer, getMcpServer, updateMcpServer, attachAgentResources } from "./catalog.mjs";
import { logEvent } from "./debug.mjs";
import { killTree } from "./proc.mjs";

const REWARM_WINDOW_MS = 10 * 60 * 1000;
const REWARM_MAX = 5;
const REWARM_DELAY_MS = 3000;

/** @type {import("node:child_process").ChildProcess | null} */
let child = null;
let shuttingDown = false;
/** @type {number[]} */
let exitTimestamps = [];

export async function ensureWhatsappMcp() {
  const payload = {
    name: "WhatsApp",
    slug: WHATSAPP_MCP_SLUG,
    url: `http://${WHATSAPP_MCP_ADDR}/mcp`,
    description: "The owner's real WhatsApp: list chats, find a contact, read/search history, send a text.",
  };
  const existing = await getMcpServer(WHATSAPP_MCP_SLUG);
  const server = existing ? await updateMcpServer(existing.id, payload) : await createMcpServer(payload);
  await attachAgentResources(WHATSAPP_AGENT_ID, { skills: [], mcp: [WHATSAPP_MCP_SLUG] });
  return server;
}

function spawnSidecar() {
  child = spawn(WHATSAPP_SIDECAR_BIN, [], {
    env: {
      ...process.env,
      WA_DATA_DIR: WHATSAPP_DATA_DIR,
      WA_MCP_ADDR: WHATSAPP_MCP_ADDR,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  logEvent("info", `whatsapp sidecar started pid=${pid || "?"}`);
  child.stdout?.on("data", (buf) => logEvent("info", `[whatsapp] ${buf.toString().trim()}`));
  child.stderr?.on("data", (buf) => logEvent("warn", `[whatsapp] ${buf.toString().trim()}`));
  child.on("error", (error) => {
    logEvent("error", `whatsapp sidecar failed to start: ${error?.message || error}`);
  });
  child.once("exit", (code, signal) => {
    child = null;
    if (shuttingDown) return;
    logEvent("warn", `whatsapp sidecar exited pid=${pid || "?"} code=${code ?? "?"} signal=${signal ?? "-"}`);
    const now = Date.now();
    exitTimestamps = exitTimestamps.filter((ts) => now - ts < REWARM_WINDOW_MS);
    exitTimestamps.push(now);
    if (exitTimestamps.length > REWARM_MAX) {
      logEvent("error", `whatsapp sidecar exited ${exitTimestamps.length}x in 10 min; not restarting automatically`);
      return;
    }
    const timer = setTimeout(() => {
      if (!shuttingDown) spawnSidecar();
    }, REWARM_DELAY_MS);
    timer.unref?.();
  });
}

export async function startWhatsappSidecar() {
  await mkdir(WHATSAPP_DATA_DIR, { recursive: true });
  shuttingDown = false;
  spawnSidecar();
}

export async function stopWhatsappSidecar() {
  shuttingDown = true;
  if (child?.pid) await killTree(child.pid);
  child = null;
}

const CONTROL_BASE = `http://${WHATSAPP_MCP_ADDR}`;

export async function whatsappStatus() {
  try {
    const res = await fetch(`${CONTROL_BASE}/status`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { linked: false, sidecarUp: false };
    const body = await res.json();
    return { ...body, sidecarUp: true };
  } catch {
    return { linked: false, sidecarUp: false };
  }
}

/** @returns {Promise<{ ok: boolean; status?: number; body?: ArrayBuffer; contentType?: string }>} */
export async function whatsappQr() {
  try {
    const res = await fetch(`${CONTROL_BASE}/qr.png`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, body: await res.arrayBuffer(), contentType: res.headers.get("content-type") || "image/png" };
  } catch {
    return { ok: false, status: 502 };
  }
}

export async function whatsappUnlink() {
  try {
    const res = await fetch(`${CONTROL_BASE}/unlink`, { method: "POST", signal: AbortSignal.timeout(10000) });
    return { ok: res.ok };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}
