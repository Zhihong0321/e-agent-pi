import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const EXTRACT_LIMIT = 24_000;

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
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

function decodePdfString(raw) {
  return String(raw || "")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\")
    .replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(Number.parseInt(oct, 8)));
}

function naivePdfText(buffer) {
  const latin = buffer.toString("latin1");
  const chunks = [];
  const literal = /\((?:\\.|[^\\)])*\)/g;
  let match;
  while ((match = literal.exec(latin))) {
    const text = decodePdfString(match[0].slice(1, -1)).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
    if (text.trim()) chunks.push(text);
  }
  const hex = /<([0-9A-Fa-f \t\r\n]+)>/g;
  while ((match = hex.exec(latin))) {
    const hexStr = match[1].replace(/\s+/g, "");
    if (hexStr.length < 4 || hexStr.length % 2) continue;
    try {
      const text = Buffer.from(hexStr, "hex").toString("utf8").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
      if (/[\p{L}\p{N}]/u.test(text) && text.length < 400) chunks.push(text);
    } catch {
      // skip
    }
  }
  return chunks.join(" ").replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
}

function clip(text) {
  const value = String(text || "").trim();
  if (value.length <= EXTRACT_LIMIT) return value;
  return `${value.slice(0, EXTRACT_LIMIT)}\n…(truncated)`;
}

/**
 * @param {string} filePath
 */
export async function extractPdf(filePath) {
  const pdftotext = await run("pdftotext", ["-layout", "-enc", "UTF-8", filePath, "-"]);
  if (pdftotext.ok && pdftotext.stdout.trim()) {
    return { ok: true, tool: "pdftotext", text: clip(pdftotext.stdout), pages: null };
  }

  const py = await run("python3", [
    "-c",
    "import sys; p=sys.argv[1]\ntry:\n from pypdf import PdfReader\n r=PdfReader(p)\n print('\\n\\n'.join((pg.extract_text() or '') for pg in r.pages))\nexcept Exception as e:\n sys.stderr.write(str(e)); sys.exit(1)\n",
    filePath,
  ]);
  if (py.ok && py.stdout.trim()) {
    return { ok: true, tool: "pypdf", text: clip(py.stdout), pages: null };
  }

  const bytes = await readFile(filePath);
  const text = naivePdfText(bytes);
  if (text) {
    return { ok: true, tool: "naive", text: clip(text), pages: null };
  }
  return {
    ok: false,
    tool: "none",
    text: "",
    error: (pdftotext.stderr || py.stderr || "Could not extract PDF text").slice(0, 400),
  };
}
