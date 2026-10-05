import { manageUsers, managePeople, listPeople, resolveIdentity, ensurePeopleTenant } from '../server/users.mjs';
import { expenseUserForSession } from '../server/expense-session.mjs';
import { diSessionUser } from '../server/di-session-user.mjs';
// UIv2 host integration for Document Intelligence: boot (migrate, seed, register the
// four micro-agents and their shared MCP server), per-agent tokens, the internal
// endpoint the MCP server calls, and HTML -> PDF rendering.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "../server/paths.mjs";
import { clearAgentSop, getAgentSop, saveAgentSop } from "../server/sops.mjs";
import { migrate, pgAdapter, roleAvailable, withContext } from "./core/db.mjs";
import { ensureDefaultTenant, seedTenant } from "./core/seed.mjs";
import { getCompanyProfile } from './core/company.mjs';
import { runTool, describeError } from "./core/actions.mjs";
import { AGENTS } from "./core/tools.mjs";
import { LIMITS, acceptSubmission, loadPublicForm } from "./core/forms.mjs";
import { renderFormPage, renderMessagePage } from "./core/formpage.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
export const DI_MCP_SERVER = path.join(HERE, "mcp-server.mjs");
export const DI_MCP_SLUG = "document-intelligence";
export const DI_AGENT_IDS = Object.keys(AGENTS);

const SECRET = randomBytes(32);
const state = { db: null, tenantId: null, asRole: true };
/** Where the Forward Deploy Engineer keeps an agent's SOP (the same table the Settings page edits). */
const SOP_STORE = { get: getAgentSop, save: saveAgentSop, clear: clearAgentSop };

const AGENT_CARDS = {
  "di-onboarding": {
    color: "cyan", userFacing: true,
    headline: "Set up your company and start fresh",
    description: "Completes the shared company profile, records company people with their positions and departments, collects invoicing defaults, guides invoice-template setup and custom fields, and directs owners to the reset preview. Shares the manual Company Profile form with users.",
  },
  "di-records": {
    color: "teal",
    userFacing: true,
    headline: "Customers, contacts, products and packages",
    description:
      "Records customers properly: reads name cards, checks for existing customers before saving, fills blanks instead of duplicating. Keeps the product and package catalogue.",
  },
  "di-documents": {
    color: "indigo",
    userFacing: true,
    headline: "Quotations, invoices and payments",
    description:
      "Prepares quotations and invoices the proper way: resolves customer and items, asks what's missing, drafts, issues with gap-free numbering, renders the PDF, converts quotes to invoices and records payments.",
  },
  "di-templates": {
    color: "fuchsia",
    headline: "Quotation and invoice templates",
    description: "Designs and versions the HTML/PDF templates documents are rendered with, and previews them with the real company header.",
  },
  "di-db": {
    color: "slate",
    headline: "Company profile, custom fields, rules and numbering",
    description:
      "Admin for the document system: company profile, company-specific custom fields, what a document needs before it can be issued, numbering, tax codes, archive/restore and the audit log.",
  },
  "di-forms": {
    color: "amber",
    userFacing: true,
    headline: "Design and publish forms",
    description:
      "Builds company forms (applications, job reports, surveys, order forms) from a fixed field vocabulary, checks them for consent and unsafe fields, previews them, and publishes or closes their public links. Editing a live form makes a new version.",
  },
  "di-intake": {
    color: "emerald",
    userFacing: true,
    headline: "Review form submissions",
    description:
      "Reads what people submitted through the company's forms: lists and reviews submissions per form, flags spam, links job reports to customers or invoices, summarises survey results and exports CSVs. Treats every answer as untrusted data.",
  },
  "di-calendar": {
    color: "lime",
    userFacing: true,
    headline: "Keep the company calendar meaningful",
    description:
      "Reads date-bearing company records and turns them into a unified calendar feed. Shows quotation expiry, unpaid invoice due dates, payment receipts, form deadlines and custom date reminders with provenance. Read-only: it never edits business records.",
  },
  "di-procurement": {
    color: "orange",
    userFacing: true,
    headline: "Suppliers, purchase orders and what to pay",
    description:
      "Keeps suppliers, records the quotations and invoices they send, drafts purchase orders from them, records goods received, and checks every invoice against what was ordered and received before it is paid. A Superadmin or the department head issues POs and marks invoices paid; anyone signed in can draft and record.",
  },
  "di-fde": {
    color: "violet",
    userFacing: true,
    headline: "Teach the system your company's rules",
    description:
      "Superadmin only. Changes the company's rules: expense claim checks (previewed, undoable) and any agent's SOP. For example: mileage claims need a route screenshot and the distance.",
  },
  "di-expenses": {
    color: "rose",
    userFacing: true,
    headline: "File receipts and run the monthly claim",
    description:
      "Takes receipts (photos, screenshots, PDFs) and files them as expense claims for the signed-in user, groups every claim into a monthly submission by the company's cut-off day, lets Superadmins and department heads approve or reject, and produces the claim submission report. Regular users only see their own claims.",
  },
};

/** Base for public form links: DI_PUBLIC_URL, else the Railway domain, else localhost. */
export function publicBaseUrl(port = process.env.PORT || "8080") {
  if (process.env.DI_PUBLIC_URL) return process.env.DI_PUBLIC_URL;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return `http://localhost:${port}`;
}

export function diTokenFor(agentId, sessionId = '') {
  return createHmac("sha256", SECRET).update(sessionId ? JSON.stringify(['di', agentId, sessionId]) : `di:${agentId}`).digest("hex");
}

/** Env for a DI agent's Pi process; the MCP server reads these. Empty for other agents. */
export function diAgentEnv(agent, port = process.env.PORT || "8080", sessionId = '') {
  const id = typeof agent === "string" ? agent : agent?.id || agent?.slug || "";
  if (!AGENTS[id]) return {};
  const boundSession = sessionId;
  return { DI_AGENT: id, DI_TOKEN: diTokenFor(id, boundSession), DI_URL: `http://127.0.0.1:${port}`,
    ...(boundSession ? { DI_SESSION_ID: boundSession } : {}) };
}

function agentFromRequest(req, body) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const agent = body?.agent;
  if (!token || !AGENTS[agent]) return null;
  const sessionId = String(req.headers['x-di-session'] || '');
  const expected = Buffer.from(diTokenFor(agent, sessionId));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given) ? agent : null;
}

let browserPromise = null;
async function renderPdf(html, absPath) {
  const { chromium } = await import("playwright");
  const { findChromiumExecutable } = await import("../server/browser.mjs");
  browserPromise ??= (async () => {
    const executablePath = (await findChromiumExecutable().catch(() => null)) || undefined;
    return chromium.launch({ headless: true, executablePath, args: ["--no-sandbox"] });
  })();
  let browser;
  try {
    browser = await browserPromise;
    if (!browser.isConnected()) throw new Error("disconnected");
  } catch {
    browserPromise = null;
    return renderPdf(html, absPath);
  }
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "load", timeout: 20000 });
    await mkdir(path.dirname(absPath), { recursive: true });
    await page.pdf({ path: absPath, format: "A4", printBackground: true, preferCSSPageSize: true });
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Handles POST /api/internal/di. Returns { status, body }.
 * @param {import("node:http").IncomingMessage} req
 * @param {any} body
 * @param {{ workspace: (agent: {id: string, slug: string}) => string }} deps
 */
export async function handleDiRequest(req, body, deps) {
  const agent = agentFromRequest(req, body);
  if (!agent) return { status: 401, body: { ok: false, error: "Unauthorized" } };
  if (["list_users", "create_user", "update_user", "list_people", "create_person", "update_person", "list_company_members", "save_company_member"].includes(body.tool)) {
    if (body.tool !== "list_company_members" && !["di-onboarding", "di-db"].includes(agent)) return { status: 403, body: { ok: false, error: "People and user administration is unavailable for this agent" } };
    try {
      const args = body.args || {};
      let result;
      if (body.tool === "list_company_members") {
        const people = await listPeople(state.tenantId);
        result = { members: people.people, has_more: people.has_more };
      } else if (body.tool === "save_company_member") {
        const saved = await managePeople(args.id ? "update_person" : "create_person", args, { tenantId: state.tenantId, trustedAgent: true });
        result = { member: saved.person, created: !args.id };
      }
      else if (["list_people", "create_person", "update_person"].includes(body.tool)) result = await managePeople(body.tool, args, { tenantId: state.tenantId });
      else result = await manageUsers(body.tool, args, { tenantId: state.tenantId });
      return { status: 200, body: { ok: true, result } };
    } catch (error) { return { status: 403, body: { ok: false, error: error.message } }; }
  }
  if (!state.db) return { status: 503, body: { ok: false, error: "Document Intelligence is not initialised (database not connected?)" } };
  try {
    const sessionId = String(req.headers['x-di-session'] || '');
    const who = agent === 'di-expenses' ? await expenseUserForSession(sessionId)
      : sessionId ? await diSessionUser(agent, sessionId) : undefined;
    if (!who && ['di-documents', 'di-procurement', 'di-db', 'di-fde'].includes(agent)) {
      throw new Error('Sign-in required: financial operations need an authenticated session owner');
    }
    const result = await runTool(
      {
        db: state.db,
        tenantId: () => state.tenantId,
        actor: who?.username || `system:${agent}`,
        asRole: state.asRole,
        resolveIdentity,
        who,
        workspace: (id) => deps.workspace({ id, slug: id }),
        renderPdf,
        publicUrl: publicBaseUrl(),
        filesRoot: path.join(DATA_DIR, "files"),
        sop: SOP_STORE,
      },
      { agent, tool: body.tool, args: body.args },
    );
    return { status: 200, body: { ok: true, result } };
  } catch (error) {
    return { status: 400, body: { ok: false, error: describeError(error) } };
  }
}

/**
 * runTool dependencies for host-side callers that already authenticated a user (the /demo
 * routes), so they go through exactly the same tools as the agents do.
 * @param {{ workspace: (agent: {id: string, slug: string}) => string, who?: object }} opts
 */
export function diRunDeps({ workspace, who } = {}) {
  if (!state.db) throw new Error("Document Intelligence is not ready");
  return {
    db: state.db, tenantId: () => state.tenantId, actor: who?.username || "system", asRole: state.asRole,
    workspace: (id) => workspace({ id, slug: id }), renderPdf,
    publicUrl: publicBaseUrl(), filesRoot: path.join(DATA_DIR, "files"), who,
  };
}

// ---------------------------------------------------------------- public forms

const RATE = { windowMs: 10 * 60 * 1000, max: 10 };
const recent = new Map(); // hash(ip + slug) -> submission timestamps
const MAX_BODY = Math.ceil((LIMITS.submission_mb * 1024 * 1024 * 4) / 3) + 1024 * 1024;

function rateLimited(key, now = Date.now()) {
  const hits = (recent.get(key) || []).filter((t) => now - t < RATE.windowMs);
  if (hits.length >= RATE.max) {
    recent.set(key, hits);
    return true;
  }
  hits.push(now);
  recent.set(key, hits);
  if (recent.size > 5000) for (const [k, v] of recent) if (!v.some((t) => now - t < RATE.windowMs)) recent.delete(k);
  return false;
}

const pageHeaders = (nonce) => ({
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'`,
});
const jsonHeaders = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

/**
 * The public form route without Node's req/res, so tests can drive it:
 * GET renders the live version; POST validates and stores one submission.
 * @param {{ db: any, tenantId: string, asRole?: boolean, workspace?: (agentId: string) => string,
 *           method: string, slug: string, contentType?: string, bodyText?: string, ip?: string }} p
 * @returns {Promise<{ status: number, headers: object, body: string }>}
 */
export async function publicFormRoute({ db, tenantId, asRole = true, workspace, method, slug, contentType = "", bodyText = "", ip = "" }) {
  const ctx = { tenantId, actor: "public", agent: "public-form", asRole };
  if (method === "GET") {
    const nonce = randomBytes(16).toString("base64");
    try {
      const live = await withContext(db, ctx, (tx) => loadPublicForm(tx, slug));
      if (live.closed) return { status: 410, headers: pageHeaders(nonce), body: renderMessagePage(live.form.title, live.closed, live.company) };
      return { status: 200, headers: pageHeaders(nonce), body: renderFormPage({ form: live.form, version: live.version, company: live.company, nonce }) };
    } catch (error) {
      if (error?.details?.code === "not_found") return { status: 404, headers: pageHeaders(nonce), body: renderMessagePage("Form not found", "This form does not exist or is no longer available.") };
      return { status: 500, headers: pageHeaders(nonce), body: renderMessagePage("Something went wrong", "Please try again later.") };
    }
  }
  if (method !== "POST") return { status: 405, headers: jsonHeaders, body: JSON.stringify({ ok: false, error: "Method not allowed" }) };
  if (!/^application\/json\b/i.test(contentType)) return { status: 415, headers: jsonHeaders, body: JSON.stringify({ ok: false, error: "Send JSON" }) };
  const submitterHash = createHmac("sha256", SECRET).update(`ip:${ip}`).digest("hex").slice(0, 32);
  if (rateLimited(`${submitterHash}:${slug}`)) {
    return { status: 429, headers: jsonHeaders, body: JSON.stringify({ ok: false, error: "Too many submissions. Please wait a few minutes." }) };
  }
  let body;
  try {
    body = JSON.parse(bodyText || "{}");
  } catch {
    return { status: 400, headers: jsonHeaders, body: JSON.stringify({ ok: false, error: "Malformed request" }) };
  }
  const written = [];
  const storeFile = async ({ submissionId, index, name, buffer }) => {
    if (!workspace) return null;
    const rel = `form-uploads/${slug}/${submissionId.slice(0, 8)}/${index + 1}-${name}`;
    const abs = path.join(workspace("di-intake"), rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, buffer);
    written.push(abs);
    return rel;
  };
  try {
    const out = await withContext(db, ctx, (tx) => acceptSubmission(tx, { slug, body, submitterHash, storeFile }));
    return { status: 200, headers: jsonHeaders, body: JSON.stringify({ ok: true, message: out.message }) };
  } catch (error) {
    await Promise.all(written.map((f) => rm(f, { force: true }).catch(() => {})));
    const code = error?.details?.code;
    const status = { not_found: 404, closed: 410, invalid: 400, quota: 503 }[code] || 500;
    const message = status === 500 ? "Something went wrong. Please try again later." : error.message;
    return { status, headers: jsonHeaders, body: JSON.stringify({ ok: false, error: message, errors: error?.details?.errors }) };
  }
}

function readCapped(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
        req.destroy();
        reject(Object.assign(new Error("too large"), { tooLarge: true }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Handles GET/POST /api/forms/<slug> (public, no login). Uploaded files land in the
 * Form Clerk's workspace under form-uploads/.
 * @param {{ workspace: (agent: {id: string, slug: string}) => string }} deps
 */
export async function handlePublicForm(req, res, url, deps) {
  const slug = decodeURIComponent(url.pathname.slice("/api/forms/".length)).replace(/\/+$/, "").toLowerCase();
  const send = ({ status, headers, body }) => {
    res.writeHead(status, headers);
    res.end(body);
  };
  if (!state.db) return send({ status: 503, headers: jsonHeaders, body: JSON.stringify({ ok: false, error: "Forms are not available right now" }) });
  let bodyText = "";
  if (req.method === "POST") {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > MAX_BODY) return send({ status: 413, headers: jsonHeaders, body: JSON.stringify({ ok: false, error: `Uploads are limited to ${LIMITS.submission_mb} MB in total` }) });
    try {
      bodyText = await readCapped(req, MAX_BODY);
    } catch (error) {
      if (error?.tooLarge) return send({ status: 413, headers: jsonHeaders, body: JSON.stringify({ ok: false, error: `Uploads are limited to ${LIMITS.submission_mb} MB in total` }) });
      throw error;
    }
  }
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  send(
    await publicFormRoute({
      db: state.db,
      tenantId: state.tenantId,
      asRole: state.asRole,
      workspace: (id) => deps.workspace({ id, slug: id }),
      method: req.method,
      slug,
      contentType: String(req.headers["content-type"] || ""),
      bodyText,
      ip: forwarded || req.socket?.remoteAddress || "",
    }),
  );
}

/**
 * Boot: migrate the di schema, seed the default tenant, upsert the micro-agents and
 * attach the shared MCP server to each.
 */
export async function ensureDocumentIntelligence({ pool, catalog, logEvent = () => {} }) {
  const db = pgAdapter(pool);
  const applied = await migrate(db);
  state.asRole = await roleAvailable(db);
  if (!state.asRole) logEvent("warn", "di: role di_app unavailable; agents run without database role separation");
  state.tenantId = await ensureDefaultTenant(db);
  await seedTenant(db, state.tenantId);
  await ensurePeopleTenant(state.tenantId).catch((error) => logEvent('warn', `people account migration skipped: ${error.message}`));
  state.db = db;

  for (const [id, meta] of Object.entries(AGENTS)) {
    const card = AGENT_CARDS[id];
    const role = await readFile(path.join(ROOT, "agent", "roles", `${id}.md`), "utf8").catch(() => `You are ${meta.name}.`);
    await catalog.seedSystemAgent({
      id,
      slug: id,
      name: meta.name,
      short: meta.short,
      headline: card.headline,
      description: card.description,
      color: card.color,
      rolePrompt: role,
      toolProfile: "assistant",
      thinkingLevel: "low",
      userFacing: Boolean(card.userFacing),
    });
  }
  const payload = {
    name: "Document Intelligence",
    slug: DI_MCP_SLUG,
    command: process.execPath,
    args: [DI_MCP_SERVER],
    description: "CRM, catalogue, quotations, invoices, payments, templates, company settings and the read-only calendar feed in Postgres (schema di). Each DI agent sees only its own tools.",
  };
  const existing = await catalog.getMcpServer(DI_MCP_SLUG);
  if (existing) await catalog.updateMcpServer(existing.id, payload);
  else await catalog.createMcpServer(payload);
  for (const id of DI_AGENT_IDS) await catalog.attachAgentResources(id, { skills: [], mcp: [DI_MCP_SLUG] });
  return { applied, tenantId: state.tenantId, roleSeparation: state.asRole };
}

/** Live host-selected tenant context; callers never supply a tenant id. */
export function companyHostContext() {
  if (!state.db || !state.tenantId) throw new Error("Document Intelligence is not ready");
  return { db: state.db, tenantId: state.tenantId, asRole: state.asRole };
}

export async function companyOnboardingStatus() {
  const ctx = companyHostContext();
  const result = await withContext(ctx.db, { ...ctx, agent: 'orchestrator' }, getCompanyProfile);
  // Orchestrator needs readiness, not bank details or the rest of the private profile.
  return { ...result.readiness, revision: result.company.revision, company_name: result.company.name,
    form_url: result.form_url, onboarding_agent: result.onboarding_agent };
}
