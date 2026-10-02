import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { DATA_DIR, ROOT, agentWorkspace } from "../paths.mjs";
import { getAgent, getMcpServer, createMcpServer, updateMcpServer, seedSystemAgent, updateAgent } from "../catalog.mjs";
import { ADS_RESEARCH_AGENT_ID, adsResearchAuthorized } from "./auth.mjs";
import { AdsResearchStore } from "./store.mjs";

const PORTABLE_ROOT = process.env.ADS_RESEARCH_PORTABLE_ROOT?.trim()
  ? path.resolve(process.env.ADS_RESEARCH_PORTABLE_ROOT)
  : path.resolve(ROOT, "..", "003-ads-research", "portable");
const PORTABLE_CLI = path.join(PORTABLE_ROOT, "cli.mjs");
const ADS_ROOT = path.join(DATA_DIR, "ads-research");
const CONFIG_ROOT = path.join(ADS_ROOT, "config");
const DATA_ROOT = path.join(ADS_ROOT, "runtime");
const JOB_ROOT = path.join(ADS_ROOT, "jobs");
const MAX_TEXT = 120;
const RUN_TIMEOUT_MS = Math.max(60_000, Number(process.env.ADS_RESEARCH_TIMEOUT_MS) || 30 * 60_000);
const COUNTRY_CODES = {
  malaysia: ["MY", "Malaysia"], singapore: ["SG", "Singapore"], indonesia: ["ID", "Indonesia"],
  thailand: ["TH", "Thailand"], philippines: ["PH", "Philippines"], vietnam: ["VN", "Vietnam"],
  australia: ["AU", "Australia"], "united states": ["US", "United States"], usa: ["US", "United States"],
  "united kingdom": ["GB", "United Kingdom"], uk: ["GB", "United Kingdom"],
};

let store;
let busy = false;
let stopped = false;
let activeChild;

function cleanText(value, name) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!text || text.length > MAX_TEXT) throw new Error(`${name} is required and must be at most ${MAX_TEXT} characters`);
  if ([...text].some(char => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  })) throw new Error(`${name} contains unsupported control characters`);
  return text;
}

export function normalizeAdsInput({ country, keyword, language = "en" }) {
  const rawCountry = cleanText(country, "country");
  const key = rawCountry.toLowerCase();
  const known = COUNTRY_CODES[key];
  const isCode = /^[A-Za-z]{2}$/.test(rawCountry);
  if (!known && !isCode) throw new Error("country must be a known country or a two-letter country code");
  const [region, label] = known || [rawCountry.toUpperCase(), rawCountry.toUpperCase()];
  const term = cleanText(keyword, "keyword");
  const lang = String(language || "en").toLowerCase();
  if (!/^(en|zh)$/.test(lang)) throw new Error("language must be en or zh");
  const slug = `${label}-${term}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "ads-research";
  const hash = createHash("sha256").update(`${region}\n${term.toLowerCase()}\n${lang}`).digest("hex").slice(0, 12);
  return { country: label, region, keyword: term, language: lang, topic: `ads-${slug}-${hash}` };
}

function regexEscape(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function configFor(input) {
  const term = regexEscape(input.keyword);
  const country = regexEscape(input.country);
  const domains = String(process.env.ADS_RESEARCH_ATC_DOMAINS || "").split(",").map(x => x.trim()).filter(Boolean).slice(0, 100);
  let advertiserIds = [];
  try { advertiserIds = JSON.parse(process.env.ADS_RESEARCH_ATC_ADVERTISERS || "[]"); } catch { /* invalid optional configuration means no pinned advertisers */ }
  return {
    topic: input.topic,
    label: `${input.country} ${input.keyword} advertising research`,
    region: input.region,
    filterVersion: 1,
    analysisVersion: 1,
    meta: { enabled: true, queries: [input.keyword, `${input.keyword} ${input.country}`, `${input.country} ${input.keyword} price`], scrolls: 3, scrollWaitMs: 1800, settleMs: 4500 },
    googleAtc: { enabled: true, domains, advertiserIds, maxPerAdvertiser: 100, settleMs: 4500 },
    googleSerp: { enabled: false, queries: [] },
    filter: {
      mustMatch: `(${term})`,
      regionMatch: `(${country}|${regexEscape(input.region)})`,
      coreMatch: `(${term})`,
      offTopic: "",
      tiers: {},
      trustSeedChannels: ["google_atc"],
    },
    angles: [["Offer and positioning", term], ["Country-market fit", `(${term}|${country})`]],
    publish: { enabled: false, autoPublish: false, slug: input.topic, name: `${input.country} ${input.keyword} Ads Research` },
  };
}

async function ensureConfig(input) {
  const dir = path.join(CONFIG_ROOT, "topics");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${input.topic}.json`);
  let fallback = {};
  try {
    fallback = JSON.parse(await readFile(path.join(PORTABLE_ROOT, "config", "topics", "my-solar.json"), "utf8"));
  } catch { /* a deployment may provide only the portable source package */ }
  const generated = configFor(input);
  const cfg = {
    ...fallback,
    ...generated,
    meta: { ...fallback.meta, ...generated.meta },
    googleAtc: {
      ...fallback.googleAtc,
      ...generated.googleAtc,
      domains: generated.googleAtc.domains.length ? generated.googleAtc.domains : (fallback.googleAtc?.domains || []),
      advertiserIds: generated.googleAtc.advertiserIds.length ? generated.googleAtc.advertiserIds : (fallback.googleAtc?.advertiserIds || []),
    },
    googleSerp: { ...fallback.googleSerp, ...generated.googleSerp },
    filter: { ...fallback.filter, ...generated.filter },
    publish: { ...fallback.publish, ...generated.publish },
  };
  await writeFile(file, JSON.stringify(cfg, null, 2));
  return file;
}

function baseUrl() {
  const base = process.env.ADS_RESEARCH_PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");
  return base.replace(/\/+$/, "");
}
function reportUrl(id) {
  const pathname = `/reports/ads-research/${id}/report.html`;
  const base = baseUrl();
  return base ? new URL(pathname, `${base}/`).href : pathname;
}
function topicOut(input) { return path.join(DATA_ROOT, "out", input.topic); }

function safeOutput(text) { return String(text || "").replace(/(?:sk-|tvly-)[A-Za-z0-9_-]+/g, "[redacted]").slice(-4000); }
function runPortable(input) {
  return new Promise((resolve, reject) => {
    const env = {
      PATH: process.env.PATH || "", HOME: process.env.HOME || process.env.USERPROFILE || "", NODE_PATH: process.env.NODE_PATH || "",
      ADS_CONFIG_ROOT: CONFIG_ROOT, DATA_ROOT, PUBLIC_BASE_URL: baseUrl(), HOSTED_MODE: "true", NODE_ENV: "production",
      ...(process.env.ADS_LLM_BASE_URL ? { ADS_LLM_BASE_URL: process.env.ADS_LLM_BASE_URL } : {}),
      ...(process.env.ADS_LLM_MODEL ? { ADS_LLM_MODEL: process.env.ADS_LLM_MODEL } : {}),
      ...(process.env.ADS_LLM_KEY ? { ADS_LLM_KEY: process.env.ADS_LLM_KEY } : {}),
      ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
    };
    const args = [PORTABLE_CLI, "run", "--topic", input.topic, "--lang", input.language, "--archive", "false"];
    const child = spawn(process.execPath, args, { cwd: PORTABLE_ROOT, env: { ...env }, windowsHide: true });
    activeChild = child;
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Ads research timed out")); }, RUN_TIMEOUT_MS);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer); activeChild = undefined;
      if (code !== 0) return reject(new Error(`Ads research failed (${code}): ${safeOutput(stderr)}`));
      try { resolve({ output: JSON.parse(stdout), log: safeOutput(stderr) }); }
      catch { reject(new Error(`Ads research returned invalid JSON: ${safeOutput(stdout)} ${safeOutput(stderr)}`)); }
    });
  });
}

async function tick(log) {
  if (busy || stopped || !store) return;
  const jobs = [...store.jobs.values()].filter(row => row.status === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const job = jobs[0];
  if (!job) return;
  busy = true;
  try {
    await store.update(job.id, { status: "running" });
    const input = normalizeAdsInput(job);
    await ensureConfig(input);
    const run = await runPortable(input);
    const result = run.output || {};
    const report = result.report || {};
    await store.update(job.id, {
      status: "complete",
      result: {
        collection: result.collection || null,
        analysis: result.analysis || null,
        report: { ...report, url: reportUrl(job.id) },
        log: run.log,
        atcConfigured: Boolean(process.env.ADS_RESEARCH_ATC_DOMAINS || process.env.ADS_RESEARCH_ATC_ADVERTISERS),
      },
    });
  } catch (error) {
    await store.update(job.id, { status: "failed", error: String(error.message || error).slice(0, 1000) });
    log?.("warn", `ads research job ${job.id} failed: ${error.message}`);
  } finally { busy = false; }
}

export async function ensureAdsResearch({ log = () => {} } = {}) {
  store = new AdsResearchStore(JOB_ROOT);
  await store.load();
  const rolePrompt = await readFile(path.join(ROOT, "agent", "roles", "ads-research.md"), "utf8");
  await seedSystemAgent({ id: ADS_RESEARCH_AGENT_ID, slug: ADS_RESEARCH_AGENT_ID, name: "Ads Research Agent", short: "AR", headline: "Country and keyword advertising intelligence", description: "Runs read-only Meta and Google Ads Transparency Center research and returns evidence-backed reports.", color: "amber", rolePrompt, toolProfile: "assistant", thinkingLevel: "low" });
  await mkdir(agentWorkspace({ id: ADS_RESEARCH_AGENT_ID, slug: ADS_RESEARCH_AGENT_ID }), { recursive: true });
  const payload = { name: "Ads Research", slug: "ads-research", command: process.execPath, args: [path.join(ROOT, "server", "ads-research", "mcp-server.mjs")], description: "Runs country and advertising-keyword research using the portable Meta and Google ATC collectors.", config: { directTools: true, lifecycle: "eager" } };
  const old = await getMcpServer(payload.slug);
  const mcp = old ? await updateMcpServer(old.id, payload) : await createMcpServer(payload);
  const agent = await getAgent(ADS_RESEARCH_AGENT_ID);
  await updateAgent(agent.id, { skillIds: [], mcpIds: [mcp.id] });
  stopped = false;
  clearInterval(ensureAdsResearch.timer);
  ensureAdsResearch.timer = setInterval(() => void tick(log), 2000);
  ensureAdsResearch.timer.unref?.();
  return { portableRoot: PORTABLE_ROOT, ready: true };
}

export async function stopAdsResearch() {
  stopped = true;
  clearInterval(ensureAdsResearch.timer);
  if (activeChild && !activeChild.killed) activeChild.kill("SIGTERM");
}

export async function adsResearchAction({ action, id, country, keyword, language = "en", format = "json" }, repository = store) {
  if (!repository) throw new Error("Ads research is not initialized");
  if (action === "start") return repository.enqueue(normalizeAdsInput({ country, keyword, language }));
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error("Valid research id required");
  const row = await repository.get(id);
  if (!row) throw new Error("Ads research job not found");
  if (action === "get") return { ...row, report_url: row.status === "complete" ? reportUrl(id) : null };
  if (action === "artifact") {
    if (!row.result) throw new Error("Ads research is not ready");
    if (!["json", "md"].includes(format)) throw new Error("format must be json or md");
    const content = format === "json" ? JSON.stringify(row.result, null, 2) : `# ${row.country} ${row.keyword} Ads Research\n\nReport: ${reportUrl(id)}\n\n${JSON.stringify(row.result, null, 2)}`;
    return { format, url: `${baseUrl()}/api/ads-research/jobs/${id}/artifact?format=${format}`, content };
  }
  throw new Error("Unknown ads research action");
}

export async function handleAdsResearch(req, res, url, { authorized, readBody, repository = store }) {
  const reportPrefix = "/reports/ads-research/";
  if (url.pathname.startsWith(reportPrefix)) {
    if (!authorized(req)) { res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Unauthorized"); return true; }
    const match = url.pathname.slice(reportPrefix.length).match(/^([0-9a-f-]{36})\/(report\.html|shots\/([A-Za-z0-9._-]+))$/i);
    if (!match || req.method !== "GET") { res.writeHead(match ? 405 : 404, { Allow: "GET" }); res.end(match ? "GET required" : "Report not found"); return true; }
    const row = await repository?.get(match[1]);
    if (!row || row.status !== "complete") { res.writeHead(404); res.end("Report not found"); return true; }
    const file = path.join(topicOut(row), match[2]);
    const root = topicOut(row);
    if (path.relative(root, file).startsWith("..")) { res.writeHead(404); res.end("Report not found"); return true; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": match[2] === "report.html" ? "text/html; charset=utf-8" : "image/png", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src https://fonts.googleapis.com" });
      res.end(body);
    } catch { res.writeHead(404); res.end("Report not found"); }
    return true;
  }
  const internal = url.pathname === "/api/internal/ads-research";
  const prefix = "/api/ads-research/jobs";
  if (!internal && !url.pathname.startsWith(prefix)) return false;
  const json = (code, body) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "private, no-store" }); res.end(JSON.stringify(body)); };
  if (!(internal ? adsResearchAuthorized(req) : authorized(req))) { json(401, { error: "Unauthorized" }); return true; }
  if (!repository) { json(503, { error: "Ads research is not initialized" }); return true; }
  try {
    if (internal) { if (req.method !== "POST") { json(405, { error: "POST required" }); return true; } json(200, { ok: true, result: await adsResearchAction(JSON.parse(await readBody(req) || "{}"), repository) }); return true; }
    if (req.method === "POST" && url.pathname === prefix) { json(202, await adsResearchAction({ action: "start", ...(JSON.parse(await readBody(req) || "{}")) }, repository)); return true; }
    const match = url.pathname.slice(prefix.length).match(/^\/([0-9a-f-]{36})(?:\/artifact)?$/i);
    if (!match || req.method !== "GET") { json(404, { error: "Unknown ads research route" }); return true; }
    if (url.pathname.endsWith("/artifact")) { const out = await adsResearchAction({ action: "artifact", id: match[1], format: url.searchParams.get("format") || "json" }, repository); res.writeHead(200, { "Content-Type": out.format === "md" ? "text/markdown; charset=utf-8" : "application/json", "Cache-Control": "private, no-store" }); res.end(out.content); return true; }
    json(200, await adsResearchAction({ action: "get", id: match[1] }, repository));
  } catch (error) { json(400, { error: error.message }); }
  return true;
}
