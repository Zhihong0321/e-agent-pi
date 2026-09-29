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

const TYPE_LABEL = { quotation: "Quotation", invoice: "Invoice", credit_note: "Credit Note" };

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
  return {
    doc: {
      type: doc.doc_type,
      type_label: TYPE_LABEL[doc.doc_type] || doc.doc_type,
      number: doc.number || "DRAFT",
      is_draft: doc.status === "draft",
      status: doc.status,
      issue_date: fmtDate(doc.issue_date),
      valid_until: fmtDate(doc.valid_until),
      due_date: fmtDate(doc.due_date),
      reference: doc.reference || "",
      notes: doc.notes || "",
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
    company: { ...issuer, address_lines: addressLines(issuer.address) },
    customer: { ...bill, address_lines: addressLines(bill.address) },
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

export function defaultTemplateHtml(docType) {
  const isQuote = docType === "quotation";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>{{doc.type_label}} {{doc.number}}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; font-size: 10.5pt; color: #1f2933; margin: 0; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1f2933; padding-bottom: 10px; }
  .co-name { font-size: 15pt; font-weight: 700; }
  .muted { color: #616e7c; font-size: 9pt; line-height: 1.45; }
  .title { text-align: right; }
  .title h1 { margin: 0; font-size: 20pt; letter-spacing: 1px; text-transform: uppercase; }
  .draft { color: #c0392b; font-weight: 700; }
  .meta { display: flex; justify-content: space-between; margin: 16px 0; gap: 24px; }
  .box h3 { margin: 0 0 4px; font-size: 8.5pt; text-transform: uppercase; color: #616e7c; letter-spacing: .5px; }
  table.kv td { padding: 1px 0 1px 12px; font-size: 9.5pt; }
  table.kv td:first-child { color: #616e7c; padding-left: 0; }
  table.lines { width: 100%; border-collapse: collapse; margin-top: 6px; }
  table.lines th { background: #f0f3f6; text-align: left; font-size: 8.5pt; text-transform: uppercase; padding: 6px; }
  table.lines td { padding: 6px; border-bottom: 1px solid #e4e7eb; vertical-align: top; }
  .r { text-align: right; }
  .detail { color: #616e7c; font-size: 8.5pt; }
  .totals { width: 45%; margin-left: auto; margin-top: 10px; border-collapse: collapse; }
  .totals td { padding: 4px 6px; }
  .totals .grand td { border-top: 2px solid #1f2933; font-weight: 700; font-size: 12pt; }
  .foot { margin-top: 22px; display: flex; gap: 24px; }
  .foot > div { flex: 1; }
  .sign { margin-top: 40px; border-top: 1px solid #9aa5b1; width: 60%; padding-top: 4px; font-size: 9pt; color: #616e7c; }
</style></head>
<body>
  <div class="head">
    <div>
      {{#if company.logo_url}}<img src="{{company.logo_url}}" style="max-height:56px;margin-bottom:6px"><br>{{/if}}
      <div class="co-name">{{company.legal_name}}</div>
      <div class="muted">
        {{#if company.reg_no}}Reg. No. {{company.reg_no}}<br>{{/if}}
        {{#each company.address_lines}}{{this}}<br>{{/each}}
        {{#if company.phone}}Tel {{company.phone}} {{/if}}{{#if company.email}}· {{company.email}}{{/if}}
        {{#if company.sst_no}}<br>SST No. {{company.sst_no}}{{/if}}{{#if company.tin}} · TIN {{company.tin}}{{/if}}
      </div>
    </div>
    <div class="title">
      <h1>{{doc.type_label}}</h1>
      <div>{{#if doc.is_draft}}<span class="draft">DRAFT — not issued</span>{{else}}<strong>{{doc.number}}</strong>{{/if}}</div>
    </div>
  </div>

  <div class="meta">
    <div class="box">
      <h3>${isQuote ? "Prepared for" : "Bill to"}</h3>
      <strong>{{customer.name}}</strong>
      <div class="muted">
        {{#if customer.reg_no}}Reg. No. {{customer.reg_no}}<br>{{/if}}
        {{#each customer.address_lines}}{{this}}<br>{{/each}}
        {{#if customer.attention}}Attn: {{customer.attention}}<br>{{/if}}
        {{#if customer.email}}{{customer.email}} {{/if}}{{#if customer.phone}}· {{customer.phone}}{{/if}}
        {{#if customer.tin}}<br>TIN {{customer.tin}}{{/if}}
      </div>
    </div>
    <table class="kv">
      <tr><td>Date</td><td>{{doc.issue_date}}</td></tr>
      ${isQuote ? "{{#if doc.valid_until}}<tr><td>Valid until</td><td>{{doc.valid_until}}</td></tr>{{/if}}" : "{{#if doc.due_date}}<tr><td>Due date</td><td>{{doc.due_date}}</td></tr>{{/if}}"}
      {{#if doc.reference}}<tr><td>Reference</td><td>{{doc.reference}}</td></tr>{{/if}}
      <tr><td>Currency</td><td>{{doc.currency}}</td></tr>
    </table>
  </div>

  <table class="lines">
    <thead><tr><th>#</th><th>Description</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Tax</th><th class="r">Amount</th></tr></thead>
    <tbody>
      {{#each lines}}
      <tr>
        <td>{{no}}</td>
        <td>{{description}}{{#if detail}}<div class="detail">{{detail}}</div>{{/if}}{{#if discount}}<div class="detail">Discount -{{discount}}</div>{{/if}}</td>
        <td class="r">{{quantity}} {{unit}}</td>
        <td class="r">{{unit_price}}</td>
        <td class="r">{{#if tax_rate}}{{tax_code}} {{tax_rate}}{{else}}-{{/if}}</td>
        <td class="r">{{subtotal}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>

  <table class="totals">
    <tr><td>Subtotal</td><td class="r">{{doc.gross}}</td></tr>
    {{#if doc.discount_total}}<tr><td>Discount</td><td class="r">-{{doc.discount_total}}</td></tr>{{/if}}
    {{#each tax_summary}}<tr><td>{{code}} @ {{rate}}% on {{taxable}}</td><td class="r">{{tax}}</td></tr>{{/each}}
    <tr class="grand"><td>Total ({{doc.currency}})</td><td class="r">{{doc.total}}</td></tr>
    ${isQuote ? "" : "{{#if doc.amount_paid}}<tr><td>Paid</td><td class=\"r\">-{{doc.amount_paid}}</td></tr><tr><td><strong>Balance due</strong></td><td class=\"r\"><strong>{{doc.balance}}</strong></td></tr>{{/if}}"}
  </table>

  <div class="foot">
    <div>
      {{#if doc.notes}}<div class="box"><h3>Notes</h3><div class="muted">{{doc.notes}}</div></div>{{/if}}
      {{#if doc.terms}}<div class="box" style="margin-top:8px"><h3>Terms</h3><div class="muted">{{doc.terms}}</div></div>{{/if}}
    </div>
    <div>
      ${
        isQuote
          ? '<div class="box"><h3>Acceptance</h3><div class="sign">Authorised signature, name &amp; company stamp</div></div>'
          : '{{#if company.bank_details}}<div class="box"><h3>Payment details</h3><div class="muted">{{company.bank_details}}</div></div>{{/if}}{{#if doc.einvoice_uuid}}<div class="muted" style="margin-top:8px">e-Invoice UUID {{doc.einvoice_uuid}}</div>{{/if}}'
      }
    </div>
  </div>
</body></html>`;
}
