#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pullPackageSheet } from "./package-sheet.mjs";

const USAGE = `Package Price Center sheet CLI. Prints JSON.

  node $CLOUD_PI_PACKAGE_SHEET pull [--tab slug] [--live] [--full] [--packages] [--write DIR]

  --tab       one tab (hybrid / string / micro / commercial / ev, or a gid / sheet name)
  --live      skip the superseded HYBIRD Residential tab
  --full      include invoice_desc text
  --packages  include the package rows in stdout (default is tab summaries only)
  --write     save csv + packages.json under DIR (e.g. _inbox/package-sheet)

Never open the Google Sheets editor. This CSV export is the extract path.
`;

function parseArgv(argv) {
  /** @type {Record<string, string | boolean> & { _: string[] }} */
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

async function writePull(result, dir) {
  await mkdir(dir, { recursive: true });
  const written = [];
  for (const [slug, csv] of Object.entries(result.csvBySlug || {})) {
    const file = path.join(dir, `${slug}.csv`);
    await writeFile(file, csv, "utf8");
    written.push(file);
  }
  const jsonPath = path.join(dir, "packages.json");
  const rest = { ...result };
  delete rest.csvBySlug;
  await writeFile(jsonPath, `${JSON.stringify(rest, null, 2)}\n`, "utf8");
  written.push(jsonPath);
  return written;
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  const cmd = opts._[0] || "pull";
  if (cmd === "help" || opts.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (cmd !== "pull") {
    console.log(JSON.stringify({ ok: false, error: `Unknown command: ${cmd}` }, null, 2));
    process.exitCode = 1;
    return;
  }

  const result = await pullPackageSheet({
    tab: typeof opts.tab === "string" ? opts.tab : "",
    live: Boolean(opts.live),
    full: Boolean(opts.full),
  });
  if (!result.ok) {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1;
    return;
  }

  /** @type {string[]} */
  let written = [];
  if (opts.write) {
    const dir = typeof opts.write === "string" ? opts.write : "_inbox/package-sheet";
    written = await writePull(result, dir);
  }

  const rest = { ...result };
  delete rest.csvBySlug;
  const wantRows = Boolean(opts.packages) || Boolean(opts.tab);
  if (!wantRows) delete rest.packages;
  console.log(JSON.stringify({ ...rest, written }, null, 2));
}

main().catch((error) => {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
