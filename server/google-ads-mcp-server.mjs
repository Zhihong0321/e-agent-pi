#!/usr/bin/env node
// Stdio MCP server for the Google Ads agent. Spawned per-session by the Pi
// runtime (see server/google-ads-mcp.mjs for catalog registration) — it inherits
// GOOGLE_ADS_* from that agent's own process env (server/agent-env.mjs), so no
// secrets are duplicated here.
//
// Reporting tools are read-only. The write tools can create and edit campaigns
// but can never make one serve: server/google-ads-ops.mjs hardcodes PAUSED and
// refuses any payload carrying ENABLED, server/google-ads-mutate.mjs re-checks
// that on the way out, and anything currently serving is refused outright.
// Pausing is the one status change allowed, because it only reduces spend.
//
// Each tool renders a ready-to-paste HTML report (server/report-html.mjs) so the
// agent relays the tool's output rather than designing a reply of its own.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { gaqlSearch, listAccessibleCustomers, fromMicros, dateClause, rangeLabel, adsConfig, missingConfig } from "./google-ads.mjs";
import { runMutate } from "./google-ads-mutate.mjs";
import {
  LIMITS,
  assertNotServing,
  buildCampaignEdit,
  buildKeywordAdditions,
  buildPause,
  buildSearchCampaignDraft,
  planToOperations,
} from "./google-ads-ops.mjs";
import { API_VERSION, ROOT_RESOURCES, describeResource, validatePlan } from "./google-ads-schema.mjs";
import { renderSearchAdPreview } from "./google-ads-preview.mjs";
import { reportPage, fenceHtml, statGrid, dataTable, section, note, badge, fmtMoney, fmtInt } from "./report-html.mjs";

function reply(fragment) {
  return { content: [{ type: "text", text: fenceHtml(fragment) }] };
}

function fail(error) {
  return { content: [{ type: "text", text: `Error: ${error?.message || error}` }], isError: true };
}

const num = (value) => Number(value || 0);
const cost = (metrics) => fromMicros(metrics?.costMicros);

/** Cost per conversion, or null when nothing converted — never a divide-by-zero NaN. */
function cpa(costValue, conversions) {
  return conversions > 0 ? costValue / conversions : null;
}

function totals(rows) {
  return rows.reduce(
    (acc, row) => {
      acc.impressions += num(row.metrics?.impressions);
      acc.clicks += num(row.metrics?.clicks);
      acc.cost += cost(row.metrics);
      acc.conversions += num(row.metrics?.conversions);
      return acc;
    },
    { impressions: 0, clicks: 0, cost: 0, conversions: 0 },
  );
}

function totalsGrid(t) {
  return statGrid([
    { label: "Cost", value: fmtMoney(t.cost), tone: t.cost > 0 ? "amber" : "gray" },
    { label: "Impressions", value: fmtInt(t.impressions) },
    { label: "Clicks", value: fmtInt(t.clicks) },
    { label: "Conversions", value: fmtInt(t.conversions), tone: t.conversions > 0 ? "green" : "gray" },
  ]);
}

/**
 * An account that spent nothing tells you nothing, and a report full of zeros
 * reads like a broken tool. Say which it is instead.
 */
function quietNote(t, statuses) {
  if (t.cost > 0 || t.impressions > 0) return "";
  const enabled = statuses.filter((s) => s === "ENABLED").length;
  if (!statuses.length) return note("This account has no campaigns yet.", "gray");
  if (!enabled) return note("Nothing served in this window — every campaign is paused or removed.", "amber");
  return note(
    `Nothing served in this window despite ${enabled} enabled campaign${enabled === 1 ? "" : "s"}. Usually that means no budget, missing assets, or the campaign is still in review.`,
    "amber",
  );
}

const dateArgs = {
  days: z.number().int().min(1).max(365).optional().describe("Window size in days, ending today (default 30)"),
  from: z.string().optional().describe("ISO date YYYY-MM-DD; use with 'to' for an explicit range"),
  to: z.string().optional().describe("ISO date YYYY-MM-DD; use with 'from'"),
};

const server = new McpServer({ name: "google-ads", version: "1.0.0" });

server.registerTool(
  "ads_check_access",
  {
    title: "Check Google Ads API access",
    description:
      "Reports which credentials are configured and which accounts the API can actually reach. Use this first when any other tool fails, or when the operator asks whether the integration is set up.",
    inputSchema: {},
  },
  async () => {
    try {
      const cfg = adsConfig();
      const missing = missingConfig();
      if (missing.length) {
        return reply(
          reportPage({
            title: "Google Ads not configured",
            body: note(`Missing: ${missing.join(", ")}. Fill these in Settings before using the other tools.`, "red"),
          }),
        );
      }
      const accounts = await listAccessibleCustomers();
      return reply(
        reportPage({
          title: "Google Ads access",
          eyebrow: "Credentials and reachable accounts",
          badgeHtml: badge("connected", "green"),
          body:
            statGrid([
              { label: "Target account", value: cfg.customerId },
              { label: "Routed via manager", value: cfg.loginCustomerId || "not set" },
              { label: "Reachable accounts", value: fmtInt(accounts.length) },
            ]) +
            dataTable(["Accessible customer IDs"], accounts.map((id) => [id])) +
            (cfg.loginCustomerId
              ? ""
              : note(
                  "login-customer-id is not set. If calls fail with USER_PERMISSION_DENIED, that is why — the request has to be routed through the manager account.",
                  "amber",
                )),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "ads_account_overview",
  {
    title: "Account overview",
    description:
      "Account details plus spend, impressions, clicks and conversions across all campaigns for a window. Use for 'how is the account doing' or 'what is running'.",
    inputSchema: dateArgs,
  },
  async (args) => {
    try {
      const where = dateClause(args);
      const [account] = await gaqlSearch(
        "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.status FROM customer LIMIT 1",
      );
      const rows = await gaqlSearch(
        `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
                campaign_budget.amount_micros, metrics.impressions, metrics.clicks,
                metrics.cost_micros, metrics.conversions
         FROM campaign WHERE ${where}`,
      );
      const t = totals(rows);
      const statuses = rows.map((r) => r.campaign?.status);

      return reply(
        reportPage({
          title: account?.customer?.descriptiveName || "Google Ads account",
          eyebrow: `${rangeLabel(args)} · ${account?.customer?.currencyCode || ""} · ${account?.customer?.timeZone || ""}`.trim(),
          badgeHtml: badge(String(account?.customer?.status || "unknown").toLowerCase(), account?.customer?.status === "ENABLED" ? "green" : "amber"),
          body:
            totalsGrid(t) +
            quietNote(t, statuses) +
            section(
              "Campaigns",
              rows.length
                ? dataTable(
                    ["Campaign", "Type", "Status", "Daily budget", "Cost", "Clicks", "Conv."],
                    rows.map((r) => [
                      r.campaign?.name,
                      String(r.campaign?.advertisingChannelType || "").replace(/_/g, " ").toLowerCase(),
                      String(r.campaign?.status || "").toLowerCase(),
                      fmtMoney(fromMicros(r.campaignBudget?.amountMicros)),
                      fmtMoney(cost(r.metrics)),
                      fmtInt(num(r.metrics?.clicks)),
                      fmtInt(num(r.metrics?.conversions)),
                    ]),
                  )
                : "<p style=\"margin:0\">No campaigns exist in this account yet.</p>",
            ),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "ads_performance",
  {
    title: "Campaign performance",
    description:
      "Per-campaign cost, clicks, conversions, CTR and cost-per-conversion for a window, worst cost-per-conversion first. Use for 'which campaigns are working'.",
    inputSchema: dateArgs,
  },
  async (args) => {
    try {
      const rows = await gaqlSearch(
        `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
                metrics.impressions, metrics.clicks, metrics.ctr, metrics.cost_micros,
                metrics.conversions, metrics.average_cpc
         FROM campaign WHERE ${dateClause(args)} AND metrics.impressions > 0`,
      );
      if (!rows.length) {
        return reply(
          reportPage({
            title: "Campaign performance",
            eyebrow: rangeLabel(args),
            body: note("No campaign served an impression in this window, so there is nothing to compare.", "gray"),
          }),
        );
      }
      const t = totals(rows);
      const ranked = rows
        .map((r) => {
          const c = cost(r.metrics);
          const conversions = num(r.metrics?.conversions);
          return { row: r, c, conversions, cpa: cpa(c, conversions) };
        })
        // Campaigns that spent without converting are the ones worth seeing first.
        .sort((a, b) => (b.cpa ?? Infinity) - (a.cpa ?? Infinity) || b.c - a.c);

      return reply(
        reportPage({
          title: "Campaign performance",
          eyebrow: rangeLabel(args),
          body:
            totalsGrid(t) +
            dataTable(
              ["Campaign", "Cost", "Impr.", "Clicks", "CTR", "Conv.", "Cost / conv."],
              ranked.map(({ row, c, conversions, cpa: value }) => [
                row.campaign?.name,
                fmtMoney(c),
                fmtInt(num(row.metrics?.impressions)),
                fmtInt(num(row.metrics?.clicks)),
                `${(num(row.metrics?.ctr) * 100).toFixed(2)}%`,
                fmtInt(conversions),
                value == null ? (c > 0 ? "no conversions" : "—") : fmtMoney(value),
              ]),
            ),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "ads_search_terms",
  {
    title: "Search terms",
    description:
      "What people actually typed before seeing an ad, by cost. Use for 'what are we showing up for' or to find negative keyword candidates.",
    inputSchema: { ...dateArgs, limit: z.number().int().min(1).max(200).optional().describe("Rows to return (default 50)") },
  },
  async (args) => {
    try {
      const limit = args.limit || 50;
      const rows = await gaqlSearch(
        `SELECT search_term_view.search_term, campaign.name, metrics.impressions, metrics.clicks,
                metrics.cost_micros, metrics.conversions
         FROM search_term_view WHERE ${dateClause(args)}
         ORDER BY metrics.cost_micros DESC LIMIT ${limit}`,
      );
      if (!rows.length) {
        return reply(
          reportPage({
            title: "Search terms",
            eyebrow: rangeLabel(args),
            body: note(
              "No search terms in this window. Performance Max and Display campaigns do not report search terms here — only Search and Shopping do.",
              "gray",
            ),
          }),
        );
      }
      return reply(
        reportPage({
          title: "Search terms",
          eyebrow: `${rangeLabel(args)} · top ${rows.length} by cost`,
          body: dataTable(
            ["Search term", "Campaign", "Cost", "Clicks", "Conv."],
            rows.map((r) => [
              r.searchTermView?.searchTerm,
              r.campaign?.name,
              fmtMoney(cost(r.metrics)),
              fmtInt(num(r.metrics?.clicks)),
              fmtInt(num(r.metrics?.conversions)),
            ]),
          ),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "ads_wasted_spend",
  {
    title: "Wasted spend",
    description:
      "Keywords and search terms that cost money and produced no conversions in the window, most expensive first. Use for 'where are we wasting budget'.",
    inputSchema: dateArgs,
  },
  async (args) => {
    try {
      const where = dateClause(args);
      const [keywords, terms] = await Promise.all([
        gaqlSearch(
          `SELECT ad_group_criterion.keyword.text, campaign.name, metrics.cost_micros, metrics.clicks, metrics.conversions
           FROM keyword_view WHERE ${where} AND metrics.conversions = 0 AND metrics.cost_micros > 0
           ORDER BY metrics.cost_micros DESC LIMIT 50`,
        ),
        gaqlSearch(
          `SELECT search_term_view.search_term, campaign.name, metrics.cost_micros, metrics.clicks, metrics.conversions
           FROM search_term_view WHERE ${where} AND metrics.conversions = 0 AND metrics.cost_micros > 0
           ORDER BY metrics.cost_micros DESC LIMIT 50`,
        ),
      ]);

      const wasted = [...keywords, ...terms].reduce((sum, r) => sum + cost(r.metrics), 0);
      if (!keywords.length && !terms.length) {
        return reply(
          reportPage({
            title: "Wasted spend",
            eyebrow: rangeLabel(args),
            body: note(
              "Nothing spent without converting in this window. Note that Performance Max campaigns report neither keywords nor search terms here, so an account running only Performance Max will always look clean.",
              "gray",
            ),
          }),
        );
      }
      return reply(
        reportPage({
          title: "Wasted spend",
          eyebrow: rangeLabel(args),
          body:
            statGrid([
              { label: "Spent with no conversions", value: fmtMoney(wasted), tone: "red" },
              { label: "Keywords", value: fmtInt(keywords.length) },
              { label: "Search terms", value: fmtInt(terms.length) },
            ]) +
            (keywords.length
              ? section(
                  "Keywords",
                  dataTable(
                    ["Keyword", "Campaign", "Cost", "Clicks"],
                    keywords.map((r) => [
                      r.adGroupCriterion?.keyword?.text,
                      r.campaign?.name,
                      fmtMoney(cost(r.metrics)),
                      fmtInt(num(r.metrics?.clicks)),
                    ]),
                  ),
                )
              : "") +
            (terms.length
              ? section(
                  "Search terms",
                  dataTable(
                    ["Search term", "Campaign", "Cost", "Clicks"],
                    terms.map((r) => [
                      r.searchTermView?.searchTerm,
                      r.campaign?.name,
                      fmtMoney(cost(r.metrics)),
                      fmtInt(num(r.metrics?.clicks)),
                    ]),
                  ),
                )
              : "") +
            note("Read-only: this agent cannot add negatives or pause anything yet. Report the candidates and let the operator act.", "gray"),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Writes. Everything below can only ever produce PAUSED entities: the builders
// hardcode the status, server/google-ads-mutate.mjs re-validates, and anything
// currently serving is refused outright. No tool here can make an ad run.
// ---------------------------------------------------------------------------

/** Matches on id or exact name in JS rather than interpolating into GAQL, which has no escaping. */
async function findCampaign(ref) {
  const rows = await gaqlSearch(
    `SELECT campaign.id, campaign.name, campaign.status, campaign.resource_name,
            campaign_budget.resource_name, campaign_budget.amount_micros
     FROM campaign`,
  );
  const needle = String(ref ?? "").trim().toLowerCase();
  const match = rows.find(
    (r) => String(r.campaign?.id) === needle || String(r.campaign?.name || "").toLowerCase() === needle,
  );
  if (!match) {
    const known = rows.map((r) => r.campaign?.name).filter(Boolean).join(", ") || "none";
    throw new Error(`No campaign matches "${ref}". Campaigns in this account: ${known}.`);
  }
  return match;
}

async function findAdGroup(ref) {
  const rows = await gaqlSearch(
    `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.resource_name,
            campaign.name, campaign.status
     FROM ad_group`,
  );
  const needle = String(ref ?? "").trim().toLowerCase();
  const match = rows.find(
    (r) => String(r.adGroup?.id) === needle || String(r.adGroup?.name || "").toLowerCase() === needle,
  );
  if (!match) {
    const known = rows.map((r) => r.adGroup?.name).filter(Boolean).join(", ") || "none";
    throw new Error(`No ad group matches "${ref}". Ad groups in this account: ${known}.`);
  }
  return match;
}

function draftSummary(summary) {
  return (
    statGrid([
      { label: "Daily budget", value: fmtMoney(summary.dailyBudget) },
      { label: "Max CPC bid", value: fmtMoney(summary.cpcBid) },
      { label: "Keywords", value: fmtInt(summary.keywords.length) },
      { label: "Status on creation", value: "PAUSED", tone: "green" },
    ]) +
    section(
      "Campaign",
      dataTable(
        ["Field", "Value"],
        [
          ["Campaign", summary.campaign],
          ["Ad group", summary.adGroup],
          ["Match type", summary.matchType],
          ["Final URL", summary.finalUrl],
        ],
      ),
    ) +
    section("Keywords", dataTable(["Keyword"], summary.keywords.map((k) => [k]))) +
    section("Headlines", dataTable(["#", "Headline", "Chars"], summary.headlines.map((h, i) => [i + 1, h, h.length]))) +
    section(
      "Descriptions",
      dataTable(["#", "Description", "Chars"], summary.descriptions.map((d, i) => [i + 1, d, d.length])),
    )
  );
}

const campaignFields = {
  name: z.string().describe("Campaign name"),
  dailyBudget: z.number().describe(`Daily budget in account currency (max ${LIMITS.maxDailyBudget})`),
  adGroupName: z.string().optional().describe("Ad group name; defaults to the campaign name plus 'ad group'"),
  cpcBid: z.number().optional().describe("Max cost-per-click bid (default 1)"),
  keywords: z.array(z.string()).describe(`Keywords, max ${LIMITS.maxKeywords}`),
  matchType: z.enum(["EXACT", "PHRASE", "BROAD"]).optional().describe("Keyword match type (default PHRASE)"),
  headlines: z
    .array(z.string())
    .describe(`${LIMITS.headline.min}-${LIMITS.headline.max} headlines, max ${LIMITS.headline.chars} chars each`),
  descriptions: z
    .array(z.string())
    .describe(`${LIMITS.description.min}-${LIMITS.description.max} descriptions, max ${LIMITS.description.chars} chars each`),
  finalUrl: z.string().describe("Landing page URL, including https://"),
  path1: z.string().optional().describe(`Display path 1, max ${LIMITS.pathChars} chars`),
  path2: z.string().optional().describe("Display path 2; requires path1"),
};

server.registerTool(
  "ads_draft_campaign",
  {
    title: "Draft a campaign (no changes made)",
    description:
      "Builds a complete Search campaign — budget, campaign, ad group, keywords and a responsive search ad — validates it against Google, and shows what would be created. Writes nothing. Always run this before ads_create_campaign.",
    inputSchema: campaignFields,
  },
  async (args) => {
    try {
      const { operations, summary } = buildSearchCampaignDraft({ ...args, customerId: adsConfig().customerId });
      const result = await runMutate(operations, { dryRun: true, intent: "draft_campaign" });
      return reply(
        reportPage({
          title: `Draft: ${summary.campaign}`,
          eyebrow: "Validated by Google — nothing has been created",
          badgeHtml: badge("dry run", "gray"),
          body:
            draftSummary(summary) +
            note(
              `Google accepted all ${result.operations} operations. Run ads_create_campaign with the same arguments to create this, paused.`,
              "green",
            ),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "ads_create_campaign",
  {
    title: "Create a campaign (paused)",
    description:
      "Creates the campaign, ad group, keywords and ad for real. Everything is created PAUSED and cannot serve or spend until the operator enables it by hand in the Google Ads UI. Draft it first and get the operator's go-ahead.",
    inputSchema: {
      ...campaignFields,
      confirm: z.boolean().describe("Must be true, and only after the operator has approved the draft."),
    },
  },
  async ({ confirm, ...args }) => {
    try {
      if (confirm !== true) {
        throw new Error("Refused: confirm must be true, and only after the operator has seen the draft and approved it.");
      }
      const { operations, summary } = buildSearchCampaignDraft({ ...args, customerId: adsConfig().customerId });
      const result = await runMutate(operations, { dryRun: false, intent: "create_campaign" });
      const created = result.results.map((r) => Object.values(r)[0]?.resourceName).filter(Boolean);
      return reply(
        reportPage({
          title: `Created: ${summary.campaign}`,
          eyebrow: "Paused — it cannot serve until you enable it",
          badgeHtml: badge("paused", "amber"),
          body:
            draftSummary(summary) +
            section("Created resources", dataTable(["Resource name"], created.map((name) => [name]))) +
            note(
              "Nothing is serving. To go live, enable the campaign in the Google Ads UI yourself — this agent has no tool that can do it.",
              "amber",
            ),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "ads_edit_campaign",
  {
    title: "Edit a paused campaign",
    description:
      "Renames a campaign and/or changes its daily budget. Only works on campaigns that are already paused — a serving campaign is refused, because changing it would change live spending. Cannot change status.",
    inputSchema: {
      campaign: z.string().describe("Campaign name or numeric ID"),
      name: z.string().optional().describe("New campaign name"),
      dailyBudget: z.number().optional().describe(`New daily budget (max ${LIMITS.maxDailyBudget})`),
    },
  },
  async ({ campaign, name, dailyBudget }) => {
    try {
      const found = await findCampaign(campaign);
      assertNotServing(found.campaign?.status, `campaign "${found.campaign?.name}"`);
      const { operations, summary } = buildCampaignEdit({
        campaignResourceName: found.campaign?.resourceName,
        budgetResourceName: found.campaignBudget?.resourceName,
        name,
        dailyBudget,
      });
      await runMutate(operations, { dryRun: false, intent: "edit_campaign" });
      return reply(
        reportPage({
          title: `Updated: ${found.campaign?.name}`,
          eyebrow: "Still paused",
          badgeHtml: badge("paused", "amber"),
          body: dataTable(
            ["Field", "New value"],
            [
              ...(summary.name ? [["Name", summary.name]] : []),
              ...(summary.dailyBudget != null ? [["Daily budget", fmtMoney(summary.dailyBudget)]] : []),
            ],
          ),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "ads_add_keywords",
  {
    title: "Add keywords to a paused ad group",
    description:
      "Adds paused keywords to an existing ad group. Refused if the ad group or its campaign is currently serving.",
    inputSchema: {
      adGroup: z.string().describe("Ad group name or numeric ID"),
      keywords: z.array(z.string()).describe(`Keywords to add, max ${LIMITS.maxKeywords}`),
      matchType: z.enum(["EXACT", "PHRASE", "BROAD"]).optional().describe("Default PHRASE"),
    },
  },
  async ({ adGroup, keywords, matchType }) => {
    try {
      const found = await findAdGroup(adGroup);
      assertNotServing(found.adGroup?.status, `ad group "${found.adGroup?.name}"`);
      assertNotServing(found.campaign?.status, `campaign "${found.campaign?.name}"`);
      const { operations, summary } = buildKeywordAdditions({
        adGroupResourceName: found.adGroup?.resourceName,
        keywords,
        matchType,
      });
      await runMutate(operations, { dryRun: false, intent: "add_keywords" });
      return reply(
        reportPage({
          title: `Keywords added to ${found.adGroup?.name}`,
          eyebrow: `${summary.matchType} match — all paused`,
          badgeHtml: badge("paused", "amber"),
          body: dataTable(["Keyword"], summary.keywords.map((k) => [k])),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "ads_pause_campaign",
  {
    title: "Pause a campaign",
    description:
      "Pauses a campaign so it stops serving. Always permitted — pausing can only reduce spend. There is no matching tool to unpause; that is deliberate.",
    inputSchema: { campaign: z.string().describe("Campaign name or numeric ID") },
  },
  async ({ campaign }) => {
    try {
      const found = await findCampaign(campaign);
      const { operations } = buildPause({ campaignResourceName: found.campaign?.resourceName });
      await runMutate(operations, { dryRun: false, intent: "pause_campaign" });
      return reply(
        reportPage({
          title: `Paused: ${found.campaign?.name}`,
          eyebrow: `Was ${String(found.campaign?.status || "").toLowerCase()}`,
          badgeHtml: badge("paused", "amber"),
          body: note("This campaign has stopped serving. Only you can start it again, in the Google Ads UI.", "gray"),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Core 1: design offline. These three tools let the agent discover every field
// and every option, compose a whole campaign, and check it — without a single
// network call. Only ads_plan_submit touches Google.
// ---------------------------------------------------------------------------

function renderFields(fields) {
  const rows = Object.entries(fields).map(([name, def]) => {
    let type = def.type;
    if (def.type === "object" && def.ref) type = `object (${def.ref})`;
    if (def.type === "array") type = `array of ${def.items?.ref || def.items?.type || "value"}`;
    if (def.type === "enum") type = "enum";
    return [name, type, def.description ? def.description.split(". ")[0] : ""];
  });
  return dataTable(["Field", "Type", "What it is"], rows);
}

function renderEnums(fields) {
  const enums = Object.entries(fields).filter(([, def]) => def.type === "enum");
  if (!enums.length) return "";
  return enums
    .map(([name, def]) =>
      section(
        `${name} — allowed values`,
        dataTable(["Value", "Meaning"], def.values.map((v) => [v.value, v.description])),
      ),
    )
    .join("");
}

server.registerTool(
  "ads_schema",
  {
    title: "Look up Google Ads fields and options (offline)",
    description:
      "Every writable field of a Google Ads resource, with its type, and for enums every permitted value with Google's own description. Reads a committed copy of Google's schema — no API call, no account access. Use this while designing a campaign, before writing any plan. Call with a field name to drill into a nested object.",
    inputSchema: {
      resource: z.string().describe(`One of: ${ROOT_RESOURCES.join(", ")}`),
      field: z.string().optional().describe("Drill into this field's nested type, e.g. networkSettings"),
      enumsOnly: z.boolean().optional().describe("Show only the enum fields and their allowed values"),
    },
  },
  async ({ resource, field, enumsOnly }) => {
    try {
      const info = describeResource(resource, { field });
      if (!info.fields) {
        return reply(
          reportPage({
            title: `${info.resource}.${info.field}`,
            eyebrow: `Google Ads ${API_VERSION} — offline schema`,
            body:
              dataTable(["Property", "Value"], [
                ["Type", info.definition.type],
                ["Description", info.definition.description || "—"],
              ]) +
              (info.definition.values
                ? section(
                    "Allowed values",
                    dataTable(["Value", "Meaning"], info.definition.values.map((v) => [v.value, v.description])),
                  )
                : ""),
          }),
        );
      }
      const count = Object.keys(info.fields).length;
      return reply(
        reportPage({
          title: info.resource,
          eyebrow: `Google Ads ${API_VERSION} — offline schema, ${count} fields`,
          body:
            (info.required.length
              ? note(`Required on create: ${info.required.join(", ")}.`, "amber")
              : "") +
            (info.description ? note(info.description, "gray") : "") +
            (enumsOnly ? "" : renderFields(info.fields)) +
            renderEnums(info.fields),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

const planArg = z
  .object({ entities: z.array(z.object({ ref: z.string(), resource: z.string(), fields: z.record(z.any()) })) })
  .describe(
    "A campaign plan: entities with a unique ref, a resource name, and its fields. Point one entity at another with \"@ref\" wherever a resource name goes, e.g. campaignBudget: \"@budget\".",
  );

server.registerTool(
  "ads_plan_validate",
  {
    title: "Check a campaign plan (offline)",
    description:
      "Validates a whole campaign plan against Google's schema without contacting Google: real field names, legal enum values, resolvable @refs, and the required fields whose absence Google reports only as an opaque error. Reports every problem at once. Run this until it passes, then submit.",
    inputSchema: { plan: planArg },
  },
  async ({ plan }) => {
    try {
      const result = validatePlan(plan);
      const order = result.ok ? planToOperations(plan, { customerId: adsConfig().customerId || "0000000000" }) : null;
      return reply(
        reportPage({
          title: result.ok ? "Plan is valid" : "Plan has problems",
          eyebrow: `${result.entities} entities · checked offline against Google Ads ${API_VERSION}`,
          badgeHtml: badge(result.ok ? "valid" : `${result.errors.length} problems`, result.ok ? "green" : "red"),
          body: result.ok
            ? section(
                "Creation order",
                dataTable(
                  ["#", "Ref", "Resource"],
                  order.summary.entities.map((e, i) => [i + 1, `@${e.ref}`, e.resource]),
                ),
              ) + note("Nothing has been sent to Google. Show this to the operator, then use ads_plan_submit.", "green")
            : dataTable(["Problem"], result.errors.map((e) => [e])),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "ads_plan_submit",
  {
    title: "Submit a campaign plan (creates everything, paused)",
    description:
      "Sends a validated plan to Google as one atomic batch. Every entity is created PAUSED — a plan that asks for any other status is refused — so nothing can serve or spend until the operator enables it by hand. Validate first and get an explicit go-ahead.",
    inputSchema: {
      plan: planArg,
      confirm: z.boolean().describe("Must be true, and only after the operator has approved the validated plan."),
    },
  },
  async ({ plan, confirm }) => {
    try {
      if (confirm !== true) {
        throw new Error("Refused: confirm must be true, and only after the operator has seen the validated plan and approved it.");
      }
      const check = validatePlan(plan);
      if (!check.ok) {
        throw new Error(`The plan does not validate:\n- ${check.errors.join("\n- ")}`);
      }
      const { operations, summary } = planToOperations(plan, { customerId: adsConfig().customerId });
      const result = await runMutate(operations, { dryRun: false, intent: "submit_plan" });
      const created = result.results.map((r) => Object.values(r)[0]?.resourceName).filter(Boolean);
      return reply(
        reportPage({
          title: "Plan submitted",
          eyebrow: `${summary.operations} operations — all created paused`,
          badgeHtml: badge("paused", "amber"),
          body:
            dataTable(
              ["Ref", "Resource"],
              summary.entities.map((e) => [`@${e.ref}`, e.resource]),
            ) +
            section("Created resources", dataTable(["Resource name"], created.map((name) => [name]))) +
            note(
              "Nothing is serving. To go live, enable the campaign in the Google Ads UI yourself — this agent has no tool that can do it.",
              "amber",
            ),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "ads_preview_ad",
  {
    title: "Preview how a search ad will look",
    description:
      "Renders a responsive search ad as it appears on Google Search, showing several of the headline combinations Google can assemble. Pass an ad group to preview the real ad in the account, or pass headlines/descriptions to preview copy before creating anything. A faithful mockup built from the ad's fields, not a screenshot from Google.",
    inputSchema: {
      adGroup: z.string().optional().describe("Ad group name or ID — previews the live ad in the account"),
      headlines: z.array(z.string()).optional().describe("Preview draft copy instead of a live ad"),
      descriptions: z.array(z.string()).optional().describe("Preview draft copy instead of a live ad"),
      finalUrl: z.string().optional().describe("Landing page URL, for the display URL"),
      path1: z.string().optional(),
      path2: z.string().optional(),
    },
  },
  async ({ adGroup, headlines, descriptions, finalUrl, path1, path2 }) => {
    try {
      let ad = { headlines, descriptions, finalUrl, path1, path2 };
      let eyebrow = "Draft copy — not yet in the account";
      let reviewNote = "";

      if (!headlines?.length) {
        const rows = await gaqlSearch(
          `SELECT ad_group.name, ad_group_ad.status, ad_group_ad.ad.final_urls,
                  ad_group_ad.ad.responsive_search_ad.headlines,
                  ad_group_ad.ad.responsive_search_ad.descriptions,
                  ad_group_ad.ad.responsive_search_ad.path1,
                  ad_group_ad.ad.responsive_search_ad.path2
           FROM ad_group_ad WHERE ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'`,
        );
        const needle = String(adGroup ?? "").trim().toLowerCase();
        const match = needle
          ? rows.find((r) => String(r.adGroup?.name || "").toLowerCase() === needle)
          : rows[0];
        if (!match) {
          const known = rows.map((r) => r.adGroup?.name).filter(Boolean).join(", ") || "none";
          throw new Error(`No responsive search ad found for "${adGroup}". Ad groups with one: ${known}.`);
        }
        const rsa = match.adGroupAd.ad.responsiveSearchAd;
        ad = {
          headlines: rsa.headlines,
          descriptions: rsa.descriptions,
          finalUrl: match.adGroupAd.ad.finalUrls?.[0],
          path1: rsa.path1,
          path2: rsa.path2,
        };
        eyebrow = `${match.adGroup.name} — live ad, status ${String(match.adGroupAd.status).toLowerCase()}`;

        const pending = (rsa.headlines || []).filter((h) => h.policySummaryInfo?.reviewStatus === "REVIEW_IN_PROGRESS").length;
        if (pending) {
          reviewNote = note(
            `${pending} of ${rsa.headlines.length} headlines are still under Google review. Assets that fail review will not be shown.`,
            "amber",
          );
        }
      }

      const preview = renderSearchAdPreview(ad);

      return reply(
        reportPage({
          title: "Ad preview",
          eyebrow,
          body:
            reviewNote +
            note(
              `A responsive search ad is not one fixed ad. Google assembles up to 3 of your ${preview.headlines.length} headlines and 2 of your ${preview.descriptions.length} descriptions per auction, so a searcher sees one of many combinations. ${preview.combinations} are shown below.`,
              "gray",
            ) +
            section("On desktop", preview.desktop) +
            section("On mobile", preview.mobile) +
            section(
              "Assets",
              dataTable(
                ["#", "Headline", "Chars"],
                preview.headlines.map((h, i) => [i + 1, h, `${h.length}/30`]),
              ) +
                dataTable(
                  ["#", "Description", "Chars"],
                  preview.descriptions.map((d, i) => [i + 1, d, `${d.length}/90`]),
                ),
            ),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
