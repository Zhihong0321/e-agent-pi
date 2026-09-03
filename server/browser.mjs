import { chromium } from "playwright";
import { access, mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "./paths.mjs";

export const BROWSER_PROFILES = path.join(DATA_DIR, "browser", "profiles");

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-blink-features=AutomationControlled",
];

/** @type {Map<string, { context: import("playwright").BrowserContext; queue: Promise<unknown> }>} */
const sessions = new Map();

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
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

async function launchProfile(slug) {
  const userDataDir = path.join(BROWSER_PROFILES, slug);
  await mkdir(userDataDir, { recursive: true });
  const executablePath = await findChromiumExecutable();
  if (!executablePath) {
    throw new Error(
      "No Chromium for site automation. The Docker image must include Playwright browsers (Scrapling install).",
    );
  }
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: true,
    args: LAUNCH_ARGS,
    viewport: { width: 1400, height: 900 },
    ignoreHTTPSErrors: true,
  });
  return { context, queue: Promise.resolve() };
}

async function sessionFor(slug) {
  const key = slug || "default";
  let current = sessions.get(key);
  if (!current) {
    current = await launchProfile(key);
    sessions.set(key, current);
  }
  return current;
}

function enqueue(slug, fn) {
  const run = async () => {
    const session = await sessionFor(slug);
    const next = session.queue.then(() => fn(session.context), () => fn(session.context));
    session.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  return run();
}

/**
 * @param {string} slug
 * @returns {import("./newpages/npmerchant.mjs") extends never ? object : {
 *   runIsolated: Function;
 *   openTab: Function;
 * }}
 */
export function browserManager(slug) {
  return {
    async runIsolated(fn) {
      return enqueue(slug, async (context) => {
        const page = await context.newPage();
        try {
          return await fn(context, page);
        } finally {
          await page.close().catch(() => {});
        }
      });
    },
    async openTab(fn) {
      return enqueue(slug, async (context) => {
        const page = await context.newPage();
        return fn(context, page);
      });
    },
  };
}

export async function closeBrowsers() {
  for (const [slug, session] of sessions) {
    await session.context.close().catch(() => {});
    sessions.delete(slug);
  }
}
