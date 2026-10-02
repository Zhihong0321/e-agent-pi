import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DOCX_MIME, XLSX_MIME, documentKind, excerpt, extractDocument, legacyOfficeHint } from "./documents.mjs";
import { renderPdfPages } from "./pdf.mjs";

const MAX_FILES = 6;
const MAX_BYTES = 8 * 1024 * 1024;
// How much extracted text goes straight into the prompt. The rest stays in the .txt next to the
// file, which the agent reads on demand; pasting a whole report into every turn is what costs.
const INLINE_PER_FILE = 8000;
const INLINE_TOTAL = 16000;
const SCAN_PAGES_AS_IMAGES = 3;
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
const KIND_LABEL = { pdf: "PDF", docx: "Word", xlsx: "Excel" };

function safeName(name) {
  const base = path.basename(String(name || "file")).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
  return base || "file";
}

function guessMime(name, mime) {
  const given = String(mime || "").toLowerCase().split(";")[0].trim();
  if (given) return given === "image/jpg" ? "image/jpeg" : given;
  const ext = path.extname(String(name || "")).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".docx") return DOCX_MIME;
  if (ext === ".xlsx") return XLSX_MIME;
  return "";
}

function decodeData(data) {
  const raw = String(data || "");
  const comma = raw.indexOf(",");
  const payload = raw.startsWith("data:") && comma !== -1 ? raw.slice(comma + 1) : raw;
  return Buffer.from(payload, "base64");
}

/**
 * Save chat attachments into workspace/_inbox and build a prompt prefix.
 * Documents (PDF, Word, Excel) are read to text; a scanned PDF is shown to the model as page images.
 * @param {string} workspace
 * @param {unknown} raw
 */
export async function materializeAttachments(workspace, raw, { complete = false } = {}) {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) {
    return { prompt: "", images: [], files: [] };
  }
  if (list.length > MAX_FILES) {
    throw new Error(`Attach at most ${MAX_FILES} files.`);
  }

  const inbox = path.join(workspace, "_inbox");
  await mkdir(inbox, { recursive: true });
  const stamp = Date.now();
  const files = [];
  /** @type {{ type: "image"; data: string; mimeType: string }[]} */
  const images = [];
  const lines = ["The operator attached these files under `_inbox/` (gitignored). Read them before editing."];
  let inlineLeft = complete ? Infinity : INLINE_TOTAL;

  for (const [index, item] of list.entries()) {
    const name = safeName(item?.name || `file-${index + 1}`);
    const mime = guessMime(name, item?.mime || item?.type);
    const bytes = decodeData(item?.data || item?.content);
    if (!bytes.length) throw new Error(`Empty attachment: ${name}`);
    if (bytes.length > MAX_BYTES) throw new Error(`${name} is larger than 8 MB.`);
    const isImage = IMAGE_MIME.has(mime) || /^\.(png|jpe?g|webp|gif)$/i.test(path.extname(name));
    const kind = isImage ? null : documentKind(name, mime);
    if (!isImage && !kind) {
      throw new Error(legacyOfficeHint(name) || `Unsupported file type (${mime || path.extname(name) || "unknown"}). Use an image, PDF, Word (.docx) or Excel (.xlsx) file.`);
    }

    const stored = `${stamp}-${index + 1}-${name}`;
    const abs = path.join(inbox, stored);
    await writeFile(abs, bytes);
    const rel = `_inbox/${stored}`;
    const entry = { name, rel, abs, mime, kind: kind || "image", bytes: bytes.length };
    files.push(entry);

    if (isImage) {
      images.push({
        type: "image",
        data: bytes.toString("base64"),
        mimeType: mime === "image/jpg" ? "image/jpeg" : mime || "image/png",
      });
      lines.push(`- Image: ${rel} (${name})`);
      continue;
    }

    const label = KIND_LABEL[kind];
    const extract = await extractDocument(abs, { kind });
    lines.push(`- ${label}: ${rel} (${name})`);

    // MCP-only clerks cannot read the saved text or render omitted pages later.
    // Fail closed if complete evidence cannot be delivered to the model.
    if (complete && kind === "pdf" && extract.imagePages?.length) {
      const shots = await renderPdfPages(abs, inbox, { first: 1, last: extract.pages });
      if (!shots.ok) throw new Error(`Could not prepare all pages of ${name}: ${shots.error}`);
      for (const page of extract.imagePages) {
        const shot = shots.files.find(file => file.page === page);
        if (!shot) throw new Error(`Missing page ${page} of ${name}`);
        const pageRel = path.posix.join("_inbox", path.basename(shot.path));
        images.push({ type: "image", data: (await readFile(shot.path)).toString("base64"), mimeType: "image/png" });
        lines.push(`  Image ${images.length}: ${name}, page ${page} of ${extract.pages}. Receipt attachment: ${pageRel}`);
      }
      lines.push(`  Original receipt attachment (all ${extract.pages} pages): ${rel}`);
      if (extract.scanned) continue;
    }

    if (extract.scanned) {
      const shots = await renderPdfPages(abs, inbox, { first: 1, last: SCAN_PAGES_AS_IMAGES });
      if (shots.ok) {
        for (const shot of shots.files) {
          const png = await readFile(shot.path);
          images.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
        }
        const last = shots.files[shots.files.length - 1].page;
        const more = extract.pages > last ? ` Render more with node "$CLOUD_PI_PDF" render ${rel} --pages ${last + 1}-${Math.min(extract.pages, last + SCAN_PAGES_AS_IMAGES)}.` : "";
        lines.push(`  Scanned PDF with no selectable text (${extract.pages} pages). Pages 1-${last} are attached as images.${more}`);
      } else {
        lines.push(`  Scanned PDF with no selectable text (${extract.pages} pages) and it could not be rendered: ${shots.error}`);
      }
      continue;
    }
    if (!extract.ok) {
      if (complete) throw new Error(`Could not read ${name}: ${extract.error || "no text"}`);
      lines.push(`  Could not read it: ${extract.error || "no text"}.`);
      continue;
    }

    const txtRel = `${rel}.txt`;
    await writeFile(path.join(workspace, txtRel), extract.text, "utf8");
    const size = extract.pages ? `${extract.pages} pages, ` : "";
    lines.push(`- Text: ${txtRel} (${size}${extract.text.length} chars, ${extract.tool})`);
    if (!complete && extract.imagePages?.length) {
      lines.push(`  Pages with no selectable text (pictures): ${extract.imagePages.join(", ")}. Render them with node "$CLOUD_PI_PDF" render ${rel} --pages N-M.`);
    }
    const shown = excerpt(extract.text, complete ? extract.text.length : Math.min(INLINE_PER_FILE, inlineLeft));
    inlineLeft -= shown.shown;
    if (shown.shown > 0) {
      lines.push("", "```text", shown.text, "```");
    }
    if (shown.truncated || shown.shown === 0) {
      const more = kind === "pdf" ? ` or node "$CLOUD_PI_PDF" extract ${rel} --pages N-M` : "";
      lines.push(`  Showing ${shown.shown} of ${shown.total} chars. Read the rest from ${txtRel} (read tool with offset)${more}.`);
    }
  }

  return { prompt: `${lines.join("\n")}\n`, images, files };
}

export function attachmentSummary(files) {
  if (!files?.length) return "";
  return files.map((file) => file.name).join(", ");
}

/**
 * Markdown the chat UI can render: images inline, other files as links.
 * @param {{ name: string; rel: string; kind?: string }[]} files
 */
export function attachmentChatMarkup(files) {
  if (!files?.length) return "";
  return files
    .map((file) => (file.kind === "image" ? `![${file.name}](${file.rel})` : `[${file.name}](${file.rel})`))
    .join("\n");
}
