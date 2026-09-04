import { chromium } from "playwright";
import { access, mkdir, readFile, readdir, readlink, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "./paths.mjs";

export const BROWSER_PROFILES = path.join(DATA_DIR, "browser", "profiles");

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-first-run",
  "--disable-blink-features=AutomationControlled",
];

const CHROME_LOCK_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

/** @type {Set<import("playwright").BrowserContext>} */
const live = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
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

/** Chromium writes SingletonLock as a symlink `hostname-pid` (Linux) or a similar target. */
export function chromePidFromLockTarget(target) {
  const text = String(target || "").trim();
  if (!text) return null;
  const match = text.match(/(\d+)\s*$/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function isProfileBusyError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /ProcessSingleton|profile is already in use|Failed to create a ProcessSingleton/i.test(message);
}

async function isStaleLockFile(lockPath, staleMs) {
  try {
    const raw = await readFile(lockPath, "utf8");
    const [pidLine, tsLine] = raw.split(/\r?\n/);
    const pid = Number(pidLine);
    const ts = Number(tsLine);
    if (pid && !pidAlive(pid)) return true;
    if (ts && Date.now() - ts > staleMs) return true;
    return false;
  } catch {
    return true;
  }
}

export async function withExclusiveLock(lockPath, fn, { timeoutMs = 180_000, staleMs = 15 * 60_000 } = {}) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await writeFile(lockPath, `${process.pid}\n${Date.now()}\n`, { flag: "wx" });
      try {
        return await fn();
      } finally {
        await unlink(lockPath).catch(() => {});
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await isStaleLockFile(lockPath, staleMs)) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      await sleep(200);
    }
  }
  throw new Error("Chromium profile is busy (another site login or np command is using it). Wait a few seconds and retry.");
}

export async function clearStaleChromiumLocks(userDataDir, { killStale = true } = {}) {
  const lockFile = path.join(userDataDir, "SingletonLock");
  let pid = null;
  try {
    pid = chromePidFromLockTarget(await readlink(lockFile));
  } catch {
    pid = null;
  }
  if (pid && pidAlive(pid) && killStale) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
    await sleep(400);
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
      await sleep(200);
    }
  } else if (pid && pidAlive(pid) && !killStale) {
    return { cleared: false, pid };
  }
  for (const name of CHROME_LOCK_FILES) {
    await rm(path.join(userDataDir, name), { force: true }).catch(() => {});
  }
  return { cleared: true, pid };
}

export async function findChromiumExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM?.trim()) return process.env.PLAYWRIGHT_CHROMIUM.trim();
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    "/opt/playwright",
    path.join(os.homedir(), ".cache", "ms-playwright"),
  ].filter(Boolean);
  for (const root of roots) {
    let entries = [];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/chromium/i.test(entry.name)) continue;
      const candidates = [
        path.join(root, entry.name, "chrome-linux", "chrome"),
        path.join(root, entry.name, "chrome-linux64", "chrome"),
        path.join(root, entry.name, "chrome-win64", "chrome.exe"),
        path.join(root, entry.name, "chrome-win", "chrome.exe"),
      ];
      for (const file of candidates) {
        if (await fileExists(file)) return file;
      }
    }
  }
  try {
    const exe = chromium.executablePath();
    if (exe && (await fileExists(exe))) return exe;
  } catch {
    // Node Playwright browsers were not installed.
  }
  return null;
}

async function launchPersistent(userDataDir, executablePath) {
  await clearStaleChromiumLocks(userDataDir);
  try {
    return await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless: true,
      args: LAUNCH_ARGS,
      viewport: { width: 1400, height: 900 },
      ignoreHTTPSErrors: true,
      timeout: 45_000,
    });
  } catch (error) {
    if (!isProfileBusyError(error)) throw error;
    await clearStaleChromiumLocks(userDataDir);
    await sleep(400);
    return chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless: true,
      args: LAUNCH_ARGS,
      viewport: { width: 1400, height: 900 },
      ignoreHTTPSErrors: true,
      timeout: 45_000,
    });
  }
}

async function withLockedContext(slug, fn) {
  const key = slug || "default";
  const userDataDir = path.join(BROWSER_PROFILES, key);
  const lockPath = path.join(BROWSER_PROFILES, `${key}.lock`);
  return withExclusiveLock(lockPath, async () => {
    await mkdir(userDataDir, { recursive: true });
    const executablePath = await findChromiumExecutable();
    if (!executablePath) {
      throw new Error(
        "No Chromium for site automation. The Docker image must include Playwright browsers (Scrapling install).",
      );
    }
    const context = await launchPersistent(userDataDir, executablePath);
    live.add(context);
    try {
      return await fn(context);
    } finally {
      live.delete(context);
      await context.close().catch(() => {});
    }
  });
}

/**
 * @param {string} slug
 * @returns {{ runIsolated: Function; openTab: Function }}
 */
export function browserManager(slug) {
  return {
    async runIsolated(fn) {
      return withLockedContext(slug, async (context) => {
        const page = await context.newPage();
        try {
          return await fn(context, page);
        } finally {
          await page.close().catch(() => {});
        }
      });
    },
    async openTab(fn) {
      return withLockedContext(slug, async (context) => {
        const page = await context.newPage();
        try {
          return await fn(context, page);
        } finally {
          await page.close().catch(() => {});
        }
      });
    },
  };
}

export async function closeBrowsers() {
  await Promise.all([...live].map((context) => context.close().catch(() => {})));
  live.clear();
}
