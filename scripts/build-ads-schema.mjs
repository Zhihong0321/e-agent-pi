#!/usr/bin/env node
// Regenerates server/google-ads-schema.json from Google's REST discovery document.
//
//   node scripts/build-ads-schema.mjs
//
// The output is the complete transitive closure of every schema reachable from
// the resources an agent can create, with each field's type, enum values and
// Google's own description of each value. Committed to the repo so campaign
// planning needs no network access at all — see google-ads-agent-plan.md, Core 1.
//
// Re-run when the pinned API version changes. Google Ads majors last 12 months.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = process.env.GOOGLE_ADS_API_VERSION || "v25";
const PREFIX = `GoogleAdsGoogleads${VERSION.replace(/^v/, "V")}`;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "google-ads-schema.json");

/** The resources a campaign plan can contain. Everything else is pulled in by reference. */
const ROOTS = {
  CampaignBudget: `${PREFIX}Resources__CampaignBudget`,
  Campaign: `${PREFIX}Resources__Campaign`,
  CampaignCriterion: `${PREFIX}Resources__CampaignCriterion`,
  AdGroup: `${PREFIX}Resources__AdGroup`,
  AdGroupCriterion: `${PREFIX}Resources__AdGroupCriterion`,
  AdGroupAd: `${PREFIX}Resources__AdGroupAd`,
  Ad: `${PREFIX}Resources__Ad`,
  AssetGroup: `${PREFIX}Resources__AssetGroup`,
};

/** Fields Google returns but no one can write. Keeping them would invite invalid plans. */
const OUTPUT_ONLY = new Set(["resourceName", "id"]);

function shortName(ref) {
  return ref.startsWith(PREFIX) ? ref.slice(PREFIX.length).replace(/^(Resources|Common|Enums)_*/, "") : ref;
}

function simplifyField(def) {
  const out = { type: def.type || "object" };
  if (def.description) out.description = def.description;
  if (def.format) out.format = def.format;

  if (Array.isArray(def.enum)) {
    // Drop the two placeholder members: neither is ever a valid thing to send.
    const pairs = def.enum
      .map((value, index) => ({ value, description: def.enumDescriptions?.[index] || "" }))
      .filter((entry) => entry.value !== "UNSPECIFIED" && entry.value !== "UNKNOWN");
    out.type = "enum";
    out.values = pairs;
  }
  if (def.$ref) {
    out.type = "object";
    out.ref = shortName(def.$ref);
  }
  if (def.items) {
    out.type = "array";
    out.items = def.items.$ref ? { ref: shortName(def.items.$ref) } : simplifyField(def.items);
  }
  return out;
}

async function main() {
  const url = `https://googleads.googleapis.com/$discovery/rest?version=${VERSION}`;
  process.stdout.write(`Fetching ${url}\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`discovery fetch failed: HTTP ${res.status}`);
  const doc = await res.json();
  const schemas = doc.schemas || {};

  const missing = Object.entries(ROOTS).filter(([, ref]) => !schemas[ref]);
  if (missing.length) throw new Error(`discovery has no schema for: ${missing.map(([n]) => n).join(", ")}`);

  const seen = new Set();
  const queue = Object.values(ROOTS);
  while (queue.length) {
    const ref = queue.pop();
    if (seen.has(ref) || !schemas[ref]) continue;
    seen.add(ref);
    for (const def of Object.values(schemas[ref].properties || {})) {
      if (def.$ref) queue.push(def.$ref);
      if (def.items?.$ref) queue.push(def.items.$ref);
    }
  }

  const types = {};
  for (const ref of seen) {
    const schema = schemas[ref];
    const fields = {};
    for (const [name, def] of Object.entries(schema.properties || {})) {
      if (OUTPUT_ONLY.has(name)) continue;
      fields[name] = simplifyField(def);
    }
    types[shortName(ref)] = { description: schema.description || "", fields };
  }

  const payload = {
    apiVersion: VERSION,
    generatedAt: new Date().toISOString(),
    roots: Object.fromEntries(Object.entries(ROOTS).map(([name, ref]) => [name, shortName(ref)])),
    types,
  };

  await writeFile(OUT, `${JSON.stringify(payload, null, 1)}\n`, "utf8");

  const enumValues = Object.values(types).reduce(
    (sum, t) => sum + Object.values(t.fields).reduce((n, f) => n + (f.values?.length || 0), 0),
    0,
  );
  process.stdout.write(
    `Wrote ${OUT}\n  types: ${Object.keys(types).length}\n  roots: ${Object.keys(ROOTS).length}\n  enum values: ${enumValues}\n`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
