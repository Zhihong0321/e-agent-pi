// The purchase order PDF. The renderer is pure (data in, HTML out) so it can be previewed and tested
// without a database or a browser; publishPoPdf() is the only part that touches files. A draft is
// watermarked DRAFT and never stored; issuing stores the final PDF link on the order.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { escapeHtml as esc } from "../../server/report-html.mjs";
import { withContext } from "./db.mjs";
import { loadPoReportData, setPoPdfPath } from "./procurement.mjs";
import { addressLines, fmtDate, money } from "./templates.mjs";

const CSS = `
  @page { size: A4; margin: 16mm 15mm 16mm; @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 7.5pt Arial, sans-serif; color: #7b8593; } }
  * { box-sizing: border-box; }
  :root { --navy: #0f2340; --ink: #1c2733; --grey: #5f6b7a; --faint: #8b94a1; --line: #d7dce3; --wash: #f5f6f8; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; color: var(--ink); font: 8.8pt/1.45 "Helvetica Neue", Arial, "Liberation Sans", sans-serif; font-variant-numeric: tabular-nums; }
  @media screen { html { background: #7d8590; padding: 10mm 0; } body { width: 210mm; margin: 0 auto; padding: 16mm 15mm; background: #fff; box-shadow: 0 2px 16px rgba(0,0,0,.4); } }
  .cap { font-size: 6.8pt; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--faint); }
  .r { text-align: right; } .grey { color: var(--grey); }
  header.top { display: flex; justify-content: space-between; gap: 10mm; border-bottom: 1.2pt solid var(--navy); padding-bottom: 4mm; }
  header.top .co { font: 700 13pt Georgia, "Times New Roman", serif; color: var(--navy); }
  header.top .addr { margin-top: 1mm; font-size: 7.6pt; color: var(--grey); line-height: 1.5; }
  header.top .doc { text-align: right; }
  header.top .doc h1 { margin: 1mm 0; font: 700 17pt Georgia, "Times New Roman", serif; color: var(--navy); letter-spacing: .02em; }
  .state { display: inline-block; padding: .8mm 2.4mm; font-size: 7pt; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; border: .8pt solid; }
  .state.final { color: #1e6a45; border-color: #1e6a45; } .state.draft { color: #8a5a08; border-color: #8a5a08; } .state.cancelled { color: #a12a22; border-color: #a12a22; }
  .parties { display: flex; gap: 12mm; margin: 6mm 0 5mm; }
  .parties > div { flex: 1; min-width: 0; }
  .parties h3 { margin: 0 0 1.2mm; }
  .parties .name { font: 700 11pt Georgia, serif; color: var(--navy); }
  table.facts { width: 100%; border-collapse: collapse; }
  table.facts td { padding: 1.1mm 0; border-bottom: .5pt solid var(--line); }
  table.facts td:first-child { color: var(--grey); width: 38%; } table.facts td:last-child { text-align: right; font-weight: 600; }
  table.lines { width: 100%; border-collapse: collapse; table-layout: fixed; }
  table.lines th { padding: 2.2mm 1.6mm; font-size: 6.6pt; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--navy); text-align: left; border-top: 1.1pt solid var(--navy); border-bottom: .5pt solid var(--navy); }
  table.lines th.r { text-align: right; }
  table.lines td { padding: 2mm 1.6mm; border-bottom: .5pt solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
  table.lines tr { break-inside: avoid; }
  .totals { margin: 4mm 0 0 auto; width: 70mm; }
  .totals div { display: flex; justify-content: space-between; padding: 1.3mm 0; border-bottom: .5pt solid var(--line); }
  .totals .grand { font: 700 11pt Georgia, serif; color: var(--navy); border-bottom: 1.2pt solid var(--navy); border-top: 1.2pt solid var(--navy); padding: 2mm 0; }
  .notes { margin-top: 6mm; padding: 3mm; background: var(--wash); font-size: 8pt; color: var(--grey); white-space: pre-wrap; }
  .sign { display: flex; gap: 12mm; margin-top: 14mm; break-inside: avoid; }
  .sign div { flex: 1; border-top: .6pt solid var(--ink); padding-top: 1.5mm; font-size: 7.6pt; color: var(--grey); }
  .foot { margin-top: 6mm; font-size: 7pt; color: var(--faint); }
`;

/** @param {Awaited<ReturnType<typeof loadPoReportData>>} data */
export function renderPoHtml({ po, supplier, company }) {
  const cur = esc(po.currency);
  const name = company?.name || company?.legal_name || "Company";
  const state = po.status === "draft" ? ["draft", "Draft, not yet issued"] : po.status === "cancelled" ? ["cancelled", "Cancelled"] : ["final", "Issued"];
  const rows = po.lines.map((l) => `<tr>
      <td>${l.line_no}</td><td>${esc(l.description)}${l.sku ? `<span class="grey"> · ${esc(l.sku)}</span>` : ""}</td>
      <td class="r">${esc(Number(l.quantity).toLocaleString("en-MY", { maximumFractionDigits: 3 }))}</td><td>${esc(l.unit)}</td><td class="r">${money(l.unit_price)}</td>
      <td class="r">${l.tax_rate ? `${esc(l.tax_rate)}%` : "-"}</td><td class="r">${money(l.total)}</td></tr>`).join("");
  const terms = po.payment_terms_days != null ? `${esc(po.payment_terms_days)} days` : "As agreed";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Purchase order ${esc(po.number)}</title><style>${CSS}</style></head><body>
  <header class="top">
    <div><div class="co">${esc(name)}</div><div class="addr">${esc(addressLines(company?.address).join(", "))}${company?.phone ? `<br/>${esc(company.phone)}` : ""}${company?.email ? ` · ${esc(company.email)}` : ""}</div></div>
    <div class="doc"><div class="cap">Purchase order</div><h1>${esc(po.number)}</h1><span class="state ${state[0]}">${state[1]}</span></div>
  </header>
  <div class="parties">
    <div><h3 class="cap">Supplier</h3><div class="name">${esc(supplier?.name ?? "")}</div>
      <div class="grey">${esc(addressLines(supplier?.address).join(", "))}<br/>${esc([supplier?.contact_name, supplier?.phone, supplier?.email].filter(Boolean).join(" · "))}</div></div>
    <div><h3 class="cap">Order details</h3><table class="facts">
      <tr><td>Order date</td><td>${esc(fmtDate(po.order_date))}</td></tr>
      <tr><td>Expected delivery</td><td>${po.expected_date ? esc(fmtDate(po.expected_date)) : "To be confirmed"}</td></tr>
      <tr><td>Payment terms</td><td>${terms}</td></tr>
      ${po.ship_to ? `<tr><td>Deliver to</td><td>${esc(po.ship_to)}</td></tr>` : ""}</table></div>
  </div>
  <table class="lines"><colgroup><col style="width:6%"><col><col style="width:10%"><col style="width:9%"><col style="width:13%"><col style="width:8%"><col style="width:14%"></colgroup>
    <thead><tr><th>#</th><th>Description</th><th class="r">Qty</th><th>Unit</th><th class="r">Unit price</th><th class="r">Tax</th><th class="r">Amount</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="totals"><div><span>Subtotal</span><span>${cur} ${money(po.subtotal)}</span></div><div><span>Tax</span><span>${cur} ${money(po.tax_total)}</span></div>
    <div class="grand"><span>Total</span><span>${cur} ${money(po.total)}</span></div></div>
  ${po.notes ? `<div class="notes">${esc(po.notes)}</div>` : ""}
  ${po.status === "cancelled" && po.cancel_reason ? `<div class="notes">Cancelled: ${esc(po.cancel_reason)}</div>` : ""}
  <div class="sign"><div>Authorised by${po.issued_by ? ` (${esc(po.issued_by)})` : ""}</div><div>Supplier acknowledgement</div><div>Date</div></div>
  <p class="foot">Please quote ${esc(po.number)} on the delivery order and invoice. Amounts in ${cur}.</p>
  </body></html>`;
}

/**
 * Builds the PO PDF and publishes it.
 * @param {{ db: any, ctx: object, renderPdf?: Function, workspaceDir?: string, publish?: Function, readShared?: Function }} env same shape as publishExpenseReport's
 * @param {{ po_id: string }} req
 */
export async function publishPoPdf(env, req) {
  const { db, ctx } = env;
  const data = await withContext(db, ctx, (tx) => loadPoReportData(tx, req.po_id));
  const issued = data.po.status !== "draft";
  if (issued && data.po.pdf_path && env.readShared && data.po.status !== "cancelled") {
    try { return { pdf: (await env.readShared(data.po.pdf_path)).file, report_scope: "stored PDF of the issued order" }; } catch { /* rebuild below */ }
  }
  const html = renderPoHtml(data);
  if (!env.renderPdf || !env.workspaceDir || !env.publish) return { pdf: { skipped: "no PDF renderer on this host", html_chars: html.length } };
  const rel = `purchase-orders/${data.po.number}${data.po.status === "draft" ? "-draft" : ""}.pdf`;
  await mkdir(path.dirname(path.join(env.workspaceDir, rel)), { recursive: true });
  await env.renderPdf(html, path.join(env.workspaceDir, rel));
  const file = await env.publish(rel);
  if (data.po.status === "issued" || data.po.status === "partially_received" || data.po.status === "received") {
    await withContext(db, ctx, (tx) => setPoPdfPath(tx, req.po_id, new URL(file.url, "http://local").pathname));
  }
  return { pdf: file, report_scope: issued ? "issued purchase order" : "draft, not yet issued" };
}
