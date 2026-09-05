// Data layer for the Sales MCP tools. Runs the exact, verified SQL/HTTP calls
// described in agent/roles/sales.md as plain code, so the agent never has to
// write SQL or re-derive the schema itself.

const PG_PROXY_SQL_URL = "https://pg-proxy-production.up.railway.app/api/sql";
const PG_DB = "prod_main";
const CATALOG_TTL_MS = 3 * 60 * 60 * 1000; // product/package rarely change; refresh every 3h

async function pgQuery(sql, params = []) {
  const token = process.env.SALES_PG_PROXY_TOKEN;
  if (!token) {
    throw new Error(
      "SALES_PG_PROXY_TOKEN is not set. Tell the operator to save the Sales DB access token in Settings, then start a new chat.",
    );
  }
  const res = await fetch(PG_PROXY_SQL_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ db_name: PG_DB, sql, params }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error || body?.message || `pg-proxy query failed (HTTP ${res.status})`);
  }
  return body?.rows || [];
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function dateFilter(column, from, to) {
  const clauses = [];
  const params = [];
  if (from) {
    params.push(from);
    clauses.push(`${column} >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    clauses.push(`${column} <= $${params.length}`);
  }
  return { clause: clauses.length ? ` and ${clauses.join(" and ")}` : "", params };
}

// ---------------------------------------------------------------------------
// Catalog cache: package -> [{productId, qty}], product -> {name, label}.
// This is the "which model, how many" bill-of-materials data, which the
// operator confirmed almost never changes — so it's cached in-process
// instead of re-joined on every tool call. Falls back to a synchronous
// reload on first use or after CATALOG_TTL_MS.
// ---------------------------------------------------------------------------
let catalogCache = null;

async function loadCatalog() {
  const [packageItemRows, productRows] = await Promise.all([
    pgQuery(
      `select pkg.bubble_id as package_id, pi.product as product_id, coalesce(pi.qty, 1) as qty
       from package pkg
       join package_item pi on pi.bubble_id = any(pkg.linked_package_item)`,
    ),
    pgQuery(`select bubble_id, name, label from product`),
  ]);
  const packages = new Map();
  for (const row of packageItemRows) {
    const list = packages.get(row.package_id) || [];
    list.push({ productId: row.product_id, qty: Number(row.qty) || 1 });
    packages.set(row.package_id, list);
  }
  const products = new Map();
  for (const row of productRows) products.set(row.bubble_id, { name: row.name, label: row.label });
  catalogCache = { packages, products, loadedAt: Date.now() };
  return catalogCache;
}

export async function getCatalog({ force = false } = {}) {
  if (force || !catalogCache || Date.now() - catalogCache.loadedAt > CATALOG_TTL_MS) {
    await loadCatalog();
  }
  return catalogCache;
}

export async function refreshCatalog() {
  await loadCatalog();
  return { packages: catalogCache.packages.size, products: catalogCache.products.size, loadedAt: catalogCache.loadedAt };
}

/** Resolves one invoice_item row into [{model, units}] using the catalog cache. */
function resolveLine(catalog, { linkedPackage, linkedProduct, qty }) {
  const lineQty = Number(qty) || 1;
  if (linkedPackage && catalog.packages.has(linkedPackage)) {
    return catalog.packages.get(linkedPackage).map(({ productId, qty: unitQty }) => {
      const product = catalog.products.get(productId);
      return { model: product?.name || null, units: unitQty * lineQty };
    });
  }
  if (linkedProduct) {
    const product = catalog.products.get(linkedProduct);
    return [{ model: product?.name || null, units: lineQty }];
  }
  return [];
}

async function modelBreakdownForInvoices(invoiceBubbleIds) {
  if (!invoiceBubbleIds.length) return new Map();
  const items = await pgQuery(
    `select linked_invoice, linked_package, linked_product, qty from invoice_item where linked_invoice = any($1)`,
    [invoiceBubbleIds],
  );
  const catalog = await getCatalog();
  const byInvoice = new Map();
  for (const item of items) {
    const list = byInvoice.get(item.linked_invoice) || [];
    list.push(
      ...resolveLine(catalog, { linkedPackage: item.linked_package, linkedProduct: item.linked_product, qty: item.qty }).filter(
        (line) => line.model,
      ),
    );
    byInvoice.set(item.linked_invoice, list);
  }
  return byInvoice;
}

// ---------------------------------------------------------------------------
// Paid-invoice base query (the operator's rule: paid > 0 = official invoice)
// ---------------------------------------------------------------------------
async function paidInvoices({ from, to } = {}) {
  const { clause, params } = dateFilter("i.invoice_date", from, to);
  return pgQuery(
    `select i.id, i.bubble_id, i.invoice_number, i.total_amount, i.invoice_date,
            coalesce(sum(p.amount), 0) as paid_amount,
            i.linked_seda_registration
     from invoice i
     left join payment p on p.linked_invoice = i.bubble_id
     where i.is_deleted = false and i.is_latest = true${clause}
     group by i.id, i.bubble_id, i.invoice_number, i.total_amount, i.invoice_date, i.linked_seda_registration`,
    params,
  );
}

function installLabel(paymentPct, sedaApproved) {
  if (paymentPct >= 0.99) return "installed (est.)";
  if (sedaApproved && paymentPct > 0.6) return "ready to install (est.)";
  if (paymentPct > 0.01) return "deposited (est.)";
  return "quotation";
}

function sedaApproved(status) {
  return typeof status === "string" && /approved/i.test(status) && status !== "DEMO";
}

// ---------------------------------------------------------------------------
// Tool-facing queries
// ---------------------------------------------------------------------------

export async function queryReceivedPayment({ from, to } = {}) {
  const { clause, params } = dateFilter("payment_date", from, to);
  const rows = await pgQuery(`select coalesce(sum(amount), 0) as total, count(*) as count from payment where true${clause}`, params);
  return { total: round2(rows[0]?.total), count: Number(rows[0]?.count) || 0, from: from || null, to: to || null };
}

export async function querySalesSummary({ from, to, kind = "invoice" } = {}) {
  const rows = await paidInvoices({ from, to });
  const filtered = kind === "invoice" ? rows.filter((r) => Number(r.paid_amount) > 0) : rows;
  const total = filtered.reduce((sum, r) => sum + (Number(r.total_amount) || 0), 0);
  return { total: round2(total), count: filtered.length, kind, from: from || null, to: to || null };
}

export async function queryUnpaidOutstanding({ from, to } = {}) {
  const rows = await paidInvoices({ from, to });
  const invoices = rows.filter((r) => Number(r.paid_amount) > 0);
  const total = invoices.reduce((sum, r) => sum + (Number(r.total_amount) - Number(r.paid_amount)), 0);
  return { total: round2(total), count: invoices.length, from: from || null, to: to || null };
}

export async function queryInvoiceStatus(ref) {
  const rows = await pgQuery(
    `select i.id, i.bubble_id, i.invoice_number, i.total_amount, i.invoice_date,
            coalesce(sum(p.amount), 0) as paid_amount,
            i.linked_seda_registration
     from invoice i
     left join payment p on p.linked_invoice = i.bubble_id
     where i.is_deleted = false and i.is_latest = true and (i.invoice_number = $1 or i.bubble_id = $1)
     group by i.id, i.bubble_id, i.invoice_number, i.total_amount, i.invoice_date, i.linked_seda_registration`,
    [ref],
  );
  const invoice = rows[0];
  if (!invoice) return null;

  const [sedaRows, breakdown] = await Promise.all([
    invoice.linked_seda_registration
      ? pgQuery(`select seda_status from seda_registration where bubble_id = $1`, [invoice.linked_seda_registration])
      : Promise.resolve([]),
    modelBreakdownForInvoices([invoice.bubble_id]),
  ]);
  const sedaStatus = sedaRows[0]?.seda_status ?? null;
  const paidAmount = Number(invoice.paid_amount) || 0;
  const totalAmount = Number(invoice.total_amount) || 0;
  const paymentPct = totalAmount ? paidAmount / totalAmount : 0;

  const models = new Map();
  for (const line of breakdown.get(invoice.bubble_id) || []) {
    models.set(line.model, (models.get(line.model) || 0) + line.units);
  }

  return {
    invoiceNumber: invoice.invoice_number,
    invoiceDate: invoice.invoice_date,
    totalAmount: round2(totalAmount),
    paidAmount: round2(paidAmount),
    unpaidAmount: round2(totalAmount - paidAmount),
    paymentPct,
    sedaStatus,
    installLabel: installLabel(paymentPct, sedaApproved(sedaStatus)),
    models: [...models.entries()].map(([model, units]) => ({ model, units: round2(units) })),
  };
}

/** Forward-looking demand pipeline: which models the committed order book needs, by confidence tier. */
export async function queryPredictStockOut({ tier = "all" } = {}) {
  const rows = await paidInvoices();
  const classified = rows
    .filter((r) => Number(r.paid_amount) > 0)
    .map((r) => {
      const totalAmount = Number(r.total_amount) || 0;
      const paidAmount = Number(r.paid_amount) || 0;
      const paymentPct = totalAmount ? paidAmount / totalAmount : 0;
      return { ...r, paymentPct, totalAmount };
    });

  const sedaIds = [...new Set(classified.map((r) => r.linked_seda_registration).filter(Boolean))];
  const sedaRows = sedaIds.length
    ? await pgQuery(`select bubble_id, seda_status from seda_registration where bubble_id = any($1)`, [sedaIds])
    : [];
  const sedaByBubbleId = new Map(sedaRows.map((r) => [r.bubble_id, r.seda_status]));

  const withTier = classified.map((r) => {
    const status = sedaByBubbleId.get(r.linked_seda_registration) ?? null;
    const t = r.paymentPct > 0.599 && sedaApproved(status) ? "confirmed" : "soft";
    return { ...r, sedaStatus: status, tier: t };
  });

  const filtered = tier === "all" ? withTier : withTier.filter((r) => r.tier === tier);
  if (!filtered.length) return { tiers: [] };

  const breakdown = await modelBreakdownForInvoices(filtered.map((r) => r.bubble_id));

  const buckets = new Map();
  for (const inv of filtered) {
    const bucket = buckets.get(inv.tier) || { tier: inv.tier, invoices: 0, totalValue: 0, models: new Map() };
    bucket.invoices += 1;
    bucket.totalValue += inv.totalAmount;
    for (const line of breakdown.get(inv.bubble_id) || []) {
      bucket.models.set(line.model, (bucket.models.get(line.model) || 0) + line.units);
    }
    buckets.set(inv.tier, bucket);
  }

  return {
    tiers: [...buckets.values()].map((bucket) => ({
      tier: bucket.tier,
      invoices: bucket.invoices,
      totalValue: round2(bucket.totalValue),
      models: [...bucket.models.entries()]
        .map(([model, units]) => ({ model, units: round2(units) }))
        .sort((a, b) => b.units - a.units),
    })),
  };
}

// ---------------------------------------------------------------------------
// Stock inventory (this host's own local API, not prod_main)
// ---------------------------------------------------------------------------
async function stockApiGet(pathname) {
  const base = process.env.STOCK_API_URL;
  const token = process.env.STOCK_API_TOKEN;
  if (!base || !token) throw new Error("STOCK_API_URL/STOCK_API_TOKEN not set for this agent runtime.");
  const res = await fetch(`${base}${pathname}`, { headers: { "x-api-key": token } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `stock API failed (HTTP ${res.status})`);
  return body;
}

export async function queryStockLevels() {
  const body = await stockApiGet("/api/stock");
  return body?.items || body?.stock || body || [];
}

/** Backward-looking: trailing 30-day sales velocity vs. current stock on hand. */
export async function queryStockVelocity({ thresholdDays = 14 } = {}) {
  const [stockItems, invoices] = await Promise.all([
    queryStockLevels(),
    paidInvoices({ from: isoDaysAgo(30) }),
  ]);
  const paidOnly = invoices.filter((r) => Number(r.paid_amount) > 0);
  const breakdown = await modelBreakdownForInvoices(paidOnly.map((r) => r.bubble_id));

  const soldByModel = new Map();
  for (const list of breakdown.values()) {
    for (const line of list) {
      soldByModel.set(line.model, (soldByModel.get(line.model) || 0) + line.units);
    }
  }

  return stockItems.map((item) => {
    const modelName = item.modelName || item.model_name || item.name;
    const qtyOnHand = Number(item.qty ?? item.qtyOnHand ?? 0);
    const key = [...soldByModel.keys()].find((m) => m && modelName && m.trim().toLowerCase() === String(modelName).trim().toLowerCase());
    const unitsSold30d = key ? soldByModel.get(key) : 0;
    const dailyRate = unitsSold30d / 30;
    const daysOfCover = dailyRate > 0 ? qtyOnHand / dailyRate : null;
    return {
      model: modelName,
      qtyOnHand,
      unitsSold30d: round2(unitsSold30d),
      daysOfCover: daysOfCover == null ? null : Math.round(daysOfCover * 10) / 10,
      soldOutSoon: daysOfCover != null && daysOfCover < thresholdDays,
    };
  });
}

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
