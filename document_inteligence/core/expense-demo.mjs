// Demo data for /demo: a dozen believable claims across two monthly submissions, each with a
// generated sample receipt. It goes through the same domain code as the Expenses Clerk (receipt
// checks, numbering, cut-off rules, closing, the report), so the demo shows the real behaviour
// rather than a mock-up. Idempotent: it does nothing if demo claims already exist.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { publishFile, readSharedFile, sharedFileLocation } from "../../server/shared-files.mjs";
import { escapeHtml as esc } from "../../server/report-html.mjs";
import { addDays, todayMY } from "./common.mjs";
import { withContext } from "./db.mjs";
import { addMonths, batchLabel, closeSubmission, cycleFor, cycleOf, fileClaim, getSettings, reviewClaim } from "./expenses.mjs";
import { publishExpenseReport } from "./expense-report.mjs";
import { loadReceipts } from "./receipts.mjs";
import { money, fmtDate } from "./templates.mjs";

const PEOPLE = {
  aisyah: { name: "Aisyah Rahman", email: "aisyah.rahman@example.com" },
  daniel: { name: "Daniel Lee", email: "daniel.lee@example.com" },
  priya: { name: "Priya Nair", email: "priya.nair@example.com" },
};

// `when`: days before the submission's cut-off (previous cycle) or before today (current cycle).
const PREVIOUS = [
  { who: "aisyah", when: 14, merchant: "Grab", category: "transport", amount: 28.5, description: "Ride to client site, KLCC", pay: "e_wallet", decision: "approve", address: "Grab Malaysia Sdn Bhd" },
  { who: "aisyah", when: 11, merchant: "Starbucks Mid Valley", category: "meals", amount: 42.3, description: "Coffee with the Acme team", pay: "personal_card", decision: "approve", address: "Mid Valley City, Kuala Lumpur" },
  { who: "daniel", when: 9, merchant: "Petronas Jalan Kuching", category: "transport", amount: 120, description: "Fuel for the Penang site visit", pay: "personal_card", decision: "approve", address: "Jalan Kuching, Kuala Lumpur" },
  { who: "daniel", when: 7, merchant: "Hilton Kuala Lumpur", category: "accommodation", amount: 380, tax: 22, description: "One night, Penang handover trip", pay: "personal_card", decision: "approve", address: "3 Jalan Stesen Sentral, Kuala Lumpur" },
  { who: "priya", when: 4, merchant: "Popular Bookstore", category: "office", amount: 64.9, description: "Books", pay: "cash", decision: "reject", note: "Looks like a personal purchase, not business related", address: "Sunway Pyramid, Petaling Jaya" },
  { who: "admin", when: 1, merchant: "Maxis", category: "communication", amount: 98, description: "Monthly mobile plan", pay: "company_card", decision: "approve", address: "Menara Maxis, Kuala Lumpur" },
];
const CURRENT = [
  { who: "aisyah", when: 17, merchant: "Grab", category: "transport", amount: 34.2, description: "Airport run for the demo day", pay: "e_wallet", decision: "approve", address: "Grab Malaysia Sdn Bhd" },
  { who: "priya", when: 15, merchant: "Pos Laju", category: "courier", amount: 15, description: "Contract documents to Johor", pay: "cash", decision: "approve", address: "Pos Malaysia, Shah Alam" },
  { who: "aisyah", when: 6, merchant: "Tealive", category: "meals", amount: 18.5, description: "Team lunch drinks", pay: "e_wallet", address: "Bangsar South, Kuala Lumpur" },
  { who: "daniel", when: 4, merchant: "PLUS Highway toll", category: "transport", amount: 26.4, description: "Tolls, KL to Ipoh and back", pay: "e_wallet", address: "PLUS Expressways Berhad" },
  { who: "daniel", when: 2, merchant: "AirAsia", category: "travel", amount: 459, description: "Flight to Kuching for the site audit", pay: "personal_card", address: "AirAsia Berhad, Sepang" },
  { who: "admin", when: 0, merchant: "Atmosphere 360", category: "entertainment", amount: 186.4, tax: 10.55, description: "Client lunch with Acme", pay: "company_card", address: "Menara KL, Jalan Punchak" },
];

/** A small receipt page, clearly marked as a sample. Pure: no I/O. */
export function demoReceiptHtml(c, { date, number, currency = "MYR" }) {
  const subtotal = c.tax ? c.amount - c.tax : c.amount;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Receipt ${esc(c.merchant)}</title><style>
    @page { size: 80mm 135mm; margin: 5mm; }
    body { font: 9pt/1.45 "Courier New", monospace; color: #111; margin: 0; }
    h1 { font: 700 12pt Arial, sans-serif; text-align: center; margin: 0 0 1mm; }
    .c { text-align: center; } .s { font-size: 7.5pt; color: #444; }
    hr { border: 0; border-top: 1px dashed #666; margin: 3mm 0; }
    .row { display: flex; justify-content: space-between; } .t { font-weight: 700; font-size: 11pt; }
    .demo { margin-top: 4mm; border: 1px solid #b00; color: #b00; text-align: center; padding: 1mm; font: 700 7pt Arial, sans-serif; letter-spacing: .08em; }
  </style></head><body>
    <h1>${esc(c.merchant)}</h1><div class="c s">${esc(c.address)}</div><hr>
    <div class="row"><span>Receipt</span><span>${esc(number)}</span></div>
    <div class="row"><span>Date</span><span>${esc(fmtDate(date))}</span></div><hr>
    <div class="row"><span>${esc(c.description)}</span><span>${money(subtotal)}</span></div>
    ${c.tax ? `<div class="row"><span>SST (8%)</span><span>${money(c.tax)}</span></div>` : ""}<hr>
    <div class="row t"><span>TOTAL ${esc(currency)}</span><span>${money(c.amount)}</span></div>
    <div class="row s"><span>Paid by</span><span>${esc(c.pay.replace(/_/g, " "))}</span></div>
    <div class="demo">SAMPLE RECEIPT, DEMO DATA</div></body></html>`;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * @param {object} deps runTool-style dependencies (db, tenantId, workspace, renderPdf, filesRoot, publicUrl, asRole)
 * @param {{ id: string, username: string, role: string, display_name?: string, email?: string|null }} who the admin pressing the button
 * @param {{ now?: Date }} [opts]
 */
export async function seedDemoClaims(deps, who, { now = new Date() } = {}) {
  if (who?.role !== "admin") throw new Error("Only an admin can load demo claims");
  if (!deps.renderPdf) throw new Error("Demo receipts need the PDF renderer, which this host does not have");
  const tenantId = await deps.tenantId();
  const ctx = { tenantId, actor: who.username, agent: "di-expenses", asRole: deps.asRole, who };
  const run = (fn) => withContext(deps.db, ctx, fn);
  const existing = (await run((tx) => tx.query("SELECT count(*)::int AS n FROM di.expense_claim WHERE custom->>'demo' = 'true'"))).rows[0].n;
  if (existing) return { seeded: 0, already_loaded: existing };

  const workspace = deps.workspace("di-expenses");
  const root = deps.filesRoot ?? path.join(path.dirname(workspace), "files");
  const publish = (rel) => publishFile({ root, companyId: tenantId, workspace, source: rel, publicUrl: deps.publicUrl });
  const settings = await run((tx) => getSettings(tx));
  const today = todayMY(now);
  const current = cycleFor(today, settings.cutoff_day);
  const previous = cycleOf(addMonths(current.period_key, -1), settings.cutoff_day);
  const previousBatch = (await run((tx) => tx.query("SELECT status FROM di.expense_batch WHERE period_key = $1 AND deleted_at IS NULL", [previous.period_key]))).rows[0];
  const stamp = Date.now();
  let n = 0;

  const person = (key) => key === "admin"
    ? { user_id: who.id, member_id: null, name: who.display_name || who.username, email: who.email ?? null }
    : { user_id: null, member_id: null, ...PEOPLE[key] };

  const file = async (c, filedOn) => {
    const date = addDays(filedOn, -(c.when % 2));
    const claimant = person(c.who);
    const rel = `_inbox/${stamp + n}-0-receipt-${slug(c.merchant)}.pdf`;
    await mkdir(path.join(workspace, "_inbox"), { recursive: true });
    await deps.renderPdf(demoReceiptHtml(c, { date, number: `R-${String(stamp + n).slice(-6)}`, currency: settings.currency }), path.join(workspace, rel));
    n++;
    const receipts = await loadReceipts([rel], { workspace, publish });
    const input = {
      expense_date: date, merchant: c.merchant, category: c.category, amount: c.amount, tax_amount: c.tax,
      description: c.description, payment_method: c.pay, custom: { demo: true },
    };
    const filed = await run((tx) => fileClaim(tx, input, { who, receipts, now: new Date(`${filedOn}T04:00:00Z`), claimant }));
    if (c.decision) {
      await run((tx) => reviewClaim(tx, { claim: filed.claim.number, decision: c.decision, note: c.note }, { who }));
    }
    return filed.claim.number;
  };

  const numbers = [];
  let closed = null;
  if (previousBatch?.status !== "closed") {
    for (const c of PREVIOUS) numbers.push(await file(c, addDays(previous.cutoff_date, -c.when)));
    const out = await run((tx) => closeSubmission(tx, { month: previous.period_key }, { who }));
    const env = {
      db: deps.db, ctx, renderPdf: deps.renderPdf, workspaceDir: workspace, publish,
      readShared: async (href) => readSharedFile({ root, companyId: tenantId, ...sharedFileLocation(href) }),
    };
    const report = await publishExpenseReport(env, out.report).catch(() => null);
    closed = { label: batchLabel(previous.period_key), report: report?.pdf?.link ?? null };
  }
  for (const c of CURRENT) {
    const filedOn = addDays(today, -c.when);
    numbers.push(await file(c, filedOn < current.period_start ? current.period_start : filedOn));
  }
  return { seeded: numbers.length, claims: numbers, closed_submission: closed, open_submission: batchLabel(current.period_key) };
}
