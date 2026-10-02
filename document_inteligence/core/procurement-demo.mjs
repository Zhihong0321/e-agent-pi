// Demo data for /demo: four suppliers and a believable spread of procurement states, each supplier
// document with a generated sample PDF. It goes through the same domain code as the Procurement
// Clerk, so the demo shows the real rules: numbering, freezing, receiving, the invoice match.
// Idempotent: it does nothing if demo suppliers already exist.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { escapeHtml as esc } from "../../server/report-html.mjs";
import { publishFile, readSharedFile, sharedFileLocation } from "../../server/shared-files.mjs";
import { addDays, todayMY } from "./common.mjs";
import { withContext } from "./db.mjs";
import { createPoDraft, decideQuotation, issuePo, receiveGoods, recordSupplierDocument, saveSupplier, setInvoiceStatus } from "./procurement.mjs";
import { publishPoPdf } from "./procurement-report.mjs";
import { loadReceipts } from "./receipts.mjs";
import { fmtDate, money } from "./templates.mjs";

const SUPPLIERS = [
  { key: "maju", name: "Kedai Elektrik Maju Sdn Bhd", reg_no: "201901023456", email: "jualan@majuelektrik.example", phone: "03-5523 8812", contact_name: "Encik Hafiz", payment_terms_days: 30, address: "Lot 12, Jalan Perindustrian 4, 40000 Shah Alam, Selangor" },
  { key: "solar", name: "Solar Parts Asia Sdn Bhd", reg_no: "202003045678", email: "orders@solarparts.example", phone: "04-398 2200", contact_name: "Ms Tan", payment_terms_days: 14, address: "No. 8, Lebuh Perusahaan, 13600 Perai, Penang" },
  { key: "office", name: "OfficeMart Trading", email: "sales@officemart.example", phone: "03-7960 1122", contact_name: "Puan Sarah", payment_terms_days: 7, address: "22, Jalan SS 2/66, 47300 Petaling Jaya, Selangor" },
  { key: "tech", name: "Tech Supplies Enterprise", reg_no: "000123456-K", email: "enquiry@techsupplies.example", phone: "03-2142 7788", contact_name: "Mr Kumar", payment_terms_days: 30, address: "Level 3, Wisma Teknologi, 50450 Kuala Lumpur" },
];

const CABLES = [{ description: "Solar cable 4mm (100m roll)", quantity: 10, unit: "roll", unit_price: 120, tax_rate: 8 }, { description: "DC isolator 32A", quantity: 20, unit: "pcs", unit_price: 45, tax_rate: 8 }];
const SOLAR = [{ description: "Solar panel 550W", quantity: 40, unit: "pcs", unit_price: 480, tax_rate: 8 }, { description: "Mounting rail 4.2m", quantity: 60, unit: "pcs", unit_price: 38, tax_rate: 8 }];
const OFFICE = [{ description: "A4 paper 80gsm (box of 5 reams)", quantity: 30, unit: "box", unit_price: 62, tax_rate: 8 }, { description: "Ink cartridge set", quantity: 6, unit: "set", unit_price: 145, tax_rate: 8 }];
const LAPTOPS = [{ description: "Laptop 14in, 16GB/512GB", quantity: 3, unit: "pcs", unit_price: 3200, tax_rate: 8 }];

/** A one-page sample supplier document. Pure: no I/O. */
export function demoDocumentHtml({ kind, supplier, ref, date, lines, total }) {
  const rows = lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="r">${l.quantity}</td><td class="r">${money(l.unit_price)}</td><td class="r">${money(l.quantity * l.unit_price * (1 + (l.tax_rate || 0) / 100))}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(kind)} ${esc(ref)}</title><style>
    @page { size: A5; margin: 10mm; } body { font: 9pt/1.45 Arial, sans-serif; color: #111; }
    h1 { font-size: 13pt; margin: 0 0 1mm; } .s { color: #555; font-size: 8pt; } table { width: 100%; border-collapse: collapse; margin-top: 5mm; }
    th, td { padding: 1.5mm; border-bottom: .5pt solid #bbb; text-align: left; } .r { text-align: right; } .t { font-weight: 700; }
    .demo { margin-top: 6mm; border: 1px solid #b00; color: #b00; text-align: center; padding: 1mm; font: 700 7pt Arial; letter-spacing: .08em; }
  </style></head><body><h1>${esc(supplier.name)}</h1><div class="s">${esc(supplier.address)}</div>
  <p><b>${esc(kind)}</b> ${esc(ref)} &nbsp; Date ${esc(fmtDate(date))}</p>
  <table><thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Amount (incl. SST)</th></tr></thead><tbody>${rows}
  <tr class="t"><td colspan="3">Total MYR</td><td class="r">${money(total)}</td></tr></tbody></table>
  <div class="demo">SAMPLE DOCUMENT, DEMO DATA</div></body></html>`;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const total = (lines) => Math.round(lines.reduce((s, l) => s + l.quantity * l.unit_price * (1 + (l.tax_rate || 0) / 100), 0) * 100) / 100;

/**
 * @param {object} deps runTool-style dependencies (db, tenantId, workspace, renderPdf, filesRoot, publicUrl, asRole)
 * @param {{ id: string, username: string, role: string, display_name?: string }} who the admin pressing the button
 */
export async function seedDemoProcurement(deps, who, { now = new Date() } = {}) {
  if (who?.role !== "admin") throw new Error("Only an admin can load demo procurement data");
  if (!deps.renderPdf) throw new Error("Demo documents need the PDF renderer, which this host does not have");
  const tenantId = await deps.tenantId();
  const ctx = { tenantId, actor: who.username, agent: "di-procurement", asRole: deps.asRole, who };
  const run = (fn) => withContext(deps.db, ctx, fn);
  const existing = (await run((tx) => tx.query("SELECT count(*)::int AS n FROM di.supplier WHERE custom->>'demo' = 'true'"))).rows[0].n;
  if (existing) return { seeded: 0, already_loaded: existing };

  const today = todayMY(now);
  const d = (offset) => addDays(today, offset);
  const at = (iso) => new Date(`${iso}T04:00:00Z`);
  const workspace = deps.workspace("di-procurement");
  const root = deps.filesRoot ?? path.join(path.dirname(workspace), "files");
  const publish = (rel) => publishFile({ root, companyId: tenantId, workspace, source: rel, publicUrl: deps.publicUrl });
  const env = {
    db: deps.db, ctx, renderPdf: deps.renderPdf, workspaceDir: workspace, publish,
    readShared: async (href) => readSharedFile({ root, companyId: tenantId, ...sharedFileLocation(href) }),
  };
  const stamp = Date.now();
  let n = 0;
  const sup = {};
  const made = { suppliers: 0, quotations: 0, invoices: 0, pos: 0 };

  for (const s of SUPPLIERS) {
    const { key, ...fields } = s;
    const out = await run((tx) => saveSupplier(tx, fields, { who }));
    await run((tx) => tx.query("UPDATE di.supplier SET custom = custom || '{\"demo\": true}'::jsonb WHERE id = $1", [out.supplier.id]));
    sup[key] = out.supplier;
    made.suppliers++;
  }

  const doc = async (kind, key, ref, date, lines, extra = {}) => {
    const supplier = sup[key];
    const sum = total(lines);
    const rel = `_inbox/${stamp + n}-0-${slug(supplier.name)}-${slug(ref)}.pdf`;
    await mkdir(path.join(workspace, "_inbox"), { recursive: true });
    await deps.renderPdf(demoDocumentHtml({ kind: kind === "quotation" ? "Quotation" : "Tax invoice", supplier, ref, date, lines, total: sum }), path.join(workspace, rel));
    n++;
    const receipts = await loadReceipts([rel], { workspace, publish });
    const out = await run((tx) => recordSupplierDocument(tx, { doc_type: kind, supplier: supplier.code, supplier_ref: ref, doc_date: date, total: sum, lines, ...extra }, { who, receipts, now: at(date) }));
    made[kind === "quotation" ? "quotations" : "invoices"]++;
    return out.document;
  };
  const draftFrom = async (quote, extra) => (await run((tx) => createPoDraft(tx, { from_quotation: quote.number, ...extra }, { who, now: at(extra.order_date) }))).po;
  const issue = async (po, date) => {
    const out = await run((tx) => issuePo(tx, { po: po.number }, { who, now: at(date) }));
    await publishPoPdf(env, out.report).catch(() => null);
    made.pos++;
    return out.po;
  };
  const receive = (po, date, input) => run((tx) => receiveGoods(tx, { po: po.number, received_on: date, ...input }, { who, now: at(date) }));
  const status = (inv, date, input) => run((tx) => setInvoiceStatus(tx, { invoice: inv.number, ...input }, { who, now: at(date) }));

  // A: cables from Maju: quoted, ordered, delivered in full, invoiced, matched, paid
  const qA = await doc("quotation", "maju", "MQ-4410", d(-22), CABLES, { valid_until: d(8) });
  const poA = await issue(await draftFrom(qA, { order_date: d(-18), expected_date: d(-8), ship_to: "Warehouse, Shah Alam", notes: "Deliver before 5pm" }), d(-17));
  await receive(poA, d(-9), { receive_all: true, note: "Delivered in full by lorry" });
  const invA = await doc("invoice", "maju", "INV-7741", d(-8), CABLES, { po: poA.number });
  await status(invA, d(-2), { status: "paid", paid_on: d(-2), reference: "IBG 240918" });

  // B: solar panels from Solar Parts: part delivered, the supplier billed it all (mismatch), late
  const qB = await doc("quotation", "solar", "SPA-2093", d(-16), SOLAR, { valid_until: d(14) });
  const poB = await issue(await draftFrom(qB, { order_date: d(-12), expected_date: d(-2), notes: "Install date is fixed: please confirm delivery" }), d(-11));
  await receive(poB, d(-3), { lines: [{ line_no: 2, quantity: 60 }], note: "Rails arrived; panels still to come" });
  await doc("invoice", "solar", "SPA-INV-5530", d(-3), SOLAR, { po: poB.number });

  // C: stationery from OfficeMart: ordered, waiting for delivery
  const qC = await doc("quotation", "office", "OM-1187", d(-6), OFFICE, { valid_until: d(9) });
  await issue(await draftFrom(qC, { order_date: d(-3), expected_date: d(4) }), d(-3));

  // D: laptops from Tech Supplies: quote accepted, PO still a draft
  const qD = await doc("quotation", "tech", "TS-Q-882", d(-4), LAPTOPS, { valid_until: d(26) });
  await draftFrom(qD, { order_date: d(0), expected_date: d(21), ship_to: "Head office, Kuala Lumpur" });

  // E: an old invoice with no PO, now overdue
  await doc("invoice", "tech", "TS-INV-3320", d(-45), [{ description: "Network switch 24-port", quantity: 2, unit: "pcs", unit_price: 650, tax_rate: 8 }]);
  // F: a disputed invoice
  const invF = await doc("invoice", "office", "OM-INV-0912", d(-20), [{ description: "A4 paper 80gsm (box of 5 reams)", quantity: 50, unit: "box", unit_price: 62, tax_rate: 8 }]);
  await status(invF, d(-15), { status: "disputed", reason: "Delivered 40 boxes but billed for 50" });
  // G: a quotation waiting for an answer, and one that lapsed
  await doc("quotation", "tech", "TS-Q-901", d(-2), [{ description: "Projector 4000 lumens", quantity: 1, unit: "pcs", unit_price: 2890, tax_rate: 8 }], { valid_until: d(5) });
  const lapsed = await doc("quotation", "maju", "MQ-4102", d(-70), [{ description: "LED panel lights", quantity: 40, unit: "pcs", unit_price: 55, tax_rate: 8 }], { valid_until: d(-40) });
  await run((tx) => decideQuotation(tx, { doc: lapsed.number, decision: "reject", note: "Prices went up" }, { who }));

  return { seeded: made.suppliers + made.quotations + made.invoices + made.pos, ...made };
}
