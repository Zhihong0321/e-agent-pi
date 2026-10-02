// The claim submission report: one A4 PDF per monthly submission (or per claimant), plus a
// CSV of the same rows. The renderer is pure (data in, HTML out) so it can be previewed and
// tested without a database or a browser; publishExpenseReport() is the only part that
// touches files.
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { escapeHtml as esc } from "../../server/report-html.mjs";
import { EXPENSE_CATEGORIES, loadSubmissionData, setBatchReportPath, totalsOf } from "./expenses.mjs";
import { csvCell } from "./forms.mjs";
import { addressLines, fmtDate, money } from "./templates.mjs";
import { todayMY } from "./common.mjs";
import { withContext } from "./db.mjs";

const STATUS_LABEL = { submitted: "Pending", approved: "Approved", rejected: "Rejected" };
const categoryLabel = (key) => (EXPENSE_CATEGORIES.find((c) => c.key === key)?.label ?? key).replace(/ \(.*\)$/, "");
const MAX_EMBED_BYTES = 15 * 1024 * 1024;

// ---------------------------------------------------------------- shaping (pure)

/** Groups a submission's live claims by claimant and totals them. Withdrawn claims are left out. */
export function summariseSubmission(claims) {
  const live = claims.filter((c) => c.status !== "withdrawn");
  const people = new Map();
  for (const c of live) {
    const key = c.claimant.user_id || c.claimant.member_id || c.claimant.name.toLowerCase();
    if (!people.has(key)) people.set(key, { name: c.claimant.name, email: c.claimant.email, claims: [] });
    people.get(key).claims.push(c);
  }
  const claimants = [...people.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ ...p, totals: totalsOf(p.claims) }));
  const byCategory = EXPENSE_CATEGORIES.map((cat) => ({ key: cat.key, label: categoryLabel(cat.key), ...totalsOf(live.filter((c) => c.category === cat.key)) }))
    .filter((row) => row.count);
  return { totals: totalsOf(live), claimants, byCategory, withdrawn: claims.length - live.length };
}

export function claimsToCsv(claims) {
  const header = ["Claim no", "Claimant", "Email", "Expense date", "Filed on", "Merchant", "Category", "Description", "Payment method",
    "Currency", "Amount", "Tax", "Status", "Reviewed by", "Review note", "Submission", "Receipts"];
  const rows = claims.map((c) => [
    c.number, c.claimant.name, c.claimant.email, c.expense_date, c.submitted_at.slice(0, 10), c.merchant, categoryLabel(c.category),
    c.description, c.payment_method, c.currency, c.amount.toFixed(2), c.tax_amount == null ? "" : c.tax_amount.toFixed(2),
    STATUS_LABEL[c.status] ?? c.status, c.reviewed_by, c.review_note, c.submission?.period_key, c.receipts.length,
  ]);
  return `${[header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------- HTML (pure)

const REPORT_CSS = `
  @page { size: A4; margin: 16mm 15mm 16mm; @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 7.5pt Arial, sans-serif; color: #7b8593; } }
  * { box-sizing: border-box; }
  :root { --navy: #0f2340; --gold: #9a7b3f; --ink: #1c2733; --grey: #5f6b7a; --faint: #8b94a1; --line: #d7dce3; --wash: #f5f6f8; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; color: var(--ink); font: 8.6pt/1.45 "Helvetica Neue", Arial, "Liberation Sans", sans-serif; font-variant-numeric: tabular-nums; }
  @media screen { html { background: #7d8590; padding: 10mm 0; } body { width: 210mm; margin: 0 auto; padding: 16mm 15mm; background: #fff; box-shadow: 0 2px 16px rgba(0,0,0,.4); } }
  .cap { font-size: 6.8pt; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--faint); }
  .r { text-align: right; } .grey { color: var(--grey); }
  header.top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10mm; border-bottom: 1.2pt solid var(--navy); padding-bottom: 4mm; }
  header.top .co { font: 700 13pt Georgia, "Times New Roman", serif; color: var(--navy); }
  header.top .addr { margin-top: 1mm; font-size: 7.6pt; color: var(--grey); line-height: 1.5; }
  header.top .doc { text-align: right; }
  header.top .doc h1 { margin: 1mm 0 1mm; font: 700 15pt Georgia, "Times New Roman", serif; color: var(--navy); }
  .state { display: inline-block; padding: .8mm 2.4mm; font-size: 7pt; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; border: .8pt solid; }
  .state.final { color: #1e6a45; border-color: #1e6a45; } .state.draft { color: #8a5a08; border-color: #8a5a08; }
  .sub { margin: 3mm 0 0; color: var(--grey); }
  .stats { display: flex; gap: 3mm; margin: 5mm 0 2mm; }
  .stat { flex: 1; padding: 2.4mm 3mm; background: var(--wash); border-top: 1.2pt solid var(--navy); }
  .stat b { display: block; margin-top: .6mm; font: 700 11pt Georgia, serif; color: var(--navy); }
  h2 { margin: 7mm 0 1.5mm; font-size: 9.6pt; color: var(--navy); break-after: avoid; }
  h2 small { font-weight: 400; color: var(--grey); font-size: 8pt; }
  table { width: 100%; border-collapse: collapse; }
  table.claims { table-layout: fixed; }
  td { overflow-wrap: anywhere; }
  thead { display: table-header-group; }
  th { padding: 2mm 1.6mm; font-size: 6.6pt; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--navy); text-align: left; border-top: 1.1pt solid var(--navy); border-bottom: .5pt solid var(--navy); }
  th.r { text-align: right; }
  td { padding: 1.8mm 1.6mm; border-bottom: .5pt solid var(--line); vertical-align: top; }
  tr { break-inside: avoid; }
  tr.sub td { background: var(--wash); font-weight: 700; border-bottom: 1pt solid var(--navy); }
  .note { display: block; margin-top: .6mm; font-size: 7.4pt; color: #a12a22; }
  .st { white-space: nowrap; font-weight: 700; font-size: 7pt; letter-spacing: .08em; text-transform: uppercase; }
  .st.approved { color: #1e6a45; } .st.rejected { color: #a12a22; } .st.submitted { color: #8a5a08; }
  .sign { display: flex; gap: 12mm; margin-top: 12mm; break-inside: avoid; }
  .sign div { flex: 1; border-top: .6pt solid var(--ink); padding-top: 1.5mm; font-size: 7.6pt; color: var(--grey); }
  .foot { margin-top: 6mm; font-size: 7pt; color: var(--faint); }
  .receipts { break-before: page; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5mm; }
  figure { margin: 0; padding: 2mm; border: .5pt solid var(--line); break-inside: avoid; }
  figure img { display: block; max-width: 100%; max-height: 95mm; margin: 0 auto; object-fit: contain; }
  figcaption { margin-top: 1.5mm; font-size: 7.4pt; color: var(--grey); }
  .nofile { padding: 4mm; background: var(--wash); font-size: 7.6pt; color: var(--grey); }
`;

/**
 * @param {Awaited<ReturnType<typeof loadSubmissionData>>} data
 * @param {{ images?: Map<string, string>, generatedOn?: string }} [opts] images: receipt id -> data: URI
 */
export function renderExpenseReportHtml(data, { images = new Map(), generatedOn = todayMY() } = {}) {
  const { batch, claims, company, currency } = data;
  const sum = summariseSubmission(claims);
  const cur = (n) => `${esc(currency)} ${money(n)}`;
  const closed = batch.status === "closed";
  const name = company?.name || company?.legal_name || "Company";
  const addr = addressLines(company?.address).join(", ");
  const filtered = data.claimant_filter || data.scope === "own";
  const claimantRows = sum.claimants.map((p) => `
    <h2>${esc(p.name)} <small>${esc(p.email || "")} · ${p.totals.count} claim${p.totals.count === 1 ? "" : "s"}</small></h2>
    <table class="claims"><colgroup><col style="width:15%"><col style="width:12%"><col><col style="width:14%"><col style="width:10%"><col style="width:13%"><col style="width:10%"></colgroup><thead><tr><th>No.</th><th>Date</th><th>Merchant</th><th>Category</th><th>Payment</th><th>Status</th><th class="r">Amount</th></tr></thead><tbody>
    ${p.claims.map((c) => `<tr>
      <td>${esc(c.number)}</td><td>${esc(fmtDate(c.expense_date))}</td>
      <td>${esc(c.merchant)}${c.description ? `<span class="grey"> · ${esc(c.description)}</span>` : ""}${c.review_note ? `<span class="note">${esc(c.review_note)}</span>` : ""}${c.no_receipt_reason ? `<span class="note">No receipt: ${esc(c.no_receipt_reason)}</span>` : ""}</td>
      <td>${esc(categoryLabel(c.category))}</td><td>${esc((c.payment_method || "").replace(/_/g, " "))}</td>
      <td><span class="st ${esc(c.status)}">${esc(STATUS_LABEL[c.status] ?? c.status)}</span></td><td class="r">${money(c.amount)}</td></tr>`).join("")}
    <tr class="sub"><td colspan="5">Subtotal · approved ${cur(p.totals.approved)}</td><td></td><td class="r">${money(p.totals.claimed)}</td></tr>
    </tbody></table>`).join("");

  const attachments = claims.filter((c) => c.status !== "withdrawn" && c.receipts.length);
  const figures = attachments.flatMap((c) => c.receipts.map((r) => {
    const cap = `${esc(c.number)} · ${esc(c.merchant)} · ${cur(c.amount)}`;
    const src = images.get(r.id);
    return src
      ? `<figure><img src="${src}" alt="${esc(r.name)}"/><figcaption>${cap}</figcaption></figure>`
      : `<figure><div class="nofile">${esc(r.name)} (${esc(r.mime === "application/pdf" ? "PDF receipt, kept in the system" : r.mime)})</div><figcaption>${cap}</figcaption></figure>`;
  }));

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Expense claims ${esc(batch.period_key)}</title><style>${REPORT_CSS}</style></head><body>
  <header class="top">
    <div><div class="co">${esc(name)}</div>${addr ? `<div class="addr">${esc(addr)}</div>` : ""}</div>
    <div class="doc"><div class="cap">Expense claims</div><h1>${esc(batch.label)}</h1>
      <span class="state ${closed ? "final" : "draft"}">${closed ? "Final · closed" : "Draft · still open"}</span></div>
  </header>
  <p class="sub">Claims filed ${esc(fmtDate(batch.period_start))} to ${esc(fmtDate(batch.cutoff_date))} (cut-off day ${esc(data.cutoff_day)}).
    ${closed ? `Closed ${esc(fmtDate(batch.closed_at))}${batch.closed_by ? ` by ${esc(batch.closed_by)}` : ""}.` : `Not yet closed: figures can still change. Prepared ${esc(fmtDate(generatedOn))}.`}
    ${filtered ? `<br/>Showing ${data.claimant_filter ? `claims matching “${esc(data.claimant_filter)}”` : "your claims only"}.` : ""}</p>
  <div class="stats">
    <div class="stat"><span class="cap">Claims</span><b>${sum.totals.count}</b></div>
    <div class="stat"><span class="cap">Claimed</span><b>${cur(sum.totals.claimed)}</b></div>
    <div class="stat"><span class="cap">Approved</span><b>${cur(sum.totals.approved)}</b></div>
    <div class="stat"><span class="cap">Pending</span><b>${cur(sum.totals.pending)}</b></div>
    <div class="stat"><span class="cap">Rejected</span><b>${cur(sum.totals.rejected)}</b></div>
  </div>
  ${sum.claimants.length ? claimantRows : `<p class="grey">No claims in this submission.</p>`}
  ${sum.byCategory.length ? `<h2>By category</h2><table><thead><tr><th>Category</th><th class="r">Claims</th><th class="r">Claimed</th><th class="r">Approved</th></tr></thead><tbody>
    ${sum.byCategory.map((r) => `<tr><td>${esc(r.label)}</td><td class="r">${r.count}</td><td class="r">${money(r.claimed)}</td><td class="r">${money(r.approved)}</td></tr>`).join("")}
    <tr class="sub"><td>Total</td><td class="r">${sum.totals.count}</td><td class="r">${money(sum.totals.claimed)}</td><td class="r">${money(sum.totals.approved)}</td></tr></tbody></table>` : ""}
  <div class="sign"><div>Prepared by</div><div>Approved by</div><div>Date</div></div>
  <p class="foot">${sum.withdrawn ? `${sum.withdrawn} withdrawn claim${sum.withdrawn === 1 ? "" : "s"} not shown. ` : ""}Amounts in ${esc(currency)}. Generated by the Expenses Clerk.</p>
  ${figures.length ? `<section class="receipts"><h2>Receipts <small>${figures.length} file${figures.length === 1 ? "" : "s"}</small></h2><div class="grid">${figures.join("")}</div></section>` : ""}
  </body></html>`;
}

// ---------------------------------------------------------------- publishing

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);

/**
 * Builds the report for `req` and publishes it as a PDF.
 * @param {{
 *   db: any, ctx: { tenantId: string, actor?: string, agent?: string, asRole?: boolean, who: object },
 *   renderPdf?: (html: string, absPath: string) => Promise<void>, workspaceDir?: string,
 *   publish?: (rel: string) => Promise<{ id: string, name: string, bytes: number, url: string, link: string }>,
 *   readShared?: (href: string) => Promise<{ full: string, file: object }>,
 * }} env
 * @param {{ batch_id?: string, month?: string, claimant?: string }} req
 */
export async function publishExpenseReport(env, req) {
  const { db, ctx } = env;
  const data = await withContext(db, ctx, (tx) => loadSubmissionData(tx, { batchId: req.batch_id, month: req.month, claimant: req.claimant }, { who: ctx.who }));
  const complete = data.batch.status === "closed" && data.scope === "all" && !data.claimant_filter;
  if (complete && data.batch.report_path && env.readShared) {
    try { return { pdf: (await env.readShared(data.batch.report_path)).file, report_scope: "stored final report" }; } catch { /* fall through and rebuild */ }
  }
  const images = new Map();
  let used = 0;
  if (env.readShared) {
    for (const claim of data.claims) {
      for (const r of claim.receipts) {
        if (!r.mime.startsWith("image/") || used + r.bytes > MAX_EMBED_BYTES) continue;
        try {
          const { full } = await env.readShared(r.path);
          images.set(r.id, `data:${r.mime};base64,${(await readFile(full)).toString("base64")}`);
          used += r.bytes;
        } catch { /* a missing copy just shows as a listed file */ }
      }
    }
  }
  const html = renderExpenseReportHtml(data, { images, generatedOn: todayMY() });
  if (!env.renderPdf || !env.workspaceDir || !env.publish) return { pdf: { skipped: "no PDF renderer on this host", html_chars: html.length } };
  const rel = `reports/expense-claims-${data.batch.period_key}${data.claimant_filter ? `-${slug(data.claimant_filter)}` : data.scope === "own" ? "-mine" : ""}${data.batch.status === "closed" ? "" : "-draft"}.pdf`;
  await mkdir(path.dirname(path.join(env.workspaceDir, rel)), { recursive: true });
  await env.renderPdf(html, path.join(env.workspaceDir, rel));
  const file = await env.publish(rel);
  if (complete) {
    await withContext(db, ctx, (tx) => setBatchReportPath(tx, data.batch.id, new URL(file.url, "http://local").pathname));
  }
  return { pdf: file, report_scope: complete ? "final report for the whole submission" : data.batch.status === "closed" ? "closed submission, filtered view" : "draft, submission still open" };
}
