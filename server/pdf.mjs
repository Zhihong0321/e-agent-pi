import { spawn } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

// A page with fewer visible characters than this is treated as an image (a scan, a
// full-page picture): there is nothing for a text extractor to read there.
const MIN_PAGE_CHARS = 20;
const MAX_TEXT_CHARS = 2_000_000;

export function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ ok: false, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
  });
}

/**
 * poppler's -layout mode pads columns with runs of spaces, which alone can be more than half of
 * the output. Keep the column gap as two spaces, drop the indentation, and mark page boundaries.
 * @param {string} raw text with a form feed after each page
 * @param {number} firstPage page number of the first page in `raw`
 */
export function tidyPdfText(raw, firstPage = 1) {
  const pages = String(raw).replace(/\r\n?/g, "\n").split("\f");
  if (pages.length > 1 && !pages[pages.length - 1].trim()) pages.pop();
  const bodies = pages.map((page) =>
    page
      .split("\n")
      .map((line) => line.replace(/^\s+/, "").replace(/\s{3,}/g, "  ").trimEnd())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
  const chars = bodies.map((body) => body.replace(/\s/g, "").length);
  const text = bodies.length > 1 || firstPage > 1 ? bodies.map((body, i) => `[Page ${firstPage + i}]\n${body}`.trimEnd()).join("\n\n") : bodies[0] || "";
  return { text: text.slice(0, MAX_TEXT_CHARS), chars, pages: bodies.length };
}

const PYPDF = [
  "import sys; p=sys.argv[1]; a=int(sys.argv[2]); b=int(sys.argv[3])",
  "try:",
  " from pypdf import PdfReader",
  " r=PdfReader(p)",
  " pages=r.pages[a-1:b if b>0 else None]",
  " sys.stdout.buffer.write('\\f'.join((pg.extract_text() or '') for pg in pages).encode('utf-8')+b'\\f')",
  "except Exception as e:",
  " sys.stderr.write(str(e)); sys.exit(1)",
].join("\n");

/**
 * Text of a PDF, or a clear reason there is none. Never returns the raw byte soup a scanned
 * PDF contains: pages without selectable text are reported in `imagePages` so a caller can
 * render them as pictures instead.
 * @param {string} filePath
 * @param {{ first?: number, last?: number }} [range] 1-based, inclusive
 */
export async function extractPdf(filePath, { first, last } = {}) {
  const from = first && first > 0 ? Math.floor(first) : 1;
  const args = ["-layout", "-enc", "UTF-8", "-f", String(from)];
  if (last && last >= from) args.push("-l", String(Math.floor(last)));
  args.push(filePath, "-");

  const poppler = await run("pdftotext", args);
  let tidy = poppler.ok ? tidyPdfText(poppler.stdout, from) : null;
  let tool = "pdftotext";
  let py = null;

  if (!tidy || !tidy.chars.some((n) => n >= MIN_PAGE_CHARS)) {
    py = await run("python3", ["-c", PYPDF, filePath, String(from), String(last && last >= from ? Math.floor(last) : 0)]);
    if (py.ok) {
      const candidate = tidyPdfText(py.stdout, from);
      if (candidate.chars.some((n) => n >= MIN_PAGE_CHARS)) {
        tidy = candidate;
        tool = "pypdf";
      } else if (!tidy) {
        tidy = candidate;
      }
    }
  }

  if (!tidy) {
    return { ok: false, kind: "pdf", tool: "none", text: "", error: (poppler.stderr || py?.stderr || "Could not extract PDF text").slice(0, 400) };
  }

  const imagePages = tidy.chars.flatMap((n, i) => (n < MIN_PAGE_CHARS ? [from + i] : []));
  if (imagePages.length === tidy.pages) {
    return {
      ok: false,
      kind: "pdf",
      tool,
      scanned: true,
      pages: tidy.pages,
      firstPage: from,
      imagePages,
      text: "",
      error: "No selectable text: this is a scanned or image-only PDF.",
    };
  }
  return { ok: true, kind: "pdf", tool, text: tidy.text, pages: tidy.pages, firstPage: from, imagePages };
}

/**
 * Render PDF pages to PNG files (poppler's pdftoppm) so a vision model can read them.
 * @param {string} filePath
 * @param {string} outDir
 * @param {{ first?: number, last?: number, dpi?: number }} [opts]
 * @param {typeof run} [exec] injectable for tests
 * @returns {Promise<{ ok: true, files: { page: number, path: string }[] } | { ok: false, error: string }>}
 */
export async function renderPdfPages(filePath, outDir, { first = 1, last = first + 2, dpi = 110 } = {}, exec = run) {
  await mkdir(outDir, { recursive: true });
  const stem = `${path.basename(filePath).replace(/[^A-Za-z0-9._-]+/g, "-")}-p`;
  const rendered = await exec("pdftoppm", ["-png", "-r", String(dpi), "-f", String(first), "-l", String(last), filePath, path.join(outDir, stem)]);
  if (!rendered.ok) return { ok: false, error: `Could not render pages (${(rendered.stderr || "pdftoppm failed").slice(0, 200)})` };
  const files = (await readdir(outDir))
    .flatMap((name) => {
      const m = name.startsWith(stem) && name.match(/-(\d+)\.png$/);
      return m ? [{ page: Number(m[1]), path: path.join(outDir, name) }] : [];
    })
    .sort((a, b) => a.page - b.page);
  return files.length ? { ok: true, files } : { ok: false, error: "pdftoppm produced no images" };
}
