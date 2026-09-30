#!/usr/bin/env node
// Host CLI behind $CLOUD_PI_PDF. Reads PDF, Word (.docx) and Excel (.xlsx) files.
//   extract FILE [--pages 5-9] [--offset N] [--limit N]   text as JSON, a slice at a time
//   render  FILE [--pages 1-3] [--out DIR]                PDF pages as PNGs, to look at scans
import path from "node:path";
import { documentKind, excerpt, extractDocument, legacyOfficeHint } from "./documents.mjs";
import { renderPdfPages } from "./pdf.mjs";

const DEFAULT_LIMIT = 20_000;
const USAGE = "Usage: node $CLOUD_PI_PDF extract FILE.(pdf|docx|xlsx) [--pages 5-9] [--offset N] [--limit N] | render FILE.pdf [--pages 1-3] [--out DIR]";

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  return { action: positional[0], file: positional[1], flags };
}

function pageRange(value) {
  if (!value) return {};
  const m = /^(\d+)(?:-(\d+))?$/.exec(String(value).trim());
  if (!m) throw new Error(`--pages must look like 5 or 5-9 (got "${value}")`);
  const first = Number(m[1]);
  return { first, last: m[2] ? Number(m[2]) : first };
}

const print = (value) => console.log(JSON.stringify(value, null, 2));

async function main() {
  const { action, file, flags } = parse(process.argv.slice(2));
  if (!["extract", "render"].includes(action) || !file) {
    print({ ok: false, error: USAGE });
    process.exitCode = 1;
    return;
  }
  const range = pageRange(flags.pages);
  if (action === "render") {
    if (documentKind(file) !== "pdf") throw new Error("render works on PDF files only");
    const out = flags.out || path.join(path.dirname(file), "_pages");
    const { first = 1, last = first + 2 } = range;
    const result = await renderPdfPages(file, out, { first, last });
    print(result.ok ? { ok: true, files: result.files.map((f) => ({ page: f.page, path: f.path })), note: "Open these images with the image read tool." } : result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (!documentKind(file)) throw new Error(legacyOfficeHint(file) || "Unsupported file type. Use a PDF, .docx or .xlsx file.");
  const result = await extractDocument(file, range);
  if (!result.ok) {
    print(result);
    process.exitCode = 1;
    return;
  }
  const limit = Math.max(1, Number(flags.limit) || DEFAULT_LIMIT);
  const offset = Math.max(0, Number(flags.offset) || 0);
  const slice = excerpt(result.text, limit, offset);
  print({
    ok: true,
    kind: result.kind,
    tool: result.tool,
    pages: result.pages,
    totalChars: slice.total,
    offset,
    returnedChars: slice.shown,
    ...(slice.truncated ? { nextOffset: offset + slice.shown, note: `More available: re-run with --offset ${offset + slice.shown}.` } : {}),
    ...(result.imagePages?.length ? { imagePages: result.imagePages } : {}),
    text: slice.text,
  });
}

try {
  await main();
} catch (error) {
  print({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
