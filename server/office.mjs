// Word (.docx) and Excel (.xlsx) to compact plain text for an agent. Dependency-light on
// purpose (mammoth, read-excel-file): no Python stack, nothing extra in the Docker image.
import mammoth from "mammoth";
import readXlsx from "read-excel-file/node";

const MAX_TEXT_CHARS = 2_000_000;
const MAX_SHEETS = 30;
const MAX_ROWS_PER_SHEET = 5000;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });

/**
 * mammoth's clean HTML to readable text: headings as #, lists as -, tables as pipe rows,
 * links with their URL, pictures as a marker. Formatting that carries no meaning is dropped.
 * @param {string} html
 */
export function htmlToText(html) {
  const out = [];
  const lists = [];
  let buf = "";
  let prefix = "";
  let tableDepth = 0;
  let rows = [];
  let row = null;
  let cell = null;
  const hrefs = [];

  const flush = () => {
    const text = buf.replace(/\s+/g, " ").trim();
    buf = "";
    if (text) out.push(prefix + text);
    prefix = "";
  };

  for (const m of String(html).matchAll(/<(\/?)([a-z][a-z0-9]*)([^>]*)>|([^<]+)/gi)) {
    if (m[4] !== undefined) {
      const t = decode(m[4]);
      if (cell !== null) cell += t;
      else buf += t;
      continue;
    }
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    const inCell = cell !== null;
    if (/^h[1-6]$/.test(tag)) {
      if (closing) {
        flush();
        out.push("");
      } else {
        flush();
        prefix = `${"#".repeat(Number(tag[1]))} `;
      }
    } else if (tag === "p") {
      if (inCell) cell += " ";
      else if (closing) {
        flush();
        if (!lists.length) out.push("");
      } else flush();
    } else if (tag === "br") {
      if (inCell) cell += " ";
      else flush();
    } else if (tag === "ul" || tag === "ol") {
      if (closing) lists.pop();
      else lists.push({ ordered: tag === "ol", n: 0 });
      if (!inCell) flush();
    } else if (tag === "li") {
      if (closing) flush();
      else if (!inCell) {
        flush();
        const list = lists[lists.length - 1];
        if (list) list.n += 1;
        prefix = `${"  ".repeat(Math.max(0, lists.length - 1))}${list?.ordered ? `${list.n}. ` : "- "}`;
      }
    } else if (tag === "table") {
      if (closing) {
        tableDepth -= 1;
        if (tableDepth === 0) {
          flush();
          for (const r of rows) out.push(r.join(" | "));
          out.push("");
          rows = [];
        }
      } else {
        if (tableDepth === 0) flush();
        tableDepth += 1;
      }
    } else if (tag === "tr" && tableDepth === 1) {
      if (closing) {
        if (row) rows.push(row);
        row = null;
      } else row = [];
    } else if ((tag === "td" || tag === "th") && tableDepth === 1) {
      if (closing) {
        row?.push(cell.replace(/\s+/g, " ").trim());
        cell = null;
      } else cell = "";
    } else if (tag === "a") {
      if (closing) {
        const href = hrefs.pop();
        if (href) {
          if (cell !== null) cell += ` (${href})`;
          else buf += ` (${href})`;
        }
      } else {
        const href = /\shref="([^"]*)"/i.exec(m[3])?.[1];
        hrefs.push(href && /^(https?:|mailto:)/i.test(href) ? decode(href) : null);
      }
    } else if (tag === "img" && !closing) {
      if (cell !== null) cell += "[image]";
      else buf += "[image]";
    }
  }
  flush();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT_CHARS);
}

function failure(kind, error) {
  const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 160);
  return {
    ok: false,
    kind,
    tool: "none",
    text: "",
    error: `Could not read this .${kind} file (${detail}). It may be corrupt, password-protected or an older format; save it as a plain .${kind} and try again.`,
  };
}

/** @param {string} filePath */
export async function extractDocx(filePath) {
  try {
    const { value } = await mammoth.convertToHtml(
      { path: filePath },
      { convertImage: mammoth.images.imgElement(async () => ({ src: "", alt: "" })) },
    );
    const text = htmlToText(value);
    if (!text) return { ok: false, kind: "docx", tool: "mammoth", text: "", error: "The document has no text content." };
    return { ok: true, kind: "docx", tool: "mammoth", text, pages: null };
  } catch (error) {
    return failure("docx", error);
  }
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 16).replace("T", " ");
  }
  if (typeof value === "number") return String(Number(value.toPrecision(15)));
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  const text = String(value).replace(/\s*[\r\n]+\s*/g, " ");
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const isEmpty = (v) => v === null || v === undefined || v === "";

/**
 * Every sheet as CSV under a heading. CSV is the most compact form a model reads well, and
 * cached formula results are used as-is.
 * @param {string} filePath
 */
export async function extractXlsx(filePath) {
  try {
    const sheets = await readXlsx(filePath);
    const parts = sheets.slice(0, MAX_SHEETS).map(({ sheet, data }) => {
      const rows = data.slice(0);
      while (rows.length && rows[rows.length - 1].every(isEmpty)) rows.pop();
      const cols = rows.reduce((max, r) => {
        let last = r.length;
        while (last > 0 && isEmpty(r[last - 1])) last -= 1;
        return Math.max(max, last);
      }, 0);
      if (!rows.length || !cols) return `## ${sheet}\n(empty)`;
      const shown = rows.slice(0, MAX_ROWS_PER_SHEET);
      const note = rows.length > shown.length ? ` (first ${shown.length} shown)` : "";
      const body = shown.map((r) => Array.from({ length: cols }, (_, i) => csvCell(r[i])).join(",").replace(/,+$/, "")).join("\n");
      return `## ${sheet}: ${rows.length} rows × ${cols} columns${note}\n${body}`;
    });
    if (sheets.length > MAX_SHEETS) parts.push(`(${sheets.length - MAX_SHEETS} more sheets not shown)`);
    const text = parts.join("\n\n").slice(0, MAX_TEXT_CHARS);
    return { ok: true, kind: "xlsx", tool: "read-excel-file", text, pages: null, sheets: sheets.map((s) => s.sheet) };
  } catch (error) {
    return failure("xlsx", error);
  }
}
