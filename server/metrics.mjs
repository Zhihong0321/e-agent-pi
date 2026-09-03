import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import { dbReady, insertResourceSample, listResourceSamples, pruneResourceSamples } from "./db.mjs";

export const INTERVAL_MS = 15_000;
export const RETENTION_HOURS = 24;
const RING_MAX = Math.ceil((RETENTION_HOURS * 3600 * 1000) / INTERVAL_MS) + 8;

/** @type {ReturnType<typeof setInterval> | undefined} */
let timer;
let ticking = false;
/** @type {() => boolean} */
let piAlive = () => false;
let lastCpu = process.cpuUsage();
let lastHr = process.hrtime.bigint();
/** @type {number | null} */
let lastCgroupCpuUs = null;
/** @type {bigint | null} */
let lastCgroupHr = null;
/** @type {ResourceSample[]} */
const ring = [];
/** @type {ResourceSample | null} */
let lastSample = null;

/**
 * @typedef {{
 *   ts: string;
 *   nodeRssMb: number;
 *   nodeHeapMb: number;
 *   childrenRssMb: number | null;
 *   containerMb: number;
 *   containerLimitMb: number | null;
 *   nodeCpuPct: number;
 *   containerCpuPct: number | null;
 *   childCount: number;
 *   load1: number | null;
 *   piAlive: boolean;
 * }} ResourceSample
 */

function mb(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

function kbToMb(kb) {
  return Math.round((kb / 1024) * 10) / 10;
}

async function readText(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function rssKb(pid) {
  const text = await readText(`/proc/${pid}/status`);
  if (!text) return null;
  const match = text.match(/^VmRSS:\s+(\d+)\s+kB/m);
  return match ? Number(match[1]) : null;
}

async function childrenOf(pid) {
  const direct = await readText(`/proc/${pid}/task/${pid}/children`);
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
      const text = await readText(`/proc/${pid}/task/${tid}/children`);
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

async function descendants(root) {
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

async function cgroupMemory() {
  const current = await readText("/sys/fs/cgroup/memory.current");
  if (current) {
    const max = (await readText("/sys/fs/cgroup/memory.max"))?.trim();
    const used = Number(current.trim());
    const limit = max && max !== "max" ? Number(max) : null;
    return {
      used: Number.isFinite(used) ? used : null,
      limit: limit != null && Number.isFinite(limit) && limit < 1e15 ? limit : null,
    };
  }
  const usedText = await readText("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  if (usedText) {
    const used = Number(usedText.trim());
    const limitRaw = Number((await readText("/sys/fs/cgroup/memory/memory.limit_in_bytes"))?.trim() || 0);
    return {
      used: Number.isFinite(used) ? used : null,
      limit: Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw < 1e15 ? limitRaw : null,
    };
  }
  return { used: null, limit: null };
}

async function cgroupCpuUs() {
  const text = await readText("/sys/fs/cgroup/cpu.stat");
  if (!text) return null;
  const match = text.match(/^usage_usec\s+(\d+)/m);
  return match ? Number(match[1]) : null;
}

function remember(sample) {
  lastSample = sample;
  ring.push(sample);
  const cutoff = Date.now() - RETENTION_HOURS * 3600 * 1000;
  while (ring.length && new Date(ring[0].ts).getTime() < cutoff) ring.shift();
  while (ring.length > RING_MAX) ring.shift();
}

export async function collectSample() {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  const hr = process.hrtime.bigint();
  const elapsedUs = Number(hr - lastHr) / 1000;
  const usedUs = cpu.user - lastCpu.user + (cpu.system - lastCpu.system);
  lastCpu = cpu;
  lastHr = hr;
  const nodeCpuPct = elapsedUs > 0 ? Math.round((usedUs / elapsedUs) * 1000) / 10 : 0;

  const usageUs = await cgroupCpuUs();
  let containerCpuPct = null;
  if (usageUs != null) {
    if (lastCgroupCpuUs != null && lastCgroupHr != null) {
      const elapsedCgroupUs = Number(hr - lastCgroupHr) / 1000;
      const delta = usageUs - lastCgroupCpuUs;
      containerCpuPct = elapsedCgroupUs > 0 ? Math.round((delta / elapsedCgroupUs) * 1000) / 10 : 0;
    }
    lastCgroupCpuUs = usageUs;
    lastCgroupHr = hr;
  }

  let childrenRssKb = 0;
  let childCount = 0;
  if (process.platform === "linux") {
    const kids = await descendants(process.pid);
    childCount = kids.length;
    const rssList = await Promise.all(kids.map((pid) => rssKb(pid)));
    for (const rss of rssList) {
      if (rss) childrenRssKb += rss;
    }
  }

  const cgroup = await cgroupMemory();
  const childrenRssMb = childCount || childrenRssKb ? kbToMb(childrenRssKb) : process.platform === "linux" ? 0 : null;
  const fallbackBytes = mem.rss + childrenRssKb * 1024;
  const containerMb = cgroup.used != null ? mb(cgroup.used) : mb(fallbackBytes);
  const load = os.loadavg()[0];

  /** @type {ResourceSample} */
  const sample = {
    ts: new Date().toISOString(),
    nodeRssMb: mb(mem.rss),
    nodeHeapMb: mb(mem.heapUsed),
    childrenRssMb,
    containerMb,
    containerLimitMb: cgroup.limit != null ? mb(cgroup.limit) : null,
    nodeCpuPct,
    containerCpuPct,
    childCount,
    load1: process.platform === "win32" ? null : Math.round(load * 100) / 100,
    piAlive: piAlive(),
  };
  return sample;
}

function statsOf(samples) {
  if (!samples.length) {
    return { sampleCount: 0, ramPeakMb: 0, ramAvgMb: 0, cpuPeakPct: 0, cpuAvgPct: 0 };
  }
  let ramSum = 0;
  let ramPeak = 0;
  let cpuSum = 0;
  let cpuPeak = 0;
  for (const row of samples) {
    ramSum += row.containerMb;
    if (row.containerMb > ramPeak) ramPeak = row.containerMb;
    const cpu = row.containerCpuPct ?? row.nodeCpuPct;
    cpuSum += cpu;
    if (cpu > cpuPeak) cpuPeak = cpu;
  }
  const n = samples.length;
  return {
    sampleCount: n,
    ramPeakMb: Math.round(ramPeak * 10) / 10,
    ramAvgMb: Math.round((ramSum / n) * 10) / 10,
    cpuPeakPct: Math.round(cpuPeak * 10) / 10,
    cpuAvgPct: Math.round((cpuSum / n) * 10) / 10,
  };
}

export function latestSample() {
  return lastSample;
}

export async function metricsPayload() {
  let samples = ring.slice();
  if (dbReady()) {
    try {
      const rows = await listResourceSamples(RETENTION_HOURS);
      if (rows.length) samples = rows;
    } catch {
      // Keep the in-process ring if Postgres is briefly unavailable.
    }
  }
  if (!samples.length && lastSample) samples = [lastSample];
  return {
    intervalSec: INTERVAL_MS / 1000,
    retentionHours: RETENTION_HOURS,
    now: lastSample,
    samples,
    stats: statsOf(samples),
  };
}

export function setPiAliveGetter(fn) {
  piAlive = fn;
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const sample = await collectSample();
    remember(sample);
    if (dbReady()) {
      await insertResourceSample(sample);
      await pruneResourceSamples(RETENTION_HOURS);
    }
  } catch {
    // Next interval retries. Do not crash the host over a /proc read.
  } finally {
    ticking = false;
  }
}

export function startSampler() {
  if (timer) return;
  void tick();
  timer = setInterval(() => void tick(), INTERVAL_MS);
  timer.unref?.();
}

export function stopSampler() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
