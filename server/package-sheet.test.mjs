import assert from "node:assert/strict";
import { test } from "node:test";
import { agentEnv } from "./agent-env.mjs";
import {
  indexHeaders,
  mapSheetTypeToDb,
  normalizeNameKey,
  parseCsv,
  parseMoney,
  parseTabCsv,
  resolveSheetTab,
  rowToPackage,
} from "./package-sheet.mjs";

const STRING_CSV = `NO PANELS,INVERTER SIZE,INVERTER MODEL,PANELS TYPE,Package Name,Invoice Description,PACKAGE Type,Package Price,Nett Price After Discount
8,4,1X [1P] SAJ R5 4KW String Inverter,650W JinkoSolar,"[1P] STRING SAJ JINKO 8 PCS 650W","8X 650W
1X inverter",Residential,"RM16,830.00","RM13,820.00"
`;

test("parseCsv keeps quoted newlines in invoice cells", () => {
  const rows = parseCsv(STRING_CSV);
  assert.equal(rows.length, 2);
  assert.equal(rows[1][4], "[1P] STRING SAJ JINKO 8 PCS 650W");
  assert.match(rows[1][5], /8X 650W\n1X inverter/);
  assert.equal(parseMoney(rows[1][7]), 16830);
  assert.equal(parseMoney(rows[1][8]), 13820);
});

test("normalizeNameKey fixes HYBIRD spelling and missing space after ]", () => {
  assert.equal(normalizeNameKey("[1P]  HYBIRD SAJ JINKO 11 PCS 590W"), "[1p] hybrid saj jinko 11 pcs 590w");
  assert.equal(normalizeNameKey("[1P]MICRO SAJ JINKO 8 PCS 650W"), "[1p] micro saj jinko 8 pcs 650w");
});

test("mapSheetTypeToDb maps commercial and EV labels onto prod_main types", () => {
  assert.equal(mapSheetTypeToDb("Residential"), "Residential");
  assert.equal(mapSheetTypeToDb("commercial"), "Tariff B&D Low Voltage");
  assert.equal(mapSheetTypeToDb("EV charger only"), "EV Charger");
});

test("resolveSheetTab accepts aliases, gid, and sheet name", () => {
  assert.equal(resolveSheetTab("hybrid")?.slug, "hybrid-v2");
  assert.equal(resolveSheetTab("694235366")?.slug, "string-res");
  assert.equal(resolveSheetTab("String commercial")?.slug, "string-com");
  assert.equal(resolveSheetTab("nope"), null);
});

test("parseTabCsv maps STRING residential columns", () => {
  const tab = resolveSheetTab("string");
  const parsed = parseTabCsv(STRING_CSV, tab);
  assert.equal(parsed.packages.length, 1);
  const pkg = parsed.packages[0];
  assert.equal(pkg.panels, 8);
  assert.equal(pkg.inverterKw, 4);
  assert.equal(pkg.price, 16830);
  assert.equal(pkg.dbType, "Residential");
  assert.equal(pkg.nameKey, "[1p] string saj jinko 8 pcs 650w");
});

test("rowToPackage skips nameless rows", () => {
  const index = indexHeaders(["Package Name", "Package Price"]);
  assert.equal(rowToPackage(["", "RM1"], index, null), null);
});

test("agentEnv grants the sheet CLI only to Package Updater", () => {
  const from = { PATH: "/usr/bin", HOME: "/root", USER: "root" };
  const pkg = agentEnv({ id: "package", slug: "package" }, {}, from);
  const website = agentEnv({ id: "website", slug: "website" }, {}, from);
  assert.match(pkg.CLOUD_PI_PACKAGE_SHEET, /package-sheet-cli\.mjs$/);
  assert.equal(website.CLOUD_PI_PACKAGE_SHEET, undefined);
});
