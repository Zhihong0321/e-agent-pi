// The Procurement area of /demo (/api/demo/procurement*). Only signed-in demo users reach this
// (index.mjs checks first). Every action runs through the same tools the Procurement Clerk uses,
// as that user, so the rules (admins issue POs and pay invoices, goods can't be over-received, an
// invoice that doesn't match its PO needs confirmation) are the ones the chat agent obeys.
import { createReadStream } from "node:fs";
import path from "node:path";
import { runTool, describeError } from "../document_inteligence/core/actions.mjs";
import { withContext } from "../document_inteligence/core/db.mjs";
import { getSupplierDocumentFile } from "../document_inteligence/core/procurement.mjs";
import { seedDemoProcurement } from "../document_inteligence/core/procurement-demo.mjs";
import { companyHostContext, diRunDeps } from "../document_inteligence/host.mjs";
import { DATA_DIR } from "./paths.mjs";
import { readSharedFile, sharedFileLocation } from "./shared-files.mjs";

const AGENT = "di-procurement";
const safeName = (name) => path.basename(String(name || "file")).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "file";

const toolCall = (opts, who) => (tool, args = {}) =>
  runTool(diRunDeps({ workspace: opts.workspace, who }), { agent: AGENT, tool, args });

/** Everything the panel needs, in one round trip. */
async function panelState(opts, who) {
  const call = toolCall(opts, who);
  const [overview, pos, invoices, quotations, suppliers] = await Promise.all([
    call("procurement_overview"), call("list_pos", { limit: 50 }),
    call("list_supplier_documents", { doc_type: "invoice", limit: 50 }), call("list_supplier_documents", { doc_type: "quotation", limit: 50 }),
    call("find_suppliers", { limit: 50 }),
  ]);
  return { me: { username: who.username, role: who.role }, overview, pos: pos.pos, invoices: invoices.documents, quotations: quotations.documents, suppliers: suppliers.suppliers };
}

async function act(opts, who, body) {
  const call = toolCall(opts, who);
  switch (String(body?.action || "")) {
    case "draft": {
      const f = body.po || {};
      return call("create_po_draft", {
        ...(f.supplier ? { supplier: f.supplier } : {}), ...(f.from_quotation ? { from_quotation: f.from_quotation } : {}),
        ...(Array.isArray(f.lines) && f.lines.length ? { lines: f.lines.map((l) => ({ description: l.description, quantity: Number(l.quantity), unit_price: Number(l.unit_price), tax_rate: Number(l.tax_rate || 0) })) } : {}),
        ...(f.expected_date ? { expected_date: f.expected_date } : {}), ...(f.ship_to ? { ship_to: f.ship_to } : {}), ...(f.notes ? { notes: f.notes } : {}),
      });
    }
    case "issue": return call("issue_po", { po: String(body.po || "") });
    case "cancel_po": return call("cancel_po", { po: String(body.po || ""), reason: String(body.reason || "") });
    case "receive": {
      const lines = Array.isArray(body.lines) ? body.lines.map((l) => ({ line_no: Number(l.line_no), quantity: Number(l.quantity) })).filter((l) => l.quantity > 0) : [];
      return call("receive_goods", body.receive_all ? { po: String(body.po || ""), receive_all: true } : { po: String(body.po || ""), lines, ...(body.note ? { note: String(body.note) } : {}) });
    }
    case "invoice_status":
      return call("set_supplier_invoice_status", {
        invoice: String(body.invoice || ""), status: body.status, ...(body.reason ? { reason: String(body.reason) } : {}),
        ...(body.reference ? { reference: String(body.reference) } : {}), ...(body.confirm_mismatch ? { confirm_mismatch: true } : {}),
      });
    case "quotation":
      return call("decide_supplier_quotation", { doc: String(body.doc || ""), decision: body.decision, ...(body.note ? { note: String(body.note) } : {}) });
    case "seed":
      return seedDemoProcurement(diRunDeps({ workspace: opts.workspace, who }), who);
    default:
      throw new Error("Unknown procurement action");
  }
}

async function sendStored(res, stored, { name, mime }) {
  const { full, file } = await readSharedFile({ root: path.join(DATA_DIR, "files"), companyId: companyHostContext().tenantId, ...stored });
  res.writeHead(200, {
    "Content-Type": mime, "Content-Length": file.bytes, "Content-Disposition": `inline; filename="${safeName(name)}"`,
    "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store",
  });
  createReadStream(full).pipe(res);
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {URL} url
 * @param {{ user: any, readBody: (req: any) => Promise<string>, json: Function, workspace: (agent: {id: string, slug: string}) => string }} opts
 * @returns {Promise<boolean>} true when the request was a procurement route (and has been answered)
 */
export async function handleDemoProcurement(req, res, url, opts) {
  const { pathname } = url;
  if (!pathname.startsWith("/api/demo/procurement")) return false;
  const { user: who, json } = opts;
  const q = (name) => String(url.searchParams.get(name) || "");
  try {
    if (req.method === "GET" && pathname === "/api/demo/procurement") {
      json(res, 200, await panelState(opts, who));
    } else if (req.method === "GET" && pathname === "/api/demo/procurement/po") {
      json(res, 200, await toolCall(opts, who)("get_po", { po: q("po") }));
    } else if (req.method === "GET" && pathname === "/api/demo/procurement/doc") {
      json(res, 200, await toolCall(opts, who)("get_supplier_document", { doc: q("doc") }));
    } else if (req.method === "GET" && pathname === "/api/demo/procurement/po-pdf") {
      const out = await toolCall(opts, who)("po_pdf", { po: q("po") });
      if (!out.pdf?.id) json(res, 503, { error: "The PDF renderer is not available on this host" });
      else await sendStored(res, { id: out.pdf.id, name: out.pdf.name }, { name: out.pdf.name, mime: "application/pdf" });
    } else if (req.method === "GET" && pathname === "/api/demo/procurement/file") {
      const ctx = companyHostContext();
      const file = await withContext(ctx.db, { ...ctx, actor: who.username, agent: AGENT }, (tx) => getSupplierDocumentFile(tx, q("id"), { who }));
      const stored = sharedFileLocation(file.path);
      if (!stored) throw new Error("File is not available");
      await sendStored(res, stored, { name: file.name, mime: file.mime });
    } else if (req.method === "POST" && pathname === "/api/demo/procurement") {
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
