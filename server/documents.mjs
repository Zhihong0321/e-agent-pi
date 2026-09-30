// One entry point for "read this file": PDF, Word or Excel in, compact text out.
import path from "node:path";
import { extractDocx, extractXlsx } from "./office.mjs";
import { extractPdf } from "./pdf.mjs";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const BY_EXT = { ".pdf": "pdf", ".docx": "docx", ".xlsx": "xlsx" };
const BY_MIME = { "application/pdf": "pdf", [DOCX_MIME]: "docx", [XLSX_MIME]: "xlsx" };
const LEGACY = { ".doc": "Word .docx", ".xls": "Excel .xlsx" };

/** @returns {"pdf" | "docx" | "xlsx" | null} the extension decides; browsers often send no or a wrong MIME */
export function documentKind(name, mime = "") {
  return BY_EXT[path.extname(String(name || "")).toLowerCase()] || BY_MIME[String(mime || "").toLowerCase()] || null;
}

/** The message for an older binary Office format, or "" when the name is not one. */
export function legacyOfficeHint(name) {
  const target = LEGACY[path.extname(String(name || "")).toLowerCase()];
  return target ? `Older Office files (.doc, .xls) are not supported. Save it as ${target} and attach that.` : "";
}

/**
 * @param {string} filePath
 * @param {{ kind?: string, first?: number, last?: number }} [opts] first/last select PDF pages
 */
export async function extractDocument(filePath, { kind = documentKind(filePath), first, last } = {}) {
  if (kind === "pdf") return extractPdf(filePath, { first, last });
  if (kind === "docx") return extractDocx(filePath);
  if (kind === "xlsx") return extractXlsx(filePath);
  return { ok: false, kind: kind || "unknown", tool: "none", text: "", error: legacyOfficeHint(filePath) || "Unsupported file type. Use a PDF, .docx or .xlsx file." };
}

/**
 * The first `limit` characters, cut at a line break so a row or sentence is not sliced in half.
 * @returns {{ text: string, shown: number, total: number, truncated: boolean }}
 */
export function excerpt(text, limit, offset = 0) {
  const total = text.length;
  const slice = text.slice(offset, offset + limit);
  if (offset + limit >= total) return { text: slice, shown: slice.length, total, truncated: false };
  const cut = slice.lastIndexOf("\n");
  const clean = cut > limit * 0.6 ? slice.slice(0, cut) : slice;
  return { text: clean, shown: clean.length, total, truncated: true };
}
