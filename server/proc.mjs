import { readdir, readFile } from "node:fs/promises";

export function envInt(name, fallback, { min = 0, max = 1_000_000_000 } = {}) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readProc(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

export async function childrenOf(pid) {
  const direct = await readProc(`/proc/${pid}/task/${pid}/children`);
  if (direct != null) {
    return direct
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  try {
    const tasks = await readdir(`/proc/${pid}/task`);
    /** @type {Set<number>} */
    const kids = new Set();
    for (const tid of tasks) {
      const text = await readProc(`/proc/${pid}/task/${tid}/children`);
      if (!text) continue;
      for (const part of text.trim().split(/\s+/)) {
        const n = Number(part);
        if (Number.isFinite(n) && n > 0) kids.add(n);
      }
    }
    return [...kids];
  } catch {
    return [];
  }
}

export async function descendants(root) {
  /** @type {Set<number>} */
  const seen = new Set();
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift();
    if (pid == null || seen.has(pid)) continue;
    seen.add(pid);
    const kids = await childrenOf(pid);
    for (const kid of kids) {
      if (!seen.has(kid)) queue.push(kid);
    }
  }
  seen.delete(root);
  return [...seen];
}

export async function cmdlineOf(pid) {
  const text = await readProc(`/proc/${pid}/cmdline`);
  if (text == null) return "";
  return text.replace(/\0/g, " ").trim();
}

export async function processAgeMs(pid) {
  const text = await readProc(`/proc/${pid}/stat`);
  if (!text) return null;
  const startTicks = Number(text.split(")")[1]?.trim().split(/\s+/)[19]);
  if (!Number.isFinite(startTicks)) return null;
  const uptime = await readProc("/proc/uptime");
  const upSec = Number(uptime?.split(/\s+/)[0]);
  if (!Number.isFinite(upSec)) return null;
  const hz = 100;
  return Math.max(0, (upSec - startTicks / hz) * 1000);
}

export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

export function rpcClientPid(client) {
  if (!client || typeof client !== "object") return null;
  const direct = client.pid ?? client.childPid;
  if (Number.isInteger(direct) && direct > 0) return direct;
  const child = client.process ?? client.child ?? client._process ?? client._child;
  const pid = child?.pid;
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** MCP / Pi CLI leftovers that outlive a dead RpcClient (reparented to PID 1). */
export function isLeakedAgentCmd(cmd) {
  const text = String(cmd || "").toLowerCase();
  if (!text) return false;
  if (text.includes("pi-coding-agent")) return true;
  if (text.includes("pi-mcp-adapter")) return true;
  if (text.includes("@earendil-works")) return true;
  if (/\bscrapling(\.exe)?\b/.test(text) && /\bmcp\b/.test(text)) return true;
  return false;
}

/**
 * SIGTERM then SIGKILL a pid and its current descendants.
 * Never signals the host process.
 * @param {number | null | undefined} pid
 */
export async function killTree(pid) {
  const root = Number(pid);
  if (!Number.isInteger(root) || root <= 0 || root === process.pid) return;
  const kids = process.platform === "linux" ? await descendants(root) : [];
  const all = [...kids.filter((id) => id !== process.pid).reverse(), root];
  for (const id of all) {
    try {
      process.kill(id, "SIGTERM");
    } catch {
      // already gone
    }
  }
  await sleep(400);
  for (const id of all) {
    if (!pidAlive(id)) continue;
    try {
      process.kill(id, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * Kill host children that look like Pi/MCP leftovers and are not in the live slot trees.
 * @param {{ keepPids?: Iterable<number>; minAgeMs?: number }} [opts]
 */
export async function reapLeakedChildren({ keepPids = [], minAgeMs = 60_000 } = {}) {
  if (process.platform !== "linux") return 0;
  /** @type {Set<number>} */
  const keep = new Set();
  for (const pid of keepPids) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) continue;
    keep.add(n);
    for (const kid of await descendants(n)) keep.add(kid);
  }
  const orphans = await descendants(process.pid);
  let killed = 0;
  for (const pid of orphans) {
    if (keep.has(pid) || pid === process.pid) continue;
    const age = await processAgeMs(pid);
    if (age != null && age < minAgeMs) continue;
    const cmd = await cmdlineOf(pid);
    if (!isLeakedAgentCmd(cmd)) continue;
    await killTree(pid);
    killed += 1;
  }
  return killed;
}
