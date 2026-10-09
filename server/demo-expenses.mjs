// The Expenses area of /demo (/api/demo/expenses*). Only signed-in demo users reach this (index.mjs
// checks first). Every action runs through the same tools the Expenses Clerk uses, as that user, so
// the rules (admins see and approve everything, users only their own, receipts checked by content,
// closed months frozen) are the ones the chat agent obeys, not a second copy.
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runTool, describeError } from "../document_inteligence/core/actions.mjs";
import { withContext } from "../document_inteligence/core/db.mjs";
import { getReceiptFile } from "../document_inteligence/core/expenses.mjs";
import { seedDemoClaims } from "../document_inteligence/core/expense-demo.mjs";
import { loadLayout, resetLayout, resolveLayout, saveLayout } from "../document_inteligence/core/page-layout.mjs";
import { tenantContext, diRunDeps } from "../document_inteligence/host.mjs";
import { logEvent } from "./debug.mjs";
import { DATA_DIR } from "./paths.mjs";
import { readSharedFile, sharedFileLocation } from "./shared-files.mjs";

const AGENT = "di-expenses";
const MAX_UPLOADS = 5;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MONTH = /^\d{4}-\d{2}$/;
const safeName = (name) => path.basename(String(name || "receipt")).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "receipt";

const toolCall = (opts, who) => (tool, args = {}) =>
  runTool(diRunDeps({ workspace: opts.workspace, who, companyId: who.company_tenant_id }), { agent: AGENT, tool, args });

const LAYOUT_PAGE = "expenses";

/** Runs `fn` in a transaction scoped to the company, as `who`. The page layout is page chrome, not an agent tool. */
const inCompany = (who, fn) => {
  const ctx = tenantContext(who.company_tenant_id);
  return withContext(ctx.db, { ...ctx, actor: who.username, agent: AGENT }, fn);
};

/** How this company has chosen to show the page. If it can't be read, the page still draws, on the default. */
const layoutFor = (who) =>
  inCompany(who, (tx) => loadLayout(tx, LAYOUT_PAGE)).catch((error) => {
    logEvent("warn", `expenses page layout unavailable, using the default: ${describeError(error)}`);
    return { ...resolveLayout(LAYOUT_PAGE, {}), rev: 0, customized: false, override_invalid: false, unavailable: true };
  });

/** Everything the panel needs for one month, limited to what `who` may see. */
async function panelState(opts, who, month) {
  const call = toolCall(opts, who);
  const [settings, subs, layout] = await Promise.all([call("get_expense_settings"), call("list_monthly_submissions", { limit: 12 }), layoutFor(who)]);
  const open = [...subs.submissions].reverse().find((s) => s.status === "open");
  const key = month && MONTH.test(month) ? month : open?.period_key ?? subs.submissions[0]?.period_key ?? settings.current_submission.period_key;
  const selected = subs.submissions.find((s) => s.period_key === key) ?? null;
  const claims = selected ? await call("list_claims", { month: key, limit: 50 }) : { claims: [], totals: null, has_more: false };
  const people = who.role === "admin" ? (await call("list_company_members")).members : [];
  return {
    me: settings.me, settings: settings.settings, categories: settings.categories, payment_methods: settings.payment_methods,
    today: settings.today, current_submission: settings.current_submission, submissions: subs.submissions,
    month: key, selected, claims: claims.claims, totals: claims.totals, has_more: claims.has_more, scope: subs.scope,
    people: people.map((p) => ({ id: p.id, name: p.name, department: p.department })),
    layout,
  };
}

/** Writes uploaded receipts where the Clerk's own chat attachments go, so file_claim treats both alike. */
async function storeUploads(opts, who, uploads) {
  const list = Array.isArray(uploads) ? uploads : [];
  if (list.length > MAX_UPLOADS) throw new Error(`Attach at most ${MAX_UPLOADS} receipts`);
  const dir = path.join(diRunDeps({ workspace: opts.workspace, who, companyId: who.company_tenant_id }).workspace(AGENT), "_inbox");
  await mkdir(dir, { recursive: true });
  const stamp = Date.now();
  const paths = [];
  for (const [index, item] of list.entries()) {
    const raw = String(item?.data || "");
    const bytes = Buffer.from(raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw, "base64");
    if (!bytes.length) throw new Error("A receipt file was empty");
    if (bytes.length > MAX_UPLOAD_BYTES) throw new Error("Each receipt must be under 8 MB");
    const stored = `${stamp}-${index + 1}-${safeName(item?.name)}`;
    await writeFile(path.join(dir, stored), bytes);
    paths.push(`_inbox/${stored}`);
  }
  return paths;
}

async function act(opts, who, body) {
  const call = toolCall(opts, who);
  switch (String(body?.action || "")) {
    case "claim": {
      const receipts = await storeUploads(opts, who, body.attachments);
      const f = body.claim || {};
      return call("file_claim", {
        expense_date: f.expense_date, merchant: f.merchant, category: f.category, amount: Number(f.amount),
        ...(f.tax_amount ? { tax_amount: Number(f.tax_amount) } : {}),
        ...(f.description ? { description: f.description } : {}),
        ...(f.payment_method ? { payment_method: f.payment_method } : {}),
        ...(f.claimant ? { claimant: f.claimant } : {}),
        ...(f.no_receipt_reason ? { no_receipt_reason: f.no_receipt_reason } : {}),
        ...(f.allow_duplicate ? { allow_duplicate: true } : {}),
        receipts,
      });
    }
    case "review":
      return call("review_claim", { claim: String(body.claim || ""), decision: body.decision, note: body.note });
    case "withdraw":
      return call("withdraw_claim", { claim: String(body.claim || ""), reason: body.reason });
    case "close":
      return call("close_monthly_submission", { month: String(body.month || ""), carry_forward_pending: Boolean(body.carry_forward_pending) });
    case "settings":
      return call("set_expense_settings", { cutoff_day: Number(body.cutoff_day) });
    case "layout_save":
      return inCompany(who, (tx) => saveLayout(tx, LAYOUT_PAGE, body.config, { who, expected_rev: body.expected_rev }));
    case "layout_reset":
      return inCompany(who, (tx) => resetLayout(tx, LAYOUT_PAGE, { who }));
    case "seed":
      return seedDemoClaims(diRunDeps({ workspace: opts.workspace, who, companyId: who.company_tenant_id }), who);
    default:
      throw new Error("Unknown expenses action");
  }
}

async function sendStored(res, opts, stored, { name, mime, download = false }) {
  const { full, file } = await readSharedFile({ root: path.join(DATA_DIR, "files"), companyId: opts.user.company_tenant_id, ...stored });
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": file.bytes,
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${safeName(name)}"`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  });
  createReadStream(full).pipe(res);
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {URL} url
 * @param {{ user: any, readBody: (req: any) => Promise<string>, json: Function, workspace: (agent: {id: string, slug: string}) => string }} opts
 * @returns {Promise<boolean>} true when the request was an expenses route (and has been answered)
 */
export async function handleDemoExpenses(req, res, url, opts) {
  const { pathname } = url;
  if (!pathname.startsWith("/api/demo/expenses")) return false;
  const { user: who, json } = opts;
  try {
    if (req.method === "GET" && pathname === "/api/demo/expenses") {
      json(res, 200, await panelState(opts, who, url.searchParams.get("month")));
    } else if (req.method === "GET" && pathname === "/api/demo/expenses/claim") {
      json(res, 200, await toolCall(opts, who)("get_claim", { claim: String(url.searchParams.get("claim") || "") }));
    } else if (req.method === "GET" && pathname === "/api/demo/expenses/receipt") {
      const ctx = tenantContext(who.company_tenant_id);
      const receipt = await withContext(ctx.db, { ...ctx, actor: who.username, agent: AGENT }, (tx) => getReceiptFile(tx, String(url.searchParams.get("id") || ""), { who }));
      const stored = sharedFileLocation(receipt.path);
      if (!stored) throw new Error("Receipt file is not available");
      await sendStored(res, opts, stored, { name: receipt.name, mime: receipt.mime });
    } else if (req.method === "GET" && pathname === "/api/demo/expenses/report") {
      const out = await toolCall(opts, who)("claim_report", {
        ...(MONTH.test(url.searchParams.get("month") || "") ? { month: url.searchParams.get("month") } : {}),
        ...(url.searchParams.get("claimant") ? { claimant: url.searchParams.get("claimant") } : {}),
      });
      const stored = out.pdf?.id ? { id: out.pdf.id, name: out.pdf.name } : null;
      if (!stored) json(res, 503, { error: "The PDF renderer is not available on this host" });
      else await sendStored(res, opts, stored, { name: out.pdf.name, mime: "application/pdf" });
    } else if (req.method === "POST" && pathname === "/api/demo/expenses") {
      const body = JSON.parse((await opts.readBody(req)) || "{}");
      json(res, 200, { result: await act(opts, who, body) });
    } else {
      json(res, 404, { error: "Not found" });
    }
  } catch (error) {
    if (!res.headersSent) json(res, 400, { error: describeError(error) });
    else res.destroy();
  }
  return true;
}
