#!/usr/bin/env node
// Stdio MCP server for the O&M Agent. Spawned per-session by the Pi runtime
// (see server/om-mcp.mjs for catalog registration) — it inherits OM_API_TOKEN
// from that agent's own process env (server/agent-env.mjs), so no secrets
// are duplicated here.
//
// Everything here reads from the EE SAJ Data Fetcher API (server/om-client.mjs)
// or triggers a live resync of one named client's plant — there is no tool
// that touches SAJ portal accounts, fleet-wide sync/backfill, or retention.
//
// Each tool renders a ready-to-paste HTML report (server/report-html.mjs) so
// the agent relays the tool's output rather than designing a reply of its own.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { deviceInfo, deviceLatest, fetchDevice, fetchPlant, health, missingOmConfig, syncFast } from "./om-client.mjs";
import { reportPage, fenceHtml, statGrid, dataTable, section, note, badge, fmtInt } from "./report-html.mjs";

function reply(fragment) {
  return { content: [{ type: "text", text: fenceHtml(fragment) }] };
}

function fail(error) {
  return { content: [{ type: "text", text: `Error: ${error?.message || error}` }], isError: true };
}

/** "2026-09-07T11:20:00+00:00" -> "07 Sep 2026, 19:20 MYT" */
function fmtMyt(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kuala_Lumpur",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return `${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")} MYT`;
}

function fmtKwh(value) {
  return `${(Number(value) || 0).toFixed(2)} kWh`;
}

function fmtW(value) {
  return `${fmtInt(Math.round(Number(value) || 0))} W`;
}

const server = new McpServer({ name: "om-data", version: "1.0.0" });

server.registerTool(
  "om_check_access",
  {
    title: "Check SAJ API access",
    description:
      "Reports whether the O&M API token is configured and the SAJ data service is reachable. Use this first when any other tool fails.",
    inputSchema: {},
  },
  async () => {
    try {
      const missing = missingOmConfig();
      if (missing.length) {
        return reply(
          reportPage({
            title: "O&M API not configured",
            body: note(`Missing: ${missing.join(", ")}. Fill this in Settings before using the other tools.`, "red"),
          }),
        );
      }
      const ok = await health();
      return reply(
        reportPage({
          title: "O&M (SAJ) API access",
          badgeHtml: badge(ok ? "connected" : "unreachable", ok ? "green" : "red"),
          body: note(ok ? "The service is up and the token is set." : "Token is set but the service did not respond healthy.", ok ? "green" : "red"),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "om_plant_status",
  {
    title: "Client plant status (also refreshes live)",
    description:
      "Looks up a client by customer or plant name (or an exact customerId/plantUid to disambiguate), pulls fresh readings straight from the SAJ portal, and reports every device's online/offline state, today's kWh, live power and last-seen time. This is the main 'is this client's system OK' check — it always resyncs first, so numbers are live rather than last night's cache. Pass an exact customerId when a name matches more than one client.",
    inputSchema: {
      customer: z.string().optional().describe("Customer name to look up (fuzzy match)"),
      plant: z.string().optional().describe("Plant name to look up (fuzzy match)"),
      customerId: z.string().optional().describe("Exact customer id — required when a name matches more than one customer"),
      plantUid: z.string().optional().describe("Exact plant uid — picks one plant out of an ambiguous name"),
      days: z.number().int().min(1).max(30).optional().describe("Days back to pull (default 1 — just today)"),
    },
  },
  async ({ customer, plant, customerId, plantUid, days }) => {
    try {
      if (!customer && !plant && !customerId && !plantUid) {
        throw new Error("Give at least one of: customer, plant, customerId, or plantUid.");
      }
      const data = await syncFast({ customer, plant, customerId, plantUid, days });
      const staleBySn = new Map((data.no_data || []).map((d) => [d.device_sn, d]));
      const errorBySn = new Map(
        (data.errors || []).map((e) => [e.device_sn || e.sn, e.error || e.message || JSON.stringify(e)]),
      );

      const plants = data.plants || [];
      const sections = [];
      let totalTodayKwh = 0;
      let totalLiveW = 0;
      let offlineCount = 0;
      let deviceCount = 0;

      for (const p of plants) {
        const devices = p.devices || [];
        const rows = await Promise.all(
          devices.map(async (sn) => {
            deviceCount += 1;
            const stale = staleBySn.get(sn);
            const errorMsg = errorBySn.get(sn);
            let latest = null;
            try {
              latest = (await deviceLatest(sn)).latest;
            } catch {
              // fall through with no latest data below
            }
            const offline = Boolean(stale) || Boolean(errorMsg);
            if (offline) offlineCount += 1;
            else {
              totalTodayKwh += Number(latest?.today_kwh) || 0;
              totalLiveW += Number(latest?.ac_power_w) || 0;
            }
            // dataTable escapes every cell, so this must stay plain text — no badge() markup here.
            const status = errorMsg ? "Error" : offline ? "Offline" : "Online";
            return [
              sn,
              status,
              latest ? fmtKwh(latest.today_kwh) : "—",
              latest ? fmtKwh(latest.total_kwh) : "—",
              offline ? "—" : latest ? fmtW(latest.ac_power_w) : "—",
              errorMsg || fmtMyt(stale?.last_ts || latest?.ts),
            ];
          }),
        );
        sections.push(
          section(
            `${p.plant_name || p.plant_uid} (${p.plant_uid})`,
            dataTable(["Device", "Status", "Today", "Total", "Live power", "Last seen / error"], rows),
          ),
        );
      }

      const ambiguityNote =
        data.target?.matched && customer && data.target.matched.toLowerCase() !== customer.trim().toLowerCase()
          ? note(`Matched "${customer}" to customer "${data.target.matched}".`, "gray")
          : "";

      return reply(
        reportPage({
          title: data.target?.matched || plant || customerId || plantUid || "Client plant status",
          eyebrow: `customer_id: ${data.target?.customer_id || "—"} · ${plants.length} plant(s), ${deviceCount} device(s)`,
          badgeHtml: offlineCount
            ? badge(`${offlineCount} offline`, "amber")
            : badge("all online", "green"),
          body:
            statGrid([
              { label: "Today, this client", value: fmtKwh(totalTodayKwh) },
              { label: "Live power now", value: fmtW(totalLiveW) },
              { label: "Devices online", value: `${deviceCount - offlineCount} / ${deviceCount}` },
            ]) +
            ambiguityNote +
            sections.join("") +
            (data.err
              ? note(`${data.err} device(s) failed to sync this run — see status column above.`, "red")
              : ""),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "om_generation_report",
  {
    title: "Generation history report",
    description:
      "Daily kWh generated over a window (up to 31 days) for one plant or one device, plus the peak power seen and when. Refreshes from SAJ first for any day not already stored. Use for monthly-report or trend questions. Pass exactly one of plantUid or deviceSn.",
    inputSchema: {
      plantUid: z.string().optional().describe("Exact plant uid — report totals all devices in the plant"),
      deviceSn: z.string().optional().describe("Exact device serial — report for just this inverter"),
      days: z.number().int().min(1).max(31).optional().describe("Days back from today (default 7)"),
    },
  },
  async ({ plantUid, deviceSn, days }) => {
    try {
      if (Boolean(plantUid) === Boolean(deviceSn)) {
        throw new Error("Give exactly one of plantUid or deviceSn.");
      }
      const data = plantUid ? await fetchPlant(plantUid, { days }) : await fetchDevice(deviceSn, { days });
      const daily = data.daily || [];
      const series = data.series || [];
      const totalKwh = daily.reduce((sum, d) => sum + (Number(d.kwh) || 0), 0);
      const avgKwh = daily.length ? totalKwh / daily.length : 0;
      const peak = series.reduce(
        (best, s) => (Number(s.ac_power_w) > Number(best?.ac_power_w ?? -1) ? s : best),
        null,
      );

      return reply(
        reportPage({
          title: `Generation report — ${plantUid || deviceSn}`,
          eyebrow: daily.length ? `${daily[0].day} → ${daily[daily.length - 1].day}` : `${data.days} day(s)`,
          body:
            statGrid([
              { label: "Total", value: fmtKwh(totalKwh) },
              { label: "Average / day", value: fmtKwh(avgKwh) },
              { label: "Peak power", value: peak ? fmtW(peak.ac_power_w) : "—" },
              { label: "Peak at", value: peak ? fmtMyt(peak.ts) : "—" },
            ]) +
            section("Daily generation", dataTable(["Date", "kWh"], daily.map((d) => [d.day, fmtKwh(d.kwh)]))) +
            (daily.length === 0 ? note("No stored days in this window yet — try a smaller window or check the device is online.", "gray") : ""),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "om_device_info",
  {
    title: "Inverter model & firmware",
    description:
      "Model, rated power, phase and firmware for one inverter. Useful troubleshooting context alongside om_plant_status when a device is offline or underperforming.",
    inputSchema: { deviceSn: z.string().describe("Exact device serial number") },
  },
  async ({ deviceSn }) => {
    try {
      const info = await deviceInfo(deviceSn);
      return reply(
        reportPage({
          title: info.model || deviceSn,
          eyebrow: `plant_uid: ${info.plant_uid || "—"}`,
          body: dataTable(
            ["Field", "Value"],
            [
              ["Device SN", info.device_sn],
              ["Model", info.model || "—"],
              ["Rated power", info.rated_power_kw != null ? `${info.rated_power_kw} kW` : "—"],
              ["Phase", info.phase_name || "—"],
              ["Firmware", info.firmware || "—"],
            ],
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
