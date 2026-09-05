#!/usr/bin/env node
// Stdio MCP server for the Sales and Procurement agent. Spawned per-session by
// the Pi runtime (see server/sales-mcp.mjs for catalog registration) — it
// inherits SALES_PG_PROXY_TOKEN / STOCK_API_URL / STOCK_API_TOKEN from that
// agent's own process env (server/agent-env.mjs), so no secrets are
// duplicated here.
//
// Each tool answers one of the "Common questions" from agent/roles/sales.md
// with real code instead of agent-written SQL, and renders the answer as a
// ready-to-paste HTML report (server/report-html.mjs) so the agent doesn't
// have to design a reply either — just relay the tool's text output.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  queryReceivedPayment,
  querySalesSummary,
  queryUnpaidOutstanding,
  queryInvoiceStatus,
  queryDemandPipeline,
  queryStockVelocity,
  queryStockLevels,
  recordStockCounts,
  seedStockFromCatalog,
  refreshCatalog,
} from "./sales-data.mjs";
import { reportPage, fenceHtml, statGrid, dataTable, section, note, badge, escapeHtml, fmtMoney, fmtPct, fmtInt } from "./report-html.mjs";

function rangeLabel(from, to) {
  if (!from && !to) return "All time";
  if (from && to) return `${from} → ${to}`;
  if (from) return `From ${from}`;
  return `Until ${to}`;
}

function reply(fragment) {
  return { content: [{ type: "text", text: fenceHtml(fragment) }] };
}

/**
 * Stock-out means demand vs supply. Supply lives in this agent's own inventory, which starts empty
 * and only the operator can fill, so a demand report on its own answers a different question than
 * the one that was asked. Returns the sentence to put in the report, or null when supply is known.
 */
async function stockCoverageGap() {
  try {
    const items = await queryStockLevels();
    if (!items.length) {
      return "This is committed demand only — no stock counts have been recorded, so nothing here says what will actually run out. Record a stock-take (stock_bulk_set) or create the model list first (stock_seed_catalog), then ask again.";
    }
    const counted = items.filter((it) => Number(it.qtyOnHand ?? it.qty ?? 0) > 0).length;
    if (!counted) {
      return `All ${items.length} stock rows are still at zero, so this is committed demand only. Record real counts with stock_bulk_set before reading this as a stock-out risk.`;
    }
    return null;
  } catch {
    // The stock API being unreachable is itself worth saying out loud rather than silently omitting.
    return "Committed demand only — the stock inventory could not be reached, so nothing here says what will actually run out.";
  }
}

function fail(error) {
  return { content: [{ type: "text", text: `Error: ${error?.message || error}` }], isError: true };
}

const server = new McpServer({ name: "sales-data", version: "1.0.0" });

server.registerTool(
  "received_payment",
  {
    title: "Received payment",
    description:
      "Verified money actually received (sum of payment.amount), optionally filtered by date range. Use for 'how much have we collected'.",
    inputSchema: {
      from: z.string().optional().describe("ISO date (YYYY-MM-DD), inclusive lower bound on payment_date"),
      to: z.string().optional().describe("ISO date (YYYY-MM-DD), inclusive upper bound on payment_date"),
    },
  },
  async ({ from, to }) => {
    try {
      const data = await queryReceivedPayment({ from, to });
      return reply(
        reportPage({
          title: "Received payment",
          eyebrow: rangeLabel(data.from, data.to),
          body: statGrid([
            { label: "Verified received", value: fmtMoney(data.total), tone: "green" },
            { label: "Payments", value: fmtInt(data.count) },
          ]),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "sales_summary",
  {
    title: "Sales summary",
    description:
      "Confirmed sales value (kind='invoice', paid > 0) or all quoted+invoiced value (kind='all'), optionally filtered by invoice_date range.",
    inputSchema: {
      from: z.string().optional().describe("ISO date (YYYY-MM-DD), inclusive lower bound on invoice_date"),
      to: z.string().optional().describe("ISO date (YYYY-MM-DD), inclusive upper bound on invoice_date"),
      kind: z.enum(["invoice", "all"]).optional().describe("invoice = official invoices only (default); all = quotations too"),
    },
  },
  async ({ from, to, kind }) => {
    try {
      const data = await querySalesSummary({ from, to, kind });
      return reply(
        reportPage({
          title: "Sales summary",
          eyebrow: rangeLabel(data.from, data.to),
          body:
            statGrid([
              { label: data.kind === "invoice" ? "Confirmed sales value" : "Quoted + invoiced value", value: fmtMoney(data.total), tone: "green" },
              { label: "Count", value: fmtInt(data.count) },
            ]) +
            note(
              `Definition used: ${data.kind === "invoice" ? "official invoices only (paid > 0)" : "all quotations + invoices regardless of payment"}.`,
              "gray",
            ),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "unpaid_outstanding",
  {
    title: "Unpaid / outstanding",
    description: "Total unpaid amount across official invoices (paid > 0), optionally filtered by invoice_date range.",
    inputSchema: {
      from: z.string().optional().describe("ISO date (YYYY-MM-DD)"),
      to: z.string().optional().describe("ISO date (YYYY-MM-DD)"),
    },
  },
  async ({ from, to }) => {
    try {
      const data = await queryUnpaidOutstanding({ from, to });
      return reply(
        reportPage({
          title: "Unpaid / outstanding",
          eyebrow: rangeLabel(data.from, data.to),
          body:
            statGrid([
              { label: "Outstanding", value: fmtMoney(data.total), tone: "amber" },
              { label: "Invoices", value: fmtInt(data.count) },
            ]) + note("Official invoices only (paid > 0) — a pure quotation with RM0 paid isn't a receivable yet.", "gray"),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "invoice_status",
  {
    title: "Invoice status",
    description:
      "Paid/unpaid amount, SEDA status, estimated installation status, and per-model units for one invoice. Use for 'is invoice X paid/installed'.",
    inputSchema: {
      invoiceRef: z.string().describe("invoice_number (e.g. INV-1011513) or bubble_id"),
    },
  },
  async ({ invoiceRef }) => {
    try {
      const inv = await queryInvoiceStatus(invoiceRef);
      if (!inv) return reply(reportPage({ title: "Invoice not found", body: note(`No invoice matches "${invoiceRef}".`, "red") }));
      const tone = inv.installLabel === "quotation" ? "gray" : inv.installLabel.startsWith("deposited") ? "amber" : "green";
      return reply(
        reportPage({
          title: inv.invoiceNumber,
          eyebrow: "Invoice status — estimate",
          badgeHtml: badge(inv.installLabel, tone),
          body:
            statGrid([
              { label: "Total", value: fmtMoney(inv.totalAmount) },
              { label: "Paid", value: fmtMoney(inv.paidAmount), tone: "green" },
              { label: "Unpaid", value: fmtMoney(inv.unpaidAmount), tone: inv.unpaidAmount > 0 ? "amber" : "gray" },
              { label: "Payment %", value: fmtPct(inv.paymentPct) },
            ]) +
            section("SEDA status", `<p style="margin:0">${escapeHtml(inv.sedaStatus || "not submitted")}</p>`) +
            (inv.models.length
              ? section("Models on this invoice", dataTable(["Model", "Units"], inv.models.map((m) => [m.model, fmtInt(m.units)])))
              : ""),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "demand_pipeline",
  {
    title: "Committed demand by model",
    description:
      "Forward-looking DEMAND only: how many units the committed-but-not-yet-fulfilled order book will need per model, split into 'confirmed' (payment>59.9% and SEDA approved) and 'soft' (any other paid invoice) tiers. This is one half of a stock-out question — it cannot say what will run out without stock on hand, which comes from stock_levels.",
    inputSchema: {
      tier: z.enum(["confirmed", "soft", "all"]).optional().describe("Restrict to one tier; defaults to all"),
    },
  },
  async ({ tier }) => {
    try {
      const data = await queryDemandPipeline({ tier: tier || "all" });
      if (!data.tiers.length) return reply(reportPage({ title: "Committed demand by model", body: note("No paid invoices matched.", "gray") }));
      const order = { confirmed: 0, soft: 1 };
      const tiers = [...data.tiers].sort((a, b) => (order[a.tier] ?? 2) - (order[b.tier] ?? 2));
      const stats = tiers.map((t) => ({
        label: t.tier === "confirmed" ? "Confirmed pipeline" : "Soft pipeline",
        value: `${fmtInt(t.invoices)} inv · ${fmtMoney(t.totalValue)}`,
        tone: t.tier === "confirmed" ? "green" : "amber",
      }));
      const sections = tiers
        .map((t) =>
          section(
            `${t.tier === "confirmed" ? "Confirmed" : "Soft"} pipeline — by model`,
            dataTable(["Model", "Units"], t.models.map((m) => [m.model, fmtInt(m.units)])),
          ),
        )
        .join("");
      // Demand alone cannot answer "what will run out". Say so in the report itself rather than
      // trusting the agent to remember, and only after checking whether supply data exists at all.
      const stockGap = await stockCoverageGap();
      return reply(
        reportPage({
          title: "Committed demand by model",
          eyebrow: "Sales & Procurement — estimate, not verified fact",
          body:
            statGrid(stats) +
            (stockGap ? note(stockGap, "red") : "") +
            note(
              "Confirmed pipeline can overstate near-term stock leaving the warehouse: the system doesn't track an actual installation-completed date, so some of these units may already be installed with the customer simply delaying final payment.",
              "amber",
            ) +
            sections,
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "stock_velocity",
  {
    title: "Which models are running low (backward-looking)",
    description:
      "Trailing 30-day sales velocity vs. current stock on hand, from this agent's own stock inventory. Flags a model 'sold out soon' when days-of-cover is below the threshold (default 14).",
    inputSchema: {
      thresholdDays: z.number().optional().describe("Days-of-cover threshold for flagging 'sold out soon' (default 14)"),
    },
  },
  async ({ thresholdDays }) => {
    try {
      const threshold = thresholdDays || 14;
      const rows = await queryStockVelocity({ thresholdDays: threshold });
      if (!rows.length) return reply(reportPage({ title: "Stock velocity", body: note("No stock rows recorded yet.", "gray") }));
      const soon = rows.filter((r) => r.soldOutSoon);
      const stats = [
        { label: "Models tracked", value: fmtInt(rows.length) },
        { label: "Sold out soon", value: fmtInt(soon.length), tone: soon.length ? "red" : "green" },
      ];
      const table = dataTable(
        ["Model", "On hand", "Sold (30d)", "Days of cover"],
        rows
          .slice()
          .sort((a, b) => (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity))
          .map((r) => [
            r.model,
            fmtInt(r.qtyOnHand),
            fmtInt(r.unitsSold30d),
            r.daysOfCover == null ? "no recent sales" : `${r.daysOfCover}d${r.soldOutSoon ? " ⚠" : ""}`,
          ]),
      );
      return reply(
        reportPage({
          title: "Which models are running low",
          eyebrow: `Backward-looking — trailing 30 days, threshold ${threshold}d`,
          body: statGrid(stats) + table,
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "stock_levels",
  {
    title: "Stock on hand",
    description: "Current stock-on-hand levels from this agent's own inventory (raw list, no velocity computation).",
    inputSchema: {},
  },
  async () => {
    try {
      const items = await queryStockLevels();
      return reply(
        reportPage({
          title: "Stock on hand",
          body: dataTable(
            ["Model", "Qty", "Unit"],
            items.map((it) => [it.modelName || it.model_name || it.name, it.qty ?? it.qtyOnHand ?? 0, it.unit || "pcs"]),
          ),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "refresh_catalog",
  {
    title: "Refresh product/package catalog cache",
    description:
      "Force-reloads the cached product/package/package_item bill-of-materials used by demand_pipeline and stock_velocity. Call this only if the operator says a product or package was just added/changed and the numbers look stale — it otherwise auto-refreshes every 3 hours.",
    inputSchema: {},
  },
  async () => {
    try {
      const stats = await refreshCatalog();
      return { content: [{ type: "text", text: `Catalog refreshed: ${stats.packages} packages, ${stats.products} products.` }] };
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "stock_bulk_set",
  {
    title: "Record a stock-take",
    description:
      "Writes many stock counts in one call — the way a stock-take actually arrives. Pass the operator's whole list; model names are matched to the same key every time, so history lines up without the agent inventing slugs. This WRITES: confirm the list with the operator first.",
    inputSchema: {
      rows: z
        .array(
          z.object({
            modelName: z.string().describe("Product name as it appears in the catalog, e.g. '650W JinkoSolar Panel N-Type TOPCon'"),
            qty: z.number().describe("Counted units on hand"),
            unit: z.string().optional().describe("Defaults to pcs"),
          }),
        )
        .min(1)
        .describe("One entry per model counted"),
      reason: z.string().optional().describe("What this count was, e.g. 'stock take 2026-09-05'"),
    },
  },
  async ({ rows, reason }) => {
    try {
      const result = await recordStockCounts({ rows, updatedBy: "operator", reason });
      const saved = result.items || [];
      return reply(
        reportPage({
          title: "Stock recorded",
          eyebrow: reason || "Stock take",
          body:
            statGrid([
              { label: "Models recorded", value: fmtInt(saved.length), tone: "green" },
              ...(result.failed?.length ? [{ label: "Rejected", value: fmtInt(result.failed.length), tone: "red" }] : []),
            ]) +
            dataTable(
              ["Model", "Qty"],
              saved.map((it) => [it.modelName, fmtInt(it.qtyOnHand ?? it.qty ?? 0)]),
            ) +
            (result.failed?.length
              ? note(`Could not record: ${result.failed.map((f) => `${f.modelName} (${f.error})`).join("; ")}`, "red")
              : ""),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "stock_seed_catalog",
  {
    title: "Create stock rows for every catalogued model",
    description:
      "Creates a zero-qty stock row for every product in the catalog that has none yet, leaving existing counts untouched. Use this once so the inventory has the real model list to report against — an empty table cannot be reported on, a table of zeros shows exactly which counts are missing. This WRITES.",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await seedStockFromCatalog();
      return reply(
        reportPage({
          title: "Stock rows created",
          body:
            statGrid([
              { label: "Rows created", value: fmtInt(result.created?.length || 0), tone: "green" },
              { label: "Already existed", value: fmtInt(result.skipped || 0) },
              { label: "Catalog models", value: fmtInt(result.catalogModels || 0) },
            ]) + note("Every new row is at qty 0 — that means 'not counted yet', not 'none in stock'. Record real counts with stock_bulk_set.", "amber"),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
