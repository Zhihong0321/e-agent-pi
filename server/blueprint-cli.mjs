#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { closeDb, connectDb } from "./db.mjs";
import {
  ensureBlueprintSchema,
  getBlueprint,
  listBlueprintVersions,
  listBlueprints,
  setBlueprintStatus,
  submitBlueprint,
} from "./blueprints.mjs";

const USAGE = `Blueprint CLI — the Prototyper's deliverable. Prints JSON.

  node $CLOUD_PI_BLUEPRINT submit --file blueprint.json
  node $CLOUD_PI_BLUEPRINT list [--status draft|approved|shelved]
  node $CLOUD_PI_BLUEPRINT show <slug> [--version N]
  node $CLOUD_PI_BLUEPRINT versions <slug>
  node $CLOUD_PI_BLUEPRINT status <slug> <draft|approved|shelved> [--by NAME]

blueprint.json:
{
  "slug": "agent-os-stock-count",
  "title": "Warehouse stock count screen",
  "department": "Warehouse",
  "requester": "Ah Meng",
  "originalIntent": "their words, verbatim — not your paraphrase",
  "discussionSummary": "what was asked, what changed, what they rejected",
  "prototypeUrl": "https://ee-html.up.railway.app/...",
  "spec": {
    "screens": [], "data_model": [], "rules": [],
    "roles": [], "assumptions": [], "gaps": [], "overlaps": []
  }
}
`;

function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    i += 1;
    out[key] = next;
  }
  return out;
}

function flag(opts, key) {
  const value = opts[key];
  if (value === true || value === false || value === undefined) return "";
  return String(value);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  const [command, ...rest] = opts._;
  if (!command || command === "help") {
    process.stdout.write(USAGE);
    return;
  }

  await connectDb();
  await ensureBlueprintSchema();

  if (command === "submit") {
    const file = flag(opts, "file");
    if (!file) throw new Error("submit needs --file blueprint.json");
    const payload = JSON.parse(await readFile(file, "utf8"));
    print(await submitBlueprint(payload));
    return;
  }

  if (command === "list") {
    print(await listBlueprints({ status: flag(opts, "status") || null }));
    return;
  }

  if (command === "show") {
    const slug = rest[0];
    if (!slug) throw new Error("show needs a slug");
    const version = flag(opts, "version");
    const row = await getBlueprint(slug, version || null);
    if (!row) throw new Error(`Blueprint not found: ${slug}`);
    print(row);
    return;
  }

  if (command === "versions") {
    const slug = rest[0];
    if (!slug) throw new Error("versions needs a slug");
    print(await listBlueprintVersions(slug));
    return;
  }

  if (command === "status") {
    const [slug, status] = rest;
    if (!slug || !status) throw new Error("status needs <slug> <draft|approved|shelved>");
    print(await setBlueprintStatus(slug, status, { approvedBy: flag(opts, "by") || null }));
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
}

main()
  .then(() => closeDb())
  .catch(async (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    await closeDb().catch(() => {});
    process.exit(1);
  });
