// CRM dashboard: one read-only query pass over the tenant's records, and a pure
// renderer that turns the result into a self-contained HTML fragment (inline SVG,
// no scripts) for the chat's sandboxed report frame. Split in two so the layout can
// be previewed with dummy data (sampleDashboard) without a database.
import { escapeHtml as esc } from "../../server/report-html.mjs";
import { todayMY } from "./common.mjs";

const n = (v) => Number(v) || 0;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const OPEN_INV = "('issued','partially_paid')";

// ---------------------------------------------------------------- data

/** Month keys (YYYY-MM) for the six months ending at asAt, oldest first. */
function lastSixMonths(asAt) {
  const [y, m] = asAt.split("-").map(Number);
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (5 - i), 1));
    return { key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, label: MONTHS[d.getUTCMonth()] };
  });
}

export async function getCrmDashboard(tx, { company = "" } = {}) {
  const asAt = todayMY();
  const one = async (sql, params = [asAt]) => (await tx.query(sql, params)).rows;

  const [k] = await one(
    `SELECT
       coalesce(sum(total - amount_paid) FILTER (WHERE status IN ${OPEN_INV}), 0) AS outstanding,
       count(*) FILTER (WHERE status IN ${OPEN_INV} AND total - amount_paid > 0.005) AS open_invoices,
       coalesce(sum(total - amount_paid) FILTER (WHERE status IN ${OPEN_INV} AND due_date < $1::date), 0) AS overdue,
       count(*) FILTER (WHERE status IN ${OPEN_INV} AND due_date < $1::date AND total - amount_paid > 0.005) AS overdue_count,
       coalesce(max($1::date - due_date) FILTER (WHERE status IN ${OPEN_INV} AND due_date < $1::date), 0) AS oldest_overdue,
       coalesce(sum(total - amount_paid) FILTER (WHERE status IN ${OPEN_INV} AND (due_date IS NULL OR due_date >= $1::date)), 0) AS a_current,
       coalesce(sum(total - amount_paid) FILTER (WHERE status IN ${OPEN_INV} AND $1::date - due_date BETWEEN 1 AND 30), 0) AS a_1_30,
       coalesce(sum(total - amount_paid) FILTER (WHERE status IN ${OPEN_INV} AND $1::date - due_date BETWEEN 31 AND 60), 0) AS a_31_60,
       coalesce(sum(total - amount_paid) FILTER (WHERE status IN ${OPEN_INV} AND $1::date - due_date BETWEEN 61 AND 90), 0) AS a_61_90,
       coalesce(sum(total - amount_paid) FILTER (WHERE status IN ${OPEN_INV} AND $1::date - due_date > 90), 0) AS a_90
     FROM di.document WHERE doc_type = 'invoice' AND deleted_at IS NULL`,
  );
  const billed = await one(
    `SELECT to_char(date_trunc('month', issue_date), 'YYYY-MM') AS m, sum(total) AS v
       FROM di.document
      WHERE doc_type = 'invoice' AND deleted_at IS NULL AND status IN ('issued','partially_paid','paid')
        AND issue_date >= date_trunc('month', $1::date) - interval '5 months' GROUP BY 1`,
  );
  const collected = await one(
    `SELECT to_char(date_trunc('month', received_on), 'YYYY-MM') AS m, sum(amount) AS v
       FROM di.payment
      WHERE status = 'recorded' AND deleted_at IS NULL
        AND received_on >= date_trunc('month', $1::date) - interval '5 months' GROUP BY 1`,
  );
  const quotes = await one(
    `SELECT status, count(*) AS c, coalesce(sum(total), 0) AS v FROM di.document
      WHERE doc_type = 'quotation' AND deleted_at IS NULL AND status NOT IN ('draft','void','cancelled')
        AND issued_at >= $1::date - interval '12 months' GROUP BY status`,
  );
  const top = await one(
    `SELECT c.name, sum(d.total) AS billed,
            coalesce(sum(d.total - d.amount_paid) FILTER (WHERE d.status IN ${OPEN_INV}), 0) AS outstanding
       FROM di.document d JOIN di.customer c ON c.id = d.customer_id
      WHERE d.doc_type = 'invoice' AND d.deleted_at IS NULL AND d.status IN ('issued','partially_paid','paid')
        AND d.issue_date >= $1::date - interval '12 months'
      GROUP BY c.id, c.name ORDER BY billed DESC LIMIT 5`,
  );
  const overdueRows = await one(
    `SELECT d.number, c.name AS customer, d.total - d.amount_paid AS balance, $1::date - d.due_date AS days
       FROM di.document d LEFT JOIN di.customer c ON c.id = d.customer_id
      WHERE d.doc_type = 'invoice' AND d.deleted_at IS NULL AND d.status IN ${OPEN_INV}
        AND d.due_date < $1::date AND d.total - d.amount_paid > 0.005
      ORDER BY days DESC LIMIT 4`,
  );
  const expiring = await one(
    `SELECT d.number, c.name AS customer, d.total, d.valid_until - $1::date AS days
       FROM di.document d LEFT JOIN di.customer c ON c.id = d.customer_id
      WHERE d.doc_type = 'quotation' AND d.deleted_at IS NULL AND d.status = 'issued'
        AND d.valid_until BETWEEN $1::date AND $1::date + 7 ORDER BY d.valid_until LIMIT 2`,
  );
  const [leads] = await one(
    `SELECT count(*) FILTER (WHERE s.status = 'new') AS fresh,
            count(*) FILTER (WHERE s.submitted_at >= now() - interval '30 days') AS month,
            (SELECT f.title FROM di.form_submission s2 JOIN di.form f ON f.id = s2.form_id
              WHERE s2.status = 'new' AND s2.deleted_at IS NULL ORDER BY s2.submitted_at DESC LIMIT 1) AS latest_form
       FROM di.form_submission s WHERE s.deleted_at IS NULL`,
    [],
  );
  const [cust] = await one(
    `SELECT count(*) AS total, count(*) FILTER (WHERE created_at >= date_trunc('month', $1::date)) AS added
       FROM di.customer WHERE deleted_at IS NULL`,
  );
  const recent = await one(
    `SELECT d.number, d.doc_type, d.status, d.total, c.name AS customer, coalesce(d.issue_date, d.created_at::date) AS on_date
       FROM di.document d LEFT JOIN di.customer c ON c.id = d.customer_id
      WHERE d.deleted_at IS NULL ORDER BY coalesce(d.issued_at, d.created_at) DESC LIMIT 6`,
    [],
  );

  const months = lastSixMonths(asAt);
  const byMonth = (rows) => Object.fromEntries(rows.map((r) => [r.m, n(r.v)]));
  const b = byMonth(billed);
  const c = byMonth(collected);
  const trend = months.map((m) => ({ label: m.label, billed: b[m.key] || 0, collected: c[m.key] || 0 }));

  const q = Object.fromEntries(quotes.map((r) => [r.status, { n: n(r.c), value: n(r.v) }]));
  const pick = (...keys) => keys.reduce((a, s) => ({ n: a.n + (q[s]?.n || 0), value: a.value + (q[s]?.value || 0) }), { n: 0, value: 0 });
  const pipeline = { sent: pick("issued", "accepted", "converted", "rejected", "expired"), open: pick("issued", "accepted"), won: pick("accepted", "converted"), lost: pick("rejected", "expired") };

  return {
    asAt,
    company,
    kpi: {
      outstanding: n(k.outstanding), openInvoices: n(k.open_invoices), overdue: n(k.overdue), overdueCount: n(k.overdue_count),
      oldestOverdue: n(k.oldest_overdue), billedMonth: trend[5].billed, billedPrev: trend[4].billed,
      collectedMonth: trend[5].collected, collectedPrev: trend[4].collected,
      customers: n(cust.total), newCustomers: n(cust.added),
    },
    trend,
    aging: [n(k.a_current), n(k.a_1_30), n(k.a_31_60), n(k.a_61_90), n(k.a_90)],
    pipeline,
    top: top.map((r) => ({ name: r.name, billed: n(r.billed), outstanding: n(r.outstanding) })),
    attention: [
      ...overdueRows.map((r) => ({ tone: "red", title: `${r.number} is ${n(r.days)} day${n(r.days) === 1 ? "" : "s"} overdue`, meta: r.customer || "", amount: n(r.balance) })),
      ...expiring.map((r) => ({ tone: "amber", title: `Quotation ${r.number} expires ${n(r.days) === 0 ? "today" : `in ${n(r.days)} day${n(r.days) === 1 ? "" : "s"}`}`, meta: r.customer || "", amount: n(r.total) })),
      ...(n(leads.fresh) ? [{ tone: "blue", title: `${n(leads.fresh)} new form submission${n(leads.fresh) === 1 ? "" : "s"} to review`, meta: leads.latest_form || "" }] : []),
    ],
    recent: recent.map((r) => ({ number: r.number || "Draft", type: r.doc_type, status: r.status, total: n(r.total), customer: r.customer || "", on: String(r.on_date instanceof Date ? r.on_date.toISOString() : r.on_date).slice(0, 10) })),
  };
}

// ---------------------------------------------------------------- format helpers

const rm = (v) => `RM ${n(v).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Compact money for tiles: RM 42,843 / RM 234.5k / RM 1.28M. */
const rmShort = (v) => {
  const x = n(v);
  if (Math.abs(x) >= 1e6) return `RM ${(x / 1e6).toFixed(2)}M`;
  if (Math.abs(x) >= 1e5) return `RM ${(x / 1e3).toFixed(1)}k`;
  return `RM ${x.toLocaleString("en-MY", { maximumFractionDigits: 0 })}`;
};
const axis = (v) => (v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${+(v / 1e3).toFixed(1)}k` : String(Math.round(v)));
const niceMax = (v) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
};
const fmtDay = (iso) => {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : "";
};
const fmtAsAt = (iso) => {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso;
};
const initials = (name) => String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const STATUS_TONE = { paid: "green", accepted: "green", issued: "blue", converted: "blue", partially_paid: "amber", draft: "grey", void: "red", cancelled: "red", rejected: "red", expired: "red" };
const statusText = (s) => String(s).replace(/_/g, " ");

function delta(cur, prev) {
  if (!prev) return cur ? `<span class="crm-chip up">new</span>` : "";
  const pct = ((cur - prev) / prev) * 100;
  if (Math.abs(pct) < 0.5) return `<span class="crm-chip flat">▬ flat</span>`;
  return `<span class="crm-chip ${pct > 0 ? "up" : "down"}">${pct > 0 ? "▲" : "▼"} ${Math.abs(Math.round(pct))}%</span>`;
}

// ---------------------------------------------------------------- pieces

function kpi({ label, value, sub = "", tone = "", chip = "" }) {
  return `<div class="crm-kpi ${tone}"><div class="crm-kpi-label">${esc(label)}</div><div class="crm-kpi-value">${esc(value)}</div><div class="crm-kpi-sub">${chip}${sub ? `<span>${esc(sub)}</span>` : ""}</div></div>`;
}

function trendChart(trend) {
  const W = 540, H = 200, L = 40, R = 8, T = 10, B = 26;
  const max = niceMax(Math.max(...trend.map((t) => Math.max(t.billed, t.collected))));
  const iw = W - L - R, ih = H - T - B, slot = iw / trend.length, bw = Math.min(22, slot * 0.32);
  const y = (v) => T + ih - (v / max) * ih;
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" class="crm-grid-line"/><text x="${L - 6}" y="${yy + 3.5}" text-anchor="end" class="crm-axis">${axis(v)}</text>`;
  }
  const bars = trend.map((t, i) => {
    const cx = L + slot * i + slot / 2;
    const bar = (v, x, cls) => `<rect x="${x}" y="${y(v)}" width="${bw}" height="${Math.max(v > 0 ? 2 : 0, T + ih - y(v))}" rx="3" class="${cls}"><title>${esc(t.label)}: ${esc(rm(v))}</title></rect>`;
    return `${bar(t.billed, cx - bw - 1.5, "crm-bar-billed")}${bar(t.collected, cx + 1.5, "crm-bar-collected")}<text x="${cx}" y="${H - 8}" text-anchor="middle" class="crm-axis">${esc(t.label)}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="crm-svg" role="img" aria-label="Billed versus collected, last six months">${g}${bars}</svg>
    <div class="crm-legend"><span><i class="crm-dot billed"></i>Billed</span><span><i class="crm-dot collected"></i>Collected</span></div>`;
}

const AGING = [
  { label: "Not yet due", cls: "a0" }, { label: "1–30 days", cls: "a1" }, { label: "31–60 days", cls: "a2" },
  { label: "61–90 days", cls: "a3" }, { label: "90+ days", cls: "a4" },
];
function agingBlock(aging) {
  const total = aging.reduce((a, v) => a + v, 0);
  if (total <= 0) return `<div class="crm-empty">Nothing outstanding. Every invoice is settled.</div>`;
  const seg = aging.map((v, i) => (v > 0 ? `<span class="crm-seg ${AGING[i].cls}" style="flex:${v}" title="${esc(AGING[i].label)}: ${esc(rm(v))}"></span>` : "")).join("");
  const rows = aging.map((v, i) => `<div class="crm-age-row"><i class="crm-dot ${AGING[i].cls}"></i><span class="crm-age-label">${AGING[i].label}</span><span class="crm-age-pct">${Math.round((v / total) * 100)}%</span><b>${esc(rm(v))}</b></div>`).join("");
  return `<div class="crm-stack">${seg}</div><div class="crm-age">${rows}</div>`;
}

function pipelineBlock(p) {
  if (!p.sent.n) return `<div class="crm-empty">No quotations sent in the last 12 months.</div>`;
  const decided = p.won.n + p.lost.n;
  const rate = decided ? Math.round((p.won.n / decided) * 100) : null;
  const max = p.sent.n;
  const row = (label, s, cls) => `<div class="crm-fun"><div class="crm-fun-head"><span>${label}</span><b>${s.n}</b><em>${esc(rmShort(s.value))}</em></div><div class="crm-track"><span class="crm-fill ${cls}" style="width:${Math.max(4, (s.n / max) * 100)}%"></span></div></div>`;
  return `${row("Sent", p.sent, "f0")}${row("Won", p.won, "f1")}${row("Lost / expired", p.lost, "f2")}${row("Open now", p.open, "f3")}
    <div class="crm-foot">${rate === null ? "No decided quotations yet" : `Win rate <b>${rate}%</b> of ${decided} decided`}</div>`;
}

function topBlock(top) {
  if (!top.length) return `<div class="crm-empty">No invoices issued in the last 12 months.</div>`;
  const max = Math.max(...top.map((t) => t.billed)) || 1;
  return top.map((t) => `<div class="crm-cust"><span class="crm-av">${esc(initials(t.name))}</span><div class="crm-cust-body"><div class="crm-cust-top"><span class="crm-cust-name">${esc(t.name)}</span><b>${esc(rmShort(t.billed))}</b></div><div class="crm-track thin"><span class="crm-fill f1" style="width:${Math.max(3, (t.billed / max) * 100)}%"></span></div>${t.outstanding > 0.005 ? `<div class="crm-cust-owe">${esc(rmShort(t.outstanding))} outstanding</div>` : ""}</div></div>`).join("");
}

function attentionBlock(items) {
  if (!items.length) return `<div class="crm-empty ok">All clear. Nothing overdue, expiring or waiting for review.</div>`;
  return items.map((a) => `<div class="crm-att ${a.tone}"><i class="crm-pin"></i><div class="crm-att-body"><div class="crm-att-title">${esc(a.title)}</div>${a.meta ? `<div class="crm-att-meta">${esc(a.meta)}</div>` : ""}</div>${a.amount != null ? `<b class="crm-att-amt">${esc(rmShort(a.amount))}</b>` : ""}</div>`).join("");
}

function recentBlock(rows) {
  if (!rows.length) return `<div class="crm-empty">No documents yet.</div>`;
  const kind = { quotation: "QT", invoice: "INV", credit_note: "CN" };
  return rows.map((r) => `<div class="crm-doc"><span class="crm-kind">${kind[r.type] || "DOC"}</span><div class="crm-doc-body"><div class="crm-doc-top"><b>${esc(r.number)}</b><span class="crm-doc-amt">${esc(rmShort(r.total))}</span></div><div class="crm-doc-meta"><span>${esc(r.customer || "No customer")} · ${esc(fmtDay(r.on))}</span><span class="crm-tag ${STATUS_TONE[r.status] || "grey"}">${esc(statusText(r.status))}</span></div></div></div>`).join("");
}

const panel = (title, body, cls = "", note = "") =>
  `<section class="crm-panel ${cls}"><div class="crm-panel-head"><h2>${esc(title)}</h2>${note ? `<span>${esc(note)}</span>` : ""}</div>${body}</section>`;

const CSS = `
.crm { --ink:#12302a; --body:#3f524b; --muted:#6b7d76; --line:#e2eae6; --card:#fff; --soft:#f4f8f6; --accent:#1c7a5c; --accent2:#8fd0b5; --red:#c23a2f; --amber:#c78414; --blue:#2f6fd6;
  display:grid; gap:12px; color:var(--body); font-size:13px; }
.crm * { box-sizing:border-box; }
.crm b { color:var(--ink); font-weight:700; }
.crm-hero { display:flex; justify-content:space-between; align-items:flex-end; gap:10px; flex-wrap:wrap; padding:16px 18px; border-radius:14px; color:#fff;
  background:linear-gradient(135deg,#12302a 0%,#1c7a5c 100%); }
.crm-hero .eyebrow { font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; opacity:.7; margin:0 0 3px; }
.crm-hero h1 { margin:0; font-size:21px; font-weight:700; letter-spacing:-.01em; color:#fff; }
.crm-hero .asat { font-size:11.5px; padding:4px 11px; border-radius:999px; background:rgba(255,255,255,.16); white-space:nowrap; }
.crm-kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(190px,46%),1fr)); gap:10px; }
.crm-kpi { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 13px; border-top:3px solid var(--accent2); min-width:0; }
.crm-kpi.red { border-top-color:var(--red); } .crm-kpi.amber { border-top-color:var(--amber); } .crm-kpi.blue { border-top-color:var(--blue); } .crm-kpi.dark { border-top-color:var(--ink); }
.crm-kpi-label { font-size:10.5px; letter-spacing:.07em; text-transform:uppercase; color:var(--muted); font-weight:600; }
.crm-kpi-value { font-size:21px; font-weight:700; color:var(--ink); margin:3px 0 4px; letter-spacing:-.01em; overflow-wrap:anywhere; }
.crm-kpi.red .crm-kpi-value { color:var(--red); }
.crm-kpi-sub { display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:11.5px; color:var(--muted); }
.crm-chip { font-size:10.5px; font-weight:700; padding:1px 7px; border-radius:999px; }
.crm-chip.up { background:#dcf5e8; color:#0d6b43; } .crm-chip.down { background:#fde4e1; color:#9f2a20; } .crm-chip.flat { background:#eef2f0; color:#5c6d66; }
.crm-cols { display:grid; grid-template-columns:repeat(auto-fit,minmax(290px,1fr)); gap:12px; }
.crm-panel { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px 15px; min-width:0; }
.crm-panel.wide { grid-column:1 / -1; }
.crm-panel-head { display:flex; justify-content:space-between; align-items:baseline; gap:8px; margin-bottom:10px; }
.crm-panel-head h2 { margin:0; font-size:13px; font-weight:700; color:var(--ink); }
.crm-panel-head span { font-size:11px; color:var(--muted); }
.crm-svg { width:100%; height:auto; display:block; }
.crm-grid-line { stroke:var(--line); stroke-width:1; }
.crm-axis { font-size:10px; fill:var(--muted); }
.crm-bar-billed { fill:var(--ink); } .crm-bar-collected { fill:var(--accent2); }
.crm-legend { display:flex; gap:14px; justify-content:center; margin-top:4px; font-size:11.5px; color:var(--muted); }
.crm-dot { display:inline-block; width:9px; height:9px; border-radius:3px; margin-right:6px; vertical-align:baseline; }
.crm-dot.billed { background:var(--ink); } .crm-dot.collected { background:var(--accent2); }
.a0{background:#8fd0b5}.a1{background:#e7c65c}.a2{background:#e79a3c}.a3{background:#dd6a3a}.a4{background:#b3261e}
.crm-stack { display:flex; height:14px; border-radius:7px; overflow:hidden; gap:2px; margin-bottom:12px; }
.crm-seg { min-width:4px; }
.crm-age-row { display:grid; grid-template-columns:auto 1fr auto auto; align-items:center; gap:6px; padding:5px 0; border-bottom:1px solid var(--line); }
.crm-age-row:last-child { border-bottom:0; } .crm-age-row .crm-dot { margin-right:0; }
.crm-age-pct { color:var(--muted); font-size:11.5px; min-width:34px; text-align:right; }
.crm-fun { margin-bottom:9px; }
.crm-fun-head { display:grid; grid-template-columns:1fr auto auto; gap:10px; align-items:baseline; margin-bottom:4px; }
.crm-fun-head em { font-style:normal; color:var(--muted); font-size:11.5px; min-width:64px; text-align:right; }
.crm-track { height:9px; background:var(--soft); border-radius:5px; overflow:hidden; } .crm-track.thin { height:6px; }
.crm-fill { display:block; height:100%; border-radius:5px; }
.f0{background:#c4d6cf}.f1{background:var(--accent)}.f2{background:#d98b83}.f3{background:var(--blue)}
.crm-foot { margin-top:6px; padding-top:9px; border-top:1px solid var(--line); font-size:12px; color:var(--muted); }
.crm-cust { display:flex; gap:10px; align-items:flex-start; padding:7px 0; border-bottom:1px solid var(--line); }
.crm-cust:last-child { border-bottom:0; }
.crm-av { flex:none; width:30px; height:30px; border-radius:9px; background:var(--accent); color:#fff; font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; }
.crm-cust-body { flex:1; min-width:0; }
.crm-cust-top { display:flex; justify-content:space-between; gap:8px; margin-bottom:5px; }
.crm-cust-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ink); font-weight:600; }
.crm-cust-owe { font-size:11px; color:var(--amber); margin-top:3px; font-weight:600; }
.crm-att { display:flex; align-items:center; gap:10px; padding:9px 10px; border-radius:10px; margin-bottom:6px; background:var(--soft); }
.crm-pin { flex:none; width:8px; height:30px; border-radius:4px; background:var(--muted); }
.crm-att.red .crm-pin { background:var(--red); } .crm-att.amber .crm-pin { background:var(--amber); } .crm-att.blue .crm-pin { background:var(--blue); }
.crm-att-body { flex:1; min-width:0; } .crm-att-title { color:var(--ink); font-weight:600; } .crm-att-meta { font-size:11.5px; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.crm-att-amt { flex:none; }
.crm-doc { display:flex; gap:10px; align-items:center; padding:7px 0; border-bottom:1px solid var(--line); } .crm-doc:last-child { border-bottom:0; }
.crm-kind { flex:none; width:34px; height:28px; border-radius:8px; background:var(--soft); border:1px solid var(--line); color:var(--muted); font-size:10px; font-weight:700; display:flex; align-items:center; justify-content:center; }
.crm-doc-body { flex:1; min-width:0; }
.crm-doc-top, .crm-doc-meta { display:flex; justify-content:space-between; gap:8px; align-items:center; }
.crm-doc-meta { font-size:11.5px; color:var(--muted); margin-top:1px; } .crm-doc-meta > span:first-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.crm-tag { flex:none; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; padding:1px 8px; border-radius:999px; }
.crm-tag.green{background:#dcf5e8;color:#0d6b43}.crm-tag.blue{background:#dfe9fb;color:#1f4fa8}.crm-tag.amber{background:#fdf0d2;color:#8a5a08}.crm-tag.red{background:#fde4e1;color:#9f2a20}.crm-tag.grey{background:#eef2f0;color:#5c6d66}
.crm-empty { color:var(--muted); font-style:italic; padding:8px 0; } .crm-empty.ok { color:#0d6b43; font-style:normal; background:#eaf7f0; border-radius:10px; padding:11px 12px; }
`;

// ---------------------------------------------------------------- render

/** @param {Awaited<ReturnType<typeof getCrmDashboard>>} d */
export function renderCrmDashboard(d) {
  const k = d.kpi;
  const winDecided = d.pipeline.won.n + d.pipeline.lost.n;
  const tiles = [
    kpi({ label: "Outstanding", value: rmShort(k.outstanding), sub: `${k.openInvoices} open invoice${k.openInvoices === 1 ? "" : "s"}`, tone: "dark" }),
    kpi({ label: "Overdue", value: rmShort(k.overdue), sub: k.overdueCount ? `${k.overdueCount} late · oldest ${k.oldestOverdue}d` : "none late", tone: k.overdueCount ? "red" : "" }),
    kpi({ label: "Billed this month", value: rmShort(k.billedMonth), chip: delta(k.billedMonth, k.billedPrev), sub: "vs last month" }),
    kpi({ label: "Collected this month", value: rmShort(k.collectedMonth), chip: delta(k.collectedMonth, k.collectedPrev), sub: "vs last month" }),
    kpi({ label: "Open quotations", value: rmShort(d.pipeline.open.value), sub: `${d.pipeline.open.n} open${winDecided ? ` · ${Math.round((d.pipeline.won.n / winDecided) * 100)}% win` : ""}`, tone: "blue" }),
    kpi({ label: "Customers", value: String(k.customers), sub: k.newCustomers ? `+${k.newCustomers} this month` : "no new this month", tone: "amber" }),
  ].join("");
  return `<div class="crm"><style>${CSS}</style>
  <div class="crm-hero"><div><p class="eyebrow">${esc(d.company || "CRM")} · CRM</p><h1>Business overview</h1></div><span class="asat">As at ${esc(fmtAsAt(d.asAt))}</span></div>
  <div class="crm-kpis">${tiles}</div>
  <div class="crm-cols">
    ${panel("Billed vs collected", trendChart(d.trend), "wide", "last 6 months")}
    ${panel("Needs attention", attentionBlock(d.attention))}
    ${panel("Receivables aging", agingBlock(d.aging), "", `${rm(d.aging.reduce((a, v) => a + v, 0))} open`)}
    ${panel("Quotation pipeline", pipelineBlock(d.pipeline), "", "last 12 months")}
    ${panel("Top customers", topBlock(d.top), "", "billed, 12 months")}
    ${panel("Recent documents", recentBlock(d.recent), "wide")}
  </div></div>`;
}

/** The tool result: a fenced html block, which the chat renders in its sandboxed report frame. */
export async function crmDashboard(tx, company) {
  const data = await getCrmDashboard(tx, { company });
  return `\`\`\`html\n${renderCrmDashboard(data)}\n\`\`\``;
}

// ---------------------------------------------------------------- dummy data (previews and tests)

export function sampleDashboard() {
  return {
    asAt: "2026-09-30",
    company: "Eternalgy Sdn Bhd",
    kpi: { outstanding: 184320.5, openInvoices: 11, overdue: 62450, overdueCount: 4, oldestOverdue: 47, billedMonth: 96800, billedPrev: 81200, collectedMonth: 74250, collectedPrev: 88900, customers: 128, newCustomers: 6 },
    trend: [
      { label: "Apr", billed: 58200, collected: 51000 }, { label: "May", billed: 72400, collected: 60100 }, { label: "Jun", billed: 66900, collected: 70300 },
      { label: "Jul", billed: 88100, collected: 64800 }, { label: "Aug", billed: 81200, collected: 88900 }, { label: "Sep", billed: 96800, collected: 74250 },
    ],
    aging: [121870.5, 38400, 14200, 6850, 3000],
    pipeline: { sent: { n: 42, value: 1280000 }, open: { n: 9, value: 412500 }, won: { n: 21, value: 706000 }, lost: { n: 12, value: 161500 } },
    top: [
      { name: "Kilang Maju Sdn Bhd", billed: 214500, outstanding: 32000 }, { name: "Sri Petaling Trading", billed: 168200, outstanding: 0 },
      { name: "Harmoni Renewables", billed: 121900, outstanding: 48250 }, { name: "Dr. Lim Wei Han", billed: 64300, outstanding: 0 }, { name: "Bintang Logistik", billed: 41800, outstanding: 6400 },
    ],
    attention: [
      { tone: "red", title: "INV-2026-0031 is 47 days overdue", meta: "Harmoni Renewables", amount: 28500 },
      { tone: "red", title: "INV-2026-0036 is 22 days overdue", meta: "Kilang Maju Sdn Bhd", amount: 19750 },
      { tone: "amber", title: "Quotation QT-2026-0052 expires in 3 days", meta: "Bintang Logistik", amount: 56000 },
      { tone: "blue", title: "5 new form submissions to review", meta: "Solar site survey request" },
    ],
    recent: [
      { number: "INV-2026-0044", type: "invoice", status: "issued", total: 27128, customer: "Kilang Maju Sdn Bhd", on: "2026-09-29" },
      { number: "QT-2026-0055", type: "quotation", status: "accepted", total: 84500, customer: "Sri Petaling Trading", on: "2026-09-28" },
      { number: "INV-2026-0043", type: "invoice", status: "paid", total: 12400, customer: "Dr. Lim Wei Han", on: "2026-09-26" },
      { number: "INV-2026-0042", type: "invoice", status: "partially_paid", total: 41200, customer: "Harmoni Renewables", on: "2026-09-24" },
      { number: "QT-2026-0054", type: "quotation", status: "issued", total: 56000, customer: "Bintang Logistik", on: "2026-09-23" },
      { number: "Draft", type: "invoice", status: "draft", total: 9800, customer: "Bintang Logistik", on: "2026-09-22" },
    ],
  };
}
