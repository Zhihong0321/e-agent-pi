/** Eternalgy Package Price Center (Google Sheet) — fetch + parse. */

export const PACKAGE_SHEET_ID = "1aBCKeLnlUci2q98WwTIX77UwDqyrFFsK_1tFaSK4INU";
export const PACKAGE_SHEET_TITLE = "ETERNALGY PACKAGE PRICE CENTER";
export const PACKAGE_SHEET_ALIASES = [
  "package google sheet",
  "package sheet",
  "price center",
  "package price center",
  "eternalgy package price center",
];
export const PACKAGE_SHEET_EDIT_URL =
  `https://docs.google.com/spreadsheets/d/${PACKAGE_SHEET_ID}/edit`;

/** gids are stable even if a tab is renamed. Tab order matches the workbook. */
export const PACKAGE_SHEET_TABS = [
  {
    slug: "hybrid-v2",
    name: "HYBIRD PACKAGE v2 1JUN2026 (2)",
    gid: "1152370454",
    family: "hybrid-res",
    live: true,
    dbType: "Residential",
    aliases: ["hybrid", "hybird", "hybird v2", "hybrid v2"],
  },
  {
    slug: "hybrid-res",
    name: "HYBIRD Residential package",
    gid: "851508429",
    family: "hybrid-res",
    live: false,
    supersededBy: "hybrid-v2",
    dbType: "Residential",
    aliases: ["old hybrid", "hybrid residential"],
  },
  {
    slug: "string-res",
    name: "STRING Residential package",
    gid: "694235366",
    family: "string-res",
    live: true,
    dbType: "Residential",
    aliases: ["string", "residential string"],
  },
  {
    slug: "micro-res",
    name: "MICRO Residential PACKAGE",
    gid: "1964999635",
    family: "micro-res",
    live: true,
    dbType: "Residential",
    aliases: ["micro", "residential micro"],
  },
  {
    slug: "string-com",
    name: "String commercial",
    gid: "2110465309",
    family: "string-com",
    live: true,
    dbType: "Tariff B&D Low Voltage",
    aliases: ["commercial", "string commercial", "tariff"],
  },
  {
    slug: "ev",
    name: "EV Charger",
    gid: "1691649272",
    family: "ev",
    live: true,
    dbType: "EV Charger",
    aliases: ["ev charger", "charger"],
  },
];

export function packageSheetCsvUrl(gid) {
  return `https://docs.google.com/spreadsheets/d/${PACKAGE_SHEET_ID}/export?format=csv&gid=${gid}`;
}

export function packageSheetGvizUrl(sheetName) {
  return `https://docs.google.com/spreadsheets/d/${PACKAGE_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
}

export function packageSheetHtmlviewUrl() {
  return `https://docs.google.com/spreadsheets/d/${PACKAGE_SHEET_ID}/htmlview`;
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let i = 0;
  let inQuotes = false;
  const src = String(text || "");
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      row.push(cell);
      cell = "";
      if (row.some((value) => String(value).trim())) rows.push(row);
      row = [];
      i += ch === "\r" && src[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  if (cell.length || row.length) {
    row.push(cell);
    if (row.some((value) => String(value).trim())) rows.push(row);
  }
  return rows;
}

export function parseMoney(value) {
  const raw = String(value || "").replace(/[RM,\s]/gi, "");
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseIntish(value) {
  const raw = String(value || "").replace(/,/g, "").trim();
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeNameKey(value) {
  return String(value || "")
    .trim()
    .replace(/hybird/gi, "HYBRID")
    .replace(/\](?=\S)/g, "] ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function mapSheetTypeToDb(value, fallback) {
  const raw = String(value || "").trim();
  const key = raw.toLowerCase();
  if (!key) return fallback || null;
  if (key === "residential") return "Residential";
  if (key === "commercial" || key.includes("tariff") || key.includes("b&d")) {
    return "Tariff B&D Low Voltage";
  }
  if (key.includes("roadshow") || key.includes("special")) return "Special / Roadshow";
  if (key.includes("ev") || key.includes("charger") || key.includes("installation") || key.includes("extra")) {
    return "EV Charger";
  }
  return fallback || raw;
}

function normHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

const HEADER_ALIASES = {
  panels: ["number of panels", "no panels", "no panel"],
  inverterKw: ["inverter size"],
  inverter: ["inverter model", "inverter qty and model", "ev charger"],
  panel: ["panels type", "panel type"],
  name: ["package name"],
  invoice: ["invoice description"],
  type: ["package type"],
  price: ["package price", "price(rm)", "price"],
  nett: ["nett price after discount"],
  dcCable: ["dc cable"],
  dcQty: ["dc cable qty (m)", "dc cable distance (m)"],
  mount: ["mountting structure", "mounting structure", "mount"],
  acCable: ["ac cable"],
  acQty: ["ac cable qty (m)", "ac cable  distance (m)", "ac cable distance (m)"],
  breaker: ["breaker"],
  pvMeter: ["pv meter"],
  dbBox: ["pvc db box"],
  mc4: ["mc4", "mc4 qty(pair)"],
  spd: ["spd"],
  warranty: ["charger warranty"],
  cable: ["cable"],
  cableM: ["cable distance(m)"],
};

export function indexHeaders(headerRow) {
  /** @type {Record<string, number>} */
  const index = {};
  const headers = (headerRow || []).map(normHeader);
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const at = headers.findIndex((header) => aliases.includes(header));
    if (at >= 0) index[field] = at;
  }
  return index;
}

function cell(row, index, field) {
  const at = index[field];
  if (at == null) return "";
  return String(row[at] ?? "").trim();
}

export function rowToPackage(row, index, tab) {
  const name = cell(row, index, "name");
  if (!name) return null;
  const sheetType = cell(row, index, "type");
  const extras = {};
  const extraFields = [
    "dcCable",
    "dcQty",
    "mount",
    "acCable",
    "acQty",
    "breaker",
    "pvMeter",
    "dbBox",
    "mc4",
    "spd",
    "warranty",
    "cable",
    "cableM",
  ];
  for (const field of extraFields) {
    const value = cell(row, index, field);
    if (value) extras[field] = value;
  }
  return {
    tab: tab?.slug || null,
    live: tab?.live ?? true,
    name,
    nameKey: normalizeNameKey(name),
    type: sheetType || tab?.dbType || "",
    dbType: mapSheetTypeToDb(sheetType, tab?.dbType),
    panels: parseIntish(cell(row, index, "panels")),
    inverterKw: parseIntish(cell(row, index, "inverterKw")),
    inverter: cell(row, index, "inverter") || null,
    panel: cell(row, index, "panel") || null,
    price: parseMoney(cell(row, index, "price")),
    nett: parseMoney(cell(row, index, "nett")),
    extras,
  };
}

export function parseTabCsv(text, tab, { full = false } = {}) {
  const rows = parseCsv(text);
  const header = rows[0] || [];
  const index = indexHeaders(header);
  const packages = [];
  for (const row of rows.slice(1)) {
    const pkg = rowToPackage(row, index, tab);
    if (!pkg) continue;
    if (full) pkg.invoice = cell(row, index, "invoice");
    packages.push(pkg);
  }
  return { header, packages };
}

export function resolveSheetTab(query) {
  const raw = String(query || "").trim();
  if (!raw) return null;
  const key = normalizeNameKey(raw);
  for (const tab of PACKAGE_SHEET_TABS) {
    if (tab.slug === raw || tab.slug === key) return tab;
    if (normalizeNameKey(tab.name) === key) return tab;
    if (tab.gid === raw) return tab;
    if ((tab.aliases || []).some((alias) => normalizeNameKey(alias) === key)) return tab;
  }
  return null;
}

function tabSummary(tab, parsed) {
  const types = {};
  const prices = parsed.packages.map((pkg) => pkg.price).filter((n) => n != null);
  for (const pkg of parsed.packages) {
    const type = pkg.type || "(blank)";
    types[type] = (types[type] || 0) + 1;
  }
  return {
    slug: tab.slug,
    name: tab.name,
    gid: tab.gid,
    live: tab.live,
    family: tab.family,
    supersededBy: tab.supersededBy || null,
    dbType: tab.dbType,
    rows: parsed.packages.length,
    columns: parsed.header.filter(Boolean),
    types,
    priceMin: prices.length ? Math.min(...prices) : null,
    priceMax: prices.length ? Math.max(...prices) : null,
    sample: parsed.packages.slice(0, 3).map((pkg) => pkg.name),
  };
}

async function fetchText(url, timeoutMs = 25000) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  return { ok: response.ok, status: response.status, type: response.headers.get("content-type") || "", text };
}

async function fetchTabCsv(tab) {
  const attempts = [packageSheetCsvUrl(tab.gid)];
  if (tab.name) attempts.push(packageSheetGvizUrl(tab.name));
  let lastError = "fetch failed";
  for (const url of attempts) {
    try {
      const res = await fetchText(url);
      if (res.ok && /csv/i.test(res.type || "") && res.text.includes(",")) {
        return res.text;
      }
      lastError = `HTTP ${res.status} ${res.type}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`Could not export tab ${tab.slug}: ${lastError}`);
}

export async function discoverSheetGids() {
  const res = await fetchText(packageSheetHtmlviewUrl());
  if (!res.ok) return [];
  const seen = new Set();
  const gids = [];
  for (const match of res.text.matchAll(/gid=(\d+)/g)) {
    const gid = match[1];
    if (seen.has(gid)) continue;
    seen.add(gid);
    gids.push(gid);
  }
  return gids;
}

/**
 * @param {{ tab?: string; live?: boolean; full?: boolean; discover?: boolean }} [opts]
 */
export async function pullPackageSheet(opts = {}) {
  const full = Boolean(opts.full);
  let tabs = PACKAGE_SHEET_TABS.slice();
  if (opts.tab) {
    const match = resolveSheetTab(opts.tab);
    if (!match) {
      return { ok: false, error: `Unknown tab: ${opts.tab}` };
    }
    tabs = [match];
  } else if (opts.live) {
    tabs = tabs.filter((tab) => tab.live);
  }

  if (opts.discover !== false && !opts.tab) {
    try {
      const gids = await discoverSheetGids();
      const known = new Set(PACKAGE_SHEET_TABS.map((tab) => tab.gid));
      for (const gid of gids) {
        if (known.has(gid)) continue;
        tabs.push({
          slug: `extra-${gid}`,
          name: `Untitled (${gid})`,
          gid,
          family: "unknown",
          live: true,
          dbType: null,
          aliases: [],
        });
      }
    } catch {
      // known tabs are enough
    }
  }

  const pulledAt = new Date().toISOString();
  const tabResults = await Promise.all(
    tabs.map(async (tab) => {
      const csv = await fetchTabCsv(tab);
      const parsed = parseTabCsv(csv, tab, { full });
      return { tab, csv, parsed };
    }),
  );

  const packages = tabResults.flatMap((row) => row.parsed.packages);
  return {
    ok: true,
    title: PACKAGE_SHEET_TITLE,
    id: PACKAGE_SHEET_ID,
    url: PACKAGE_SHEET_EDIT_URL,
    aliases: PACKAGE_SHEET_ALIASES,
    pulledAt,
    tabs: tabResults.map((row) => tabSummary(row.tab, row.parsed)),
    packages,
    csvBySlug: Object.fromEntries(tabResults.map((row) => [row.tab.slug, row.csv])),
  };
}
