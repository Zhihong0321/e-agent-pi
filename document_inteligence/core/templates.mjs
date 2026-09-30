// Document templates: a deliberately tiny, logic-less HTML template language, the
// render context every template receives, and the default A4 templates each tenant
// is seeded with (so "no template" never blocks a document).
//
// Syntax:  {{path.to.value}}  (always HTML-escaped)
//          {{#each list}} ... {{this}} / {{field}} ... {{/each}}
//          {{#if path}} ... {{else}} ... {{/if}}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ESC[ch]);

function parse(src) {
  const tokens = String(src).split(/({{[^{}]*}})/);
  let i = 0;
  let stoppedAt = null;

  function block(stops) {
    const nodes = [];
    while (i < tokens.length) {
      const token = tokens[i++];
      const tag = token.match(/^{{\s*(.*?)\s*}}$/);
      if (!tag) {
        if (token) nodes.push({ type: "text", value: token });
        continue;
      }
      const expr = tag[1];
      if (stops.includes(expr)) {
        stoppedAt = expr;
        return nodes;
      }
      if (expr.startsWith("#each ")) {
        const body = block(["/each"]);
        if (stoppedAt !== "/each") throw new Error(`Unclosed {{#each ${expr.slice(6)}}}`);
        nodes.push({ type: "each", path: expr.slice(6).trim(), body });
      } else if (expr.startsWith("#if ")) {
        const body = block(["else", "/if"]);
        let alt = [];
        if (stoppedAt === "else") alt = block(["/if"]);
        if (stoppedAt !== "/if") throw new Error(`Unclosed {{#if ${expr.slice(4)}}}`);
        nodes.push({ type: "if", path: expr.slice(4).trim(), body, alt });
      } else if (expr === "/each" || expr === "/if" || expr === "else") {
        throw new Error(`Unexpected {{${expr}}}`);
      } else {
        nodes.push({ type: "var", path: expr });
      }
      stoppedAt = null;
    }
    stoppedAt = null;
    return nodes;
  }

  const nodes = block([]);
  return nodes;
}

function lookup(scopes, path) {
  if (path === "this") return scopes[0];
  const parts = path.replace(/^this\./, "").split(".");
  for (const scope of scopes) {
    if (scope == null || typeof scope !== "object" || !(parts[0] in scope)) continue;
    let value = scope;
    for (const part of parts) value = value == null ? undefined : value[part];
    return value;
  }
  return undefined;
}

const truthy = (v) => (Array.isArray(v) ? v.length > 0 : Boolean(v) && v !== "0.00");

function emit(nodes, scopes, used) {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") out += node.value;
    else if (node.type === "var") {
      used?.add(node.path);
      out += escapeHtml(lookup(scopes, node.path));
    } else if (node.type === "if") {
      used?.add(node.path);
      out += emit(truthy(lookup(scopes, node.path)) ? node.body : node.alt, scopes, used);
    } else if (node.type === "each") {
      used?.add(node.path);
      const list = lookup(scopes, node.path);
      if (Array.isArray(list)) for (const item of list) out += emit(node.body, [item, ...scopes], used);
    }
  }
  return out;
}

export function renderTemplate(src, data) {
  return emit(parse(src), [data], null);
}

/** Parses and dry-runs a template against sample data; returns problems instead of throwing. */
export function checkTemplate(src) {
  try {
    const used = new Set();
    emit(parse(src), [sampleContext("invoice")], used);
    const known = new Set(Object.keys(flatten(sampleContext("invoice"))));
    const lineKeys = Object.keys(sampleContext("invoice").lines[0]);
    const unknown = [...used].filter(
      (p) => p !== "this" && !known.has(p) && !lineKeys.includes(p.replace(/^this\./, "")) && !/^(company|customer)\.address_lines$/.test(p),
    );
    return { ok: true, unknownFields: unknown };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function flatten(obj, prefix = "", out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    const k = prefix ? `${prefix}.${key}` : key;
    out[k] = true;
    if (value && typeof value === "object" && !Array.isArray(value)) flatten(value, k, out);
  }
  return out;
}

// ---------------------------------------------------------------- context

export const money = (n) =>
  Number(n || 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDate(value) {
  if (!value) return "";
  const iso = value instanceof Date ? value.toISOString() : String(value);
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso;
}

export function addressLines(addr) {
  if (!addr) return [];
  if (typeof addr === "string") return addr.split(/\r?\n/).filter(Boolean);
  const cityLine = [addr.postcode, addr.city].filter(Boolean).join(" ");
  return [addr.line1, addr.line2, addr.line3, cityLine, addr.state, addr.country].filter(Boolean);
}

/** A company or customer as templates see it: raw fields plus ready-made display lines. */
export function partyView(p) {
  const lines = addressLines(p.address);
  return {
    ...p,
    address_lines: lines,
    address_inline: lines.join(", "),
    contact_line: [p.phone, p.email, p.website].filter(Boolean).join(" · "),
    tax_line: [p.sst_no && `SST No. ${p.sst_no}`, p.tin && `TIN ${p.tin}`].filter(Boolean).join(" · "),
  };
}

const TYPE_LABEL = { quotation: "Quotation", invoice: "Invoice", credit_note: "Credit Note" };

const STATUS_LABEL = { partially_paid: "Part paid", void: "Void", cancelled: "Cancelled" };
const STATUS_TONE = {
  draft: "amber", issued: "blue", partially_paid: "amber", paid: "green", accepted: "green",
  converted: "blue", void: "red", cancelled: "red", rejected: "red", expired: "red",
};
const titleCase = (s) => String(s || "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/**
 * What the summary band at the top of a document says: the one figure a reader
 * wants first (amount due, paid in full, quotation total) and how to tone it.
 */
function summarise(doc, balance) {
  const isInvoice = doc.doc_type === "invoice";
  const owing = isInvoice && ["issued", "partially_paid"].includes(doc.status) && balance > 0.005;
  const due = String(doc.due_date || "").slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const overdue = owing && Boolean(due) && due < today;
  let label = STATUS_LABEL[doc.status] || titleCase(doc.status);
  let tone = STATUS_TONE[doc.status] || "grey";
  if (overdue) [label, tone] = ["Overdue", "red"];
  let summary = { label: "Total", amount: doc.total };
  if (doc.doc_type === "quotation") summary = { label: "Quotation total", amount: doc.total };
  else if (doc.doc_type === "credit_note") summary = { label: "Credit total", amount: doc.total };
  else if (owing) summary = { label: "Amount due", amount: balance };
  else if (isInvoice && doc.status === "paid") summary = { label: "Paid in full", amount: doc.total };
  else if (isInvoice && doc.status === "draft") summary = { label: "Total (draft)", amount: doc.total };
  return { label, tone, overdue, owing, summary };
}

/**
 * Everything a template can reference. Issued documents render from their frozen
 * snapshots; drafts render from live records.
 */
export function buildContext({ doc, lines, customer, contact, tenant }) {
  const bill = doc.customer_snapshot || snapshotCustomer(customer, contact);
  const issuer = doc.issuer_snapshot || snapshotIssuer(tenant);
  const taxes = new Map();
  for (const l of lines) {
    if (!Number(l.tax_rate)) continue;
    const key = `${l.tax_code}|${l.tax_rate}`;
    const t = taxes.get(key) || { code: l.tax_code, rate: Number(l.tax_rate), taxable: 0, tax: 0 };
    t.taxable += Number(l.subtotal);
    t.tax += Number(l.tax_amount);
    taxes.set(key, t);
  }
  const balance = Number(doc.total) - Number(doc.amount_paid || 0);
  const sum = summarise(doc, balance);
  return {
    doc: {
      type: doc.doc_type,
      type_label: TYPE_LABEL[doc.doc_type] || doc.doc_type,
      number: doc.number || "DRAFT",
      is_draft: doc.status === "draft",
      status: doc.status,
      status_label: sum.label,
      status_tone: sum.tone,
      is_overdue: sum.overdue,
      is_paid: doc.doc_type === "invoice" && doc.status === "paid",
      watermark: doc.status === "draft" ? "DRAFT" : ["void", "cancelled"].includes(doc.status) ? "VOID" : "",
      summary_label: sum.summary.label,
      summary_amount: money(sum.summary.amount),
      issue_date: fmtDate(doc.issue_date),
      valid_until: fmtDate(doc.valid_until),
      due_date: fmtDate(doc.due_date),
      reference: doc.reference || "",
      notes: doc.notes || "",
      remarks: [doc.notes, doc.terms].filter(Boolean).join("\n\n"),
      terms: doc.terms || "",
      currency: doc.currency || "MYR",
      subtotal: money(doc.subtotal),
      gross: money(Number(doc.subtotal) + Number(doc.discount_total || 0)),
      discount_total: Number(doc.discount_total) ? money(doc.discount_total) : "",
      tax_total: money(doc.tax_total),
      total: money(doc.total),
      amount_paid: Number(doc.amount_paid) ? money(doc.amount_paid) : "",
      balance: money(balance),
      einvoice_uuid: doc.einvoice_uuid || "",
      einvoice_qr_url: doc.einvoice_qr_url || "",
    },
    company: partyView(issuer),
    customer: partyView(bill),
    lines: lines.map((l, idx) => ({
      no: idx + 1,
      description: l.description,
      detail: l.meta?.components?.length
        ? l.meta.components.map((c) => `${Number(c.quantity)} × ${c.name}`).join(", ")
        : "",
      quantity: Number(l.quantity).toString(),
      unit: l.unit || "",
      unit_price: money(l.unit_price),
      discount: Number(l.discount_amount) ? money(l.discount_amount) : "",
      tax_code: l.tax_code || "",
      tax_rate: Number(l.tax_rate) ? `${Number(l.tax_rate)}%` : "",
      tax_amount: money(l.tax_amount),
      total: money(Number(l.subtotal) + Number(l.tax_amount)),
      subtotal: money(l.subtotal),
    })),
    tax_summary: [...taxes.values()].map((t) => ({ ...t, taxable: money(t.taxable), tax: money(t.tax) })),
  };
}

export function snapshotCustomer(customer, contact) {
  if (!customer) return { name: "", address: {} };
  return {
    code: customer.code,
    name: customer.name,
    legal_name: customer.legal_name || "",
    reg_no: customer.reg_no || "",
    tin: customer.tin || "",
    sst_no: customer.sst_no || "",
    email: contact?.email || customer.email || "",
    phone: contact?.mobile || contact?.phone || customer.phone || "",
    attention: contact?.name || "",
    address: customer.billing_address || {},
  };
}

export function snapshotIssuer(tenant) {
  if (!tenant) return { name: "", address: {} };
  return {
    name: tenant.name,
    legal_name: tenant.legal_name || tenant.name,
    reg_no: tenant.reg_no || "",
    tin: tenant.tin || "",
    sst_no: tenant.sst_no || "",
    phone: tenant.phone || "",
    email: tenant.email || "",
    website: tenant.website || "",
    logo_url: tenant.logo_url || "",
    bank_details: tenant.bank_details || "",
    address: tenant.address || {},
  };
}

export function sampleContext(docType = "invoice") {
  return buildContext({
    doc: {
      doc_type: docType,
      status: "issued",
      number: docType === "quotation" ? "QT-2026-0001" : "INV-2026-0001",
      issue_date: "2026-09-28",
      valid_until: "2026-10-28",
      due_date: "2026-10-28",
      reference: "PO-7788",
      notes: "Thank you for your business.",
      terms: "Payment within 30 days.",
      subtotal: 1000,
      discount_total: 0,
      tax_total: 80,
      total: 1080,
      amount_paid: 0,
      currency: "MYR",
    },
    lines: [
      {
        description: "Sample service",
        quantity: 2,
        unit: "unit",
        unit_price: 500,
        discount_amount: 0,
        tax_code: "SV8",
        tax_rate: 8,
        subtotal: 1000,
        tax_amount: 80,
        meta: {},
      },
    ],
    customer: {
      code: "C-0001",
      name: "Sample Customer Sdn Bhd",
      reg_no: "202401000001",
      billing_address: { line1: "1 Jalan Contoh", postcode: "50000", city: "Kuala Lumpur", country: "Malaysia" },
    },
    contact: { name: "Ahmad", email: "ahmad@example.com" },
    tenant: {
      name: "Your Company",
      reg_no: "202001000001",
      address: { line1: "2 Jalan Syarikat", postcode: "47800", city: "Petaling Jaya", state: "Selangor" },
      bank_details: "Maybank 5123 4567 8901",
    },
  });
}

// ---------------------------------------------------------------- default templates

/** Bump when defaultTemplateHtml changes, so seedTenantTx can upgrade untouched seeded copies. */
export const DEFAULT_TEMPLATE_REV = 3;

// A printed document, not a web page: fixed A4 sheets that flow onto further pages when the
// lines run long. Text is set in serif for the name and figures that matter, sans for the rest;
// structure comes from rules and spacing rather than boxes.
const TEMPLATE_CSS = `
  @page {
    size: A4;
    margin: 18mm 17mm 16mm;
    @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 7.5pt "Helvetica Neue", Arial, "Liberation Sans", sans-serif; color: #7b8593; }
  }
  * { box-sizing: border-box; }
  :root { --navy: #0f2340; --gold: #9a7b3f; --ink: #1c2733; --grey: #5f6b7a; --faint: #8b94a1; --line: #d7dce3; --wash: #f5f6f8; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; color: var(--ink); font: 9pt/1.5 "Helvetica Neue", Arial, "Liberation Sans", sans-serif; font-variant-numeric: tabular-nums; }
  .serif { font-family: Georgia, Cambria, "Times New Roman", "Liberation Serif", serif; }
  .r { text-align: right; }
  .grey { color: var(--grey); }
  .cap { font-size: 6.8pt; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--faint); }

  /* on screen, show the sheet as paper; in print the page itself is the sheet */
  @media screen {
    html { background: #7d8590; padding: 10mm 0; }
    body { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 18mm 17mm 24mm; background: #fff; box-shadow: 0 2px 16px rgba(0,0,0,.4); }
    .pgfoot { margin-top: 14mm; }
  }
  @media print { .pgfoot { position: fixed; left: 0; right: 0; bottom: 0; } }
  /* every printed page reserves the footer's space, so a long table can never run under it */
  table.frame { width: 100%; border-collapse: collapse; }
  table.frame > tbody > tr > td, table.frame > tfoot > tr > td { padding: 0; }
  table.frame td.reserve { height: 15mm; }

  /* masthead */
  .mast { display: flex; justify-content: space-between; align-items: flex-end; gap: 18mm; padding-bottom: 4mm; }
  .logo { max-height: 15mm; max-width: 55mm; object-fit: contain; display: block; margin-bottom: 2.5mm; }
  .co { font-size: 15pt; font-weight: 700; letter-spacing: .02em; color: var(--navy); line-height: 1.2; }
  .co-lines { margin-top: 1.5mm; font-size: 7.8pt; line-height: 1.55; color: var(--grey); }
  .title { text-align: right; flex: none; }
  .title .kind { font-size: 25pt; font-weight: 400; letter-spacing: .28em; text-transform: uppercase; color: var(--navy); line-height: 1; margin-right: -.28em; }
  .title .no { margin-top: 3mm; font-size: 11pt; color: var(--ink); letter-spacing: .04em; }
  .rule { height: 0; border-top: 1.4pt solid var(--navy); border-bottom: .5pt solid var(--gold); padding-top: 1pt; margin-bottom: 5mm; }

  /* parties and particulars */
  .info { display: flex; gap: 14mm; margin-bottom: 6mm; }
  .info > .to { flex: 1.25; min-width: 0; }
  .info > .facts { flex: 1; min-width: 0; }
  .to .name { margin: 2mm 0 1mm; font-size: 12pt; font-weight: 700; color: var(--navy); line-height: 1.25; }
  .to .lines { font-size: 8.3pt; line-height: 1.6; color: var(--grey); }
  table.facts { width: 100%; border-collapse: collapse; margin-top: 1.5mm; }
  table.facts td { padding: 1.1mm 0; border-bottom: .5pt solid var(--line); vertical-align: baseline; }
  table.facts tr:first-child td { border-top: .5pt solid var(--line); }
  table.facts td:first-child { color: var(--grey); font-size: 8pt; }
  table.facts td:last-child { text-align: right; font-weight: 600; }
  .st { font-weight: 700; letter-spacing: .12em; text-transform: uppercase; font-size: 7.6pt; }
  .st.green { color: #1e6a45; } .st.red { color: #a12a22; } .st.amber { color: #8a5a08; } .st.blue { color: #1f4b8a; } .st.grey { color: var(--grey); }

  /* line items */
  table.lines { width: 100%; border-collapse: collapse; }
  table.lines thead { display: table-header-group; }
  table.lines th { padding: 2.6mm 2mm 2.4mm; font-size: 6.8pt; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--navy); text-align: left; border-top: 1.2pt solid var(--navy); border-bottom: .5pt solid var(--navy); }
  table.lines th.r { text-align: right; }
  table.lines td { padding: 2.4mm 2mm; border-bottom: .5pt solid var(--line); vertical-align: top; }
  table.lines tr { break-inside: avoid; }
  table.lines td.no { width: 8mm; color: var(--faint); font-size: 8pt; }
  table.lines .desc { font-weight: 600; }
  table.lines .detail { margin-top: .6mm; color: var(--grey); font-size: 8pt; line-height: 1.45; }
  table.lines .disc { color: var(--gold); font-size: 8pt; }
  table.lines td.num { white-space: nowrap; text-align: right; }
  table.lines td.amt { font-weight: 700; }

  /* totals */
  .sum { display: flex; justify-content: space-between; gap: 14mm; margin-top: 4mm; break-inside: avoid; }
  .sum .side { flex: 1; min-width: 0; }
  table.totals { width: 82mm; flex: none; border-collapse: collapse; }
  table.totals td { padding: 1.3mm 2mm; border-bottom: .5pt solid var(--line); }
  table.totals td:last-child { text-align: right; white-space: nowrap; font-weight: 600; }
  table.totals tr.tax td { color: var(--grey); font-size: 8pt; font-weight: 400; }
  table.totals tr.due td { padding: 3.2mm 3mm; border: 0; background: var(--navy); color: #fff; }
  table.totals tr.due td:first-child { font-size: 7.4pt; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
  table.totals tr.due td:last-child { font-family: Georgia, Cambria, "Times New Roman", "Liberation Serif", serif; font-size: 13.5pt; font-weight: 700; }
  table.totals tr.due + tr td { border: 0; }
  .stamp { display: inline-block; margin-top: 4mm; padding: 1.2mm 5mm; border: 1.6pt solid #1e6a45; color: #1e6a45; font-size: 15pt; font-weight: 700; letter-spacing: .3em; text-transform: uppercase; transform: rotate(-7deg); opacity: .85; }

  /* closing matter */
  .notes { display: flex; gap: 14mm; margin-top: 6mm; break-inside: avoid; }
  .notes > div { flex: 1; min-width: 0; padding-top: 2.5mm; border-top: .5pt solid var(--navy); }
  .notes .body { margin-top: 1.5mm; font-size: 8.3pt; line-height: 1.6; color: var(--grey); white-space: pre-line; }
  .sign { margin-top: 15mm; border-top: .5pt solid var(--ink); padding-top: 1.5mm; font-size: 7.6pt; color: var(--grey); }
  .einv { margin-top: 3mm; font-size: 7pt; color: var(--faint); word-break: break-all; }

  /* running footer (every printed page) and watermark */
  .pgfoot { padding-top: 2mm; border-top: .5pt solid var(--line); font-size: 7.5pt; color: var(--faint); }
  .pgfoot b { color: var(--grey); font-weight: 600; }
  .wm { position: fixed; top: 105mm; left: 0; right: 0; text-align: center; font-family: Georgia, "Times New Roman", "Liberation Serif", serif; font-size: 110pt; letter-spacing: .12em; color: rgba(15, 35, 64, .055); transform: rotate(-32deg); pointer-events: none; z-index: -1; }
`;

/**
 * The template every tenant is seeded with: an A4 corporate document (letterhead, rules,
 * restrained navy and gold), multi-page safe, with a running footer and page numbers.
 * Written in the logic-less template language above, so it can be edited like any other.
 */
export function defaultTemplateHtml(docType) {
  const isQuote = docType === "quotation";
  const isCredit = docType === "credit_note";
  const partyLabel = isQuote ? "Prepared for" : isCredit ? "Credited to" : "Billed to";
  const numLabel = isQuote ? "Quotation no." : isCredit ? "Credit note no." : "Invoice no.";
  const dateRows = isQuote
    ? `<tr><td>Date of issue</td><td>{{doc.issue_date}}</td></tr>{{#if doc.valid_until}}<tr><td>Valid until</td><td>{{doc.valid_until}}</td></tr>{{/if}}`
    : `<tr><td>Date of issue</td><td>{{doc.issue_date}}</td></tr>{{#if doc.due_date}}<tr><td>Payment due</td><td>{{doc.due_date}}</td></tr>{{/if}}`;
  const lowerRight = isQuote
    ? `<div><div class="cap">Acceptance</div><div class="body">By signing, the customer accepts this quotation and its terms.</div><div class="sign">Authorised signature, name, date &amp; company stamp</div></div>`
    : `{{#if company.bank_details}}<div><div class="cap">Payment details</div><div class="body">{{company.bank_details}}{{#if doc.is_draft}}{{else}}
Please quote {{doc.number}} as the payment reference.{{/if}}</div></div>{{/if}}`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>{{doc.type_label}} {{doc.number}}</title>
<style>${TEMPLATE_CSS}</style></head>
<body>
  {{#if doc.watermark}}<div class="wm">{{doc.watermark}}</div>{{/if}}
  <table class="frame"><tfoot><tr><td class="reserve"></td></tr></tfoot><tbody><tr><td>

  <div class="mast">
    <div>
      {{#if company.logo_url}}<img class="logo" src="{{company.logo_url}}" alt="">{{/if}}
      <div class="co serif">{{company.legal_name}}</div>
      <div class="co-lines">
        {{#if company.reg_no}}Reg. No. {{company.reg_no}}<br>{{/if}}
        {{#if company.address_inline}}{{company.address_inline}}<br>{{/if}}
        {{#if company.contact_line}}{{company.contact_line}}<br>{{/if}}
        {{#if company.tax_line}}{{company.tax_line}}{{/if}}
      </div>
    </div>
    <div class="title">
      <div class="kind serif">{{doc.type_label}}</div>
      <div class="no">{{doc.number}}</div>
    </div>
  </div>
  <div class="rule"></div>

  <div class="info">
    <div class="to">
      <div class="cap">${partyLabel}</div>
      <div class="name serif">{{customer.name}}</div>
      <div class="lines">
        {{#if customer.legal_name}}{{customer.legal_name}}<br>{{/if}}
        {{#if customer.reg_no}}Reg. No. {{customer.reg_no}}<br>{{/if}}
        {{#if customer.address_inline}}{{customer.address_inline}}<br>{{/if}}
        {{#if customer.attention}}Attention: {{customer.attention}}<br>{{/if}}
        {{#if customer.contact_line}}{{customer.contact_line}}<br>{{/if}}
        {{#if customer.tin}}TIN {{customer.tin}}{{/if}}
      </div>
    </div>
    <div class="facts">
      <div class="cap">Particulars</div>
      <table class="facts">
        <tr><td>${numLabel}</td><td>{{doc.number}}</td></tr>
        ${dateRows}
        {{#if doc.reference}}<tr><td>Your reference</td><td>{{doc.reference}}</td></tr>{{/if}}
        <tr><td>Currency</td><td>{{doc.currency}}</td></tr>
        <tr><td>Status</td><td><span class="st {{doc.status_tone}}">{{doc.status_label}}</span></td></tr>
      </table>
    </div>
  </div>

  <table class="lines">
    <thead><tr><th>No.</th><th>Description</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Tax</th><th class="r">Amount ({{doc.currency}})</th></tr></thead>
    <tbody>
      {{#each lines}}
      <tr>
        <td class="no">{{no}}</td>
        <td><div class="desc">{{description}}</div>{{#if detail}}<div class="detail">{{detail}}</div>{{/if}}{{#if discount}}<div class="disc">Less discount {{discount}}</div>{{/if}}</td>
        <td class="num">{{quantity}} {{unit}}</td>
        <td class="num">{{unit_price}}</td>
        <td class="num grey">{{#if tax_rate}}{{tax_code}} {{tax_rate}}{{else}}-{{/if}}</td>
        <td class="num amt">{{subtotal}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>

  <div class="sum">
    <div class="side">{{#if doc.is_paid}}<span class="stamp serif">Paid</span>{{/if}}</div>
    <table class="totals">
      <tr><td>Subtotal</td><td>{{doc.gross}}</td></tr>
      {{#if doc.discount_total}}<tr><td>Discount</td><td>-{{doc.discount_total}}</td></tr>{{/if}}
      {{#each tax_summary}}<tr class="tax"><td>{{code}} {{rate}}% on {{taxable}}</td><td>{{tax}}</td></tr>{{/each}}
      {{#if doc.amount_paid}}<tr><td>Total</td><td>{{doc.total}}</td></tr><tr><td>Received to date</td><td>-{{doc.amount_paid}}</td></tr>{{/if}}
      <tr class="due"><td>{{doc.summary_label}}</td><td>{{doc.currency}} {{doc.summary_amount}}</td></tr>
    </table>
  </div>

  <div class="notes">
    {{#if doc.remarks}}<div>
      <div class="cap">Notes &amp; terms</div>
      <div class="body">{{doc.remarks}}</div>
    </div>{{/if}}
    ${lowerRight}
  </div>
  {{#if doc.einvoice_uuid}}<div class="einv">e-Invoice UUID {{doc.einvoice_uuid}}</div>{{/if}}

  </td></tr></tbody></table>

  <div class="pgfoot"><b>{{company.legal_name}}</b>{{#if company.reg_no}} · {{company.reg_no}}{{/if}}{{#if company.contact_line}} · {{company.contact_line}}{{/if}}${isQuote ? "" : '<br>This is a computer-generated document. No signature is required.'}</div>
</body></html>`;
}
