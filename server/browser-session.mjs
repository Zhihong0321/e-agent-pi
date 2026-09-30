import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  RESERVED_PROFILE_SLUGS,
  SHARED_PROFILE_SLUG,
  VIEWPORT,
  findChromiumExecutable,
  openPersistentContext,
  wantsHeadedLogin,
} from "./browser.mjs";

export { SHARED_PROFILE_SLUG, RESERVED_PROFILE_SLUGS, wantsHeadedLogin };

export const IDLE_MS = Number(process.env.BROWSER_IDLE_MS) || 5 * 60_000;

const GOOGLE_COOKIE_RE = /^(SID|SSID|__Secure-1PSID|__Secure-3PSID|SAPISID|APISID)$/i;

/** @type {Map<string, Session>} */
const sessions = new Map();
/** @type {Map<string, Promise<Session>>} */
const starting = new Map();
/** @type {Map<string, Promise<unknown>>} */
const chains = new Map();

let mcpToken = "";

/**
 * @typedef {object} Session
 * @property {import("playwright").BrowserContext} context
 * @property {Map<string, import("playwright").Page>} tabs
 * @property {string} currentId
 * @property {number} nextTab
 * @property {number} lastUsed
 * @property {ReturnType<typeof setTimeout> | null} idleTimer
 * @property {number} leases
 * @property {boolean} headless
 */

export function browserMcpToken() {
  if (!mcpToken) mcpToken = randomBytes(24).toString("hex");
  return mcpToken;
}

export function hasBrowserMcpAuth(req) {
  const auth = String(req.headers.authorization || "");
  const match = auth.match(/^Bearer\s+(\S+)/i);
  const got = match?.[1]?.trim() || "";
  const expect = mcpToken;
  if (!got || !expect) return false;
  const left = Buffer.from(got);
  const right = Buffer.from(expect);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function googleSignedInFromCookies(cookies) {
  return (cookies || []).some((cookie) => {
    const domain = String(cookie.domain || "");
    if (!domain.includes("google.com")) return false;
    return GOOGLE_COOKIE_RE.test(String(cookie.name || ""));
  });
}

export function originSignedInFromCookies(cookies, origin) {
  let host = "";
  try {
    host = new URL(origin).hostname.replace(/^www\./, "");
  } catch {
    return false;
  }
  if (!host) return false;
  if (host === "google.com" || host.endsWith(".google.com") || host === "accounts.google.com") {
    return googleSignedInFromCookies(cookies);
  }
  return (cookies || []).some((cookie) => {
    const domain = String(cookie.domain || "").replace(/^\./, "").replace(/^www\./, "");
    return domain === host || domain.endsWith(`.${host}`);
  });
}

export function sessionStatus(slug = SHARED_PROFILE_SLUG) {
  const session = sessions.get(slug);
  if (!session) {
    return { slug, live: false, tabs: [], viewport: VIEWPORT };
  }
  return publicSession(slug, session);
}

function publicSession(slug, session) {
  const page = currentPage(session);
  return {
    slug,
    live: true,
    headless: session.headless,
    url: page ? page.url() : "",
    title: "",
    tabs: [...session.tabs.entries()].map(([id, tab]) => ({
      id,
      url: tab.url(),
      current: id === session.currentId,
    })),
    viewport: VIEWPORT,
    leases: session.leases,
  };
}

function currentPage(session) {
  return session.tabs.get(session.currentId) || [...session.tabs.values()][0] || null;
}

function touch(session) {
  session.lastUsed = Date.now();
  armIdle(session);
}

function armIdle(session) {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    if (session.leases > 0) {
      armIdle(session);
      return;
    }
    const slug = [...sessions.entries()].find(([, value]) => value === session)?.[0];
    if (slug) void closeSession(slug);
  }, IDLE_MS);
  session.idleTimer.unref?.();
}

function assertProfile(slug) {
  const key = slug || SHARED_PROFILE_SLUG;
  if (RESERVED_PROFILE_SLUGS.has(key)) {
    throw new Error(`Profile "${key}" is reserved for host site automation. Use "${SHARED_PROFILE_SLUG}".`);
  }
  return key;
}

async function adoptContext(slug, context, headless) {
  /** @type {Map<string, import("playwright").Page>} */
  const tabs = new Map();
  let n = 0;
  const pages = context.pages();
  for (const page of pages) {
    n += 1;
    const id = `t${n}`;
    tabs.set(id, page);
    page.on("close", () => {
      tabs.delete(id);
      const session = sessions.get(slug);
      if (session && session.currentId === id) {
        session.currentId = [...tabs.keys()][0] || "";
      }
    });
  }
  if (!tabs.size) {
    const page = await context.newPage();
    n = 1;
    tabs.set("t1", page);
  }
  /** @type {Session} */
  const session = {
    context,
    tabs,
    currentId: [...tabs.keys()][0],
    nextTab: n + 1,
    lastUsed: Date.now(),
    idleTimer: null,
    leases: 0,
    headless,
  };
  sessions.set(slug, session);
  context.on("close", () => {
    if (sessions.get(slug) === session) sessions.delete(slug);
    if (session.idleTimer) clearTimeout(session.idleTimer);
  });
  armIdle(session);
  return session;
}

export async function ensureSession(slug = SHARED_PROFILE_SLUG, { headless } = {}) {
  const key = assertProfile(slug);
  const wantHeadless = headless !== false;
  const existing = sessions.get(key);
  if (existing) {
    if (!wantHeadless && existing.headless) {
      await closeSession(key);
    } else {
      touch(existing);
      return existing;
    }
  }
  const pending = starting.get(key);
  if (pending) return pending;
  const task = (async () => {
    const context = await openPersistentContext(key, { headless: wantHeadless });
    return adoptContext(key, context, wantHeadless);
  })();
  starting.set(key, task);
  try {
    return await task;
  } finally {
    starting.delete(key);
  }
}

export async function closeSession(slug = SHARED_PROFILE_SLUG) {
  const session = sessions.get(slug);
  if (!session) return { closed: false };
  if (session.idleTimer) clearTimeout(session.idleTimer);
  sessions.delete(slug);
  await session.context.close().catch(() => {});
  return { closed: true };
}

export async function closeAllSessions() {
  const slugs = [...sessions.keys()];
  await Promise.all(slugs.map((slug) => closeSession(slug)));
}

export function holdLease(slug = SHARED_PROFILE_SLUG) {
  const session = sessions.get(slug);
  if (!session) return () => {};
  session.leases += 1;
  return () => {
    session.leases = Math.max(0, session.leases - 1);
    touch(session);
  };
}

function pageOf(session, tabId) {
  if (tabId && session.tabs.has(tabId)) return session.tabs.get(tabId);
  const page = currentPage(session);
  if (!page) throw new Error("No open tab.");
  return page;
}

export async function withSession(slug, fn, { headless } = {}) {
  const key = assertProfile(slug);
  const prev = chains.get(key) || Promise.resolve();
  const task = prev.then(async () => {
    const session = await ensureSession(key, { headless });
    touch(session);
    return fn(session, pageOf(session));
  });
  chains.set(
    key,
    task.then(
      () => {},
      () => {},
    ),
  );
  return task;
}

export async function listTabs(slug = SHARED_PROFILE_SLUG) {
  const session = await ensureSession(slug);
  return publicSession(slug, session);
}

export async function newTab(slug = SHARED_PROFILE_SLUG, url = "") {
  return withSession(slug, async (session) => {
    const page = await session.context.newPage();
    const id = `t${session.nextTab++}`;
    session.tabs.set(id, page);
    session.currentId = id;
    page.on("close", () => {
      session.tabs.delete(id);
      if (session.currentId === id) session.currentId = [...session.tabs.keys()][0] || "";
    });
    if (url) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    return publicSession(slug, session);
  });
}

export async function switchTab(slug, tabId) {
  return withSession(slug, async (session) => {
    if (!session.tabs.has(tabId)) throw new Error(`Unknown tab ${tabId}`);
    session.currentId = tabId;
    return publicSession(slug, session);
  });
}

export async function closeTab(slug, tabId) {
  return withSession(slug, async (session) => {
    const page = session.tabs.get(tabId);
    if (!page) throw new Error(`Unknown tab ${tabId}`);
    await page.close().catch(() => {});
    session.tabs.delete(tabId);
    if (session.currentId === tabId) session.currentId = [...session.tabs.keys()][0] || "";
    if (!session.tabs.size) {
      const next = await session.context.newPage();
      session.tabs.set("t1", next);
      session.currentId = "t1";
      session.nextTab = 2;
    }
    return publicSession(slug, session);
  });
}

export async function navigate(slug, url) {
  return withSession(slug, async (session, page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    return { ...publicSession(slug, session), url: page.url() };
  });
}

export async function snapshot(slug) {
  return withSession(slug, async (session, page) => {
    let aria = "";
    try {
      aria = await page.locator("html").ariaSnapshot({ timeout: 8_000 });
    } catch {
      const acc = await page.accessibility.snapshot().catch(() => null);
      aria = acc ? JSON.stringify(acc, null, 2) : "(snapshot failed)";
    }
    return { url: page.url(), title: await page.title().catch(() => ""), snapshot: aria };
  });
}

export async function clickRef(slug, ref) {
  return withSession(slug, async (session, page) => {
    const locator = page.locator(`aria-ref=${ref}`);
    await locator.click({ timeout: 8_000 });
    return { url: page.url(), ok: true };
  });
}

export async function typeRef(slug, { ref, text, submit = false } = {}) {
  return withSession(slug, async (session, page) => {
    if (ref) {
      const locator = page.locator(`aria-ref=${ref}`);
      await locator.click({ timeout: 8_000 });
    }
    await page.keyboard.type(String(text || ""), { delay: 20 });
    if (submit) await page.keyboard.press("Enter");
    return { url: page.url(), ok: true };
  });
}

export async function pressKey(slug, key) {
  return withSession(slug, async (session, page) => {
    await page.keyboard.press(key);
    return { url: page.url(), ok: true };
  });
}

export async function clickAt(slug, x, y) {
  return withSession(slug, async (session, page) => {
    await page.mouse.click(Number(x), Number(y));
    return { url: page.url(), ok: true };
  });
}

export async function waitFor(slug, { timeoutMs = 5_000, urlIncludes = "" } = {}) {
  return withSession(slug, async (session, page) => {
    if (urlIncludes) {
      await page.waitForURL((href) => String(href).includes(urlIncludes), { timeout: timeoutMs }).catch(() => {});
    } else {
      const ms = Math.min(Math.max(Number(timeoutMs) || 0, 0), 30_000);
      if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
    }
    return { url: page.url(), ok: true };
  });
}

export async function screenshotJpeg(slug) {
  return withSession(slug, async (session, page) => {
    const buffer = await page.screenshot({ type: "jpeg", quality: 45, timeout: 8_000 });
    return { url: page.url(), image: buffer.toString("base64"), viewport: VIEWPORT };
  });
}

export async function authStatus(slug, { origin = "", kind = "" } = {}) {
  const session = await ensureSession(slug);
  const cookies = await session.context.cookies();
  const page = currentPage(session);
  const url = page ? page.url() : "";
  let signedIn = false;
  let evidence = "no matching cookies";
  if (kind === "google" || /google\.com/i.test(origin) || /google\.com/i.test(url)) {
    signedIn = googleSignedInFromCookies(cookies);
    evidence = signedIn ? "google session cookies present" : "no google session cookies";
  } else if (origin) {
    signedIn = originSignedInFromCookies(cookies, origin);
    evidence = signedIn ? `cookies for ${origin}` : `no cookies for ${origin}`;
  } else {
    signedIn = googleSignedInFromCookies(cookies) || cookies.length > 0;
    evidence = signedIn ? `${cookies.length} cookies in profile` : "profile has no cookies";
  }
  return {
    slug,
    origin: origin || null,
    signedIn,
    evidence,
    url,
    cookieCount: cookies.length,
  };
}

export async function capabilities() {
  const chromium = await findChromiumExecutable();
  return {
    chromium: Boolean(chromium),
    chromiumPath: chromium || null,
    headedAvailable: wantsHeadedLogin(),
    profile: SHARED_PROFILE_SLUG,
    live: sessionStatus(SHARED_PROFILE_SLUG),
  };
}
