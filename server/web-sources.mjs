import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { chromium } from "playwright";
import { findChromiumExecutable } from "./browser.mjs";
import { sourceStore } from "./temp-sources.mjs";

export const WEB_SOURCE_TOKEN = randomBytes(32).toString("hex");
const inFlight = new Map();
let browserPromise;
let browserIdleTimer;

export async function closeWebSourceBrowser() {
  clearTimeout(browserIdleTimer);
  const pending = browserPromise;
  browserPromise = undefined;
  if (pending) await (await pending).close();
}

function privateAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  // Only globally routable IPv6 (2000::/3); this also blocks IPv4-mapped forms.
  return !/^[23][0-9a-f]{3}:/i.test(address);
}

export async function publicSourceUrl(input, resolver = lookup) {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Use a public HTTP(S) URL without embedded credentials");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [{ address: hostname }] : await resolver(hostname, { all: true });
  if (!addresses.length || addresses.some(item => privateAddress(item.address))) throw new Error("Private or local network URLs cannot be fetched");
  url.hash = "";
  return url.href;
}

async function extractPage(url) {
  clearTimeout(browserIdleTimer);
  browserPromise ??= (async () => chromium.launch({ executablePath: (await findChromiumExecutable()) || undefined, headless: true, args: ["--no-sandbox"] }))();
  let browser;
  try { browser = await browserPromise; if (!browser.isConnected()) throw new Error("Browser disconnected"); }
  catch (error) { browserPromise = undefined; throw error; }
  const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
  const checked = new Map();
  try {
    await context.route("**/*", async route => {
      const request = route.request();
      try {
        if (!checked.has(request.url())) checked.set(request.url(), publicSourceUrl(request.url()));
        await checked.get(request.url());
        if (["image", "media", "font"].includes(request.resourceType())) return route.abort();
        await route.continue();
      } catch { await route.abort(); }
    });
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (!response || !response.ok()) throw new Error(`Page fetch failed (HTTP ${response?.status() ?? "unknown"})`);
    if (/application\/pdf/i.test(response.headers()["content-type"] || "")) throw new Error("This URL is a PDF. Use document extraction instead of a web page fetch.");
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    // Wait briefly for client-rendered text to stabilize; this is extraction, not model reasoning.
    let previous = "";
    for (let n = 0; n < 4; n++) {
      const current = await page.locator("body").innerText({ timeout: 10000 });
      if (current && current === previous) break;
      previous = current;
      await page.waitForTimeout(350);
    }
    const extracted = await page.evaluate(() => ({
      title: document.title,
      text: document.body.innerText,
      headings: Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map(node => node.innerText.trim()).filter(Boolean),
    }));
    return { ...extracted, finalUrl: page.url(), extraction: "rendered-page-text" };
  } finally {
    await context.close();
    browserIdleTimer = setTimeout(() => { if (!inFlight.size) void closeWebSourceBrowser().catch(() => {}); }, 60000);
    browserIdleTimer.unref();
  }
}

export async function fetchWebSource({ url, fresh = false }, { store = sourceStore, extract = extractPage, validate = publicSourceUrl } = {}) {
  const normalized = await validate(url);
  if (!fresh) {
    const cached = (await store.list()).sources.find(item => item.storedInFull && item.url === normalized && Date.now() - Date.parse(item.fetchedAt) < 24 * 60 * 60 * 1000);
    if (cached) return { ...cached, reused: true };
  }
  if (inFlight.has(normalized)) return inFlight.get(normalized);
  if (inFlight.size >= 2) throw new Error("Two page fetches are already running. Wait for them to finish before requesting another.");
  const work = (async () => {
    const extracted = await extract(normalized);
    return { ...await store.save({ ...extracted, url: normalized, fetchedAt: new Date().toISOString() }), reused: false };
  })();
  inFlight.set(normalized, work);
  try { return await work; } finally { inFlight.delete(normalized); }
}

export function webSourceAuthorized(req) {
  const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const given = Buffer.from(supplied), expected = Buffer.from(WEB_SOURCE_TOKEN);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function webSourceAction(body) {
  if (body.action === "fetch") return fetchWebSource(body);
  if (body.action === "read") return sourceStore.read(body);
  if (body.action === "metadata") return sourceStore.metadata(body.id);
  if (body.action === "save") return sourceStore.save(body);
  if (body.action === "allocate") return sourceStore.allocate(body);
  if (body.action === "import") return sourceStore.importFile(body);
  throw new Error("Unknown web source action");
}
