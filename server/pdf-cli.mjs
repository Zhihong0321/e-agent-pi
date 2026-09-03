#!/usr/bin/env node
import { extractPdf } from "./pdf.mjs";

const [action, file] = process.argv.slice(2);
if (action !== "extract" || !file) {
  console.log(JSON.stringify({ ok: false, error: "Usage: node $CLOUD_PI_PDF extract FILE.pdf" }, null, 2));
  process.exitCode = 1;
} else {
  try {
    const result = await extractPdf(file);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  }
}
