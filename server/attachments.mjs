import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractPdf } from "./pdf.mjs";

const MAX_FILES = 6;
const MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
const PDF_MIME = new Set(["application/pdf"]);

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
 * @param {string} workspace
 * @param {unknown} raw
 */
export async function materializeAttachments(workspace, raw) {
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

  for (const [index, item] of list.entries()) {
    const name = safeName(item?.name || `file-${index + 1}`);
    const mime = guessMime(name, item?.mime || item?.type);
    const bytes = decodeData(item?.data || item?.content);
    if (!bytes.length) throw new Error(`Empty attachment: ${name}`);
    if (bytes.length > MAX_BYTES) throw new Error(`${name} is larger than 8 MB.`);
    const isImage = IMAGE_MIME.has(mime) || /^\.(png|jpe?g|webp|gif)$/i.test(path.extname(name));
    const isPdf = PDF_MIME.has(mime) || path.extname(name).toLowerCase() === ".pdf";
    if (!isImage && !isPdf) {
      throw new Error(`Unsupported file type (${mime || path.extname(name) || "unknown"}). Use an image or PDF.`);
    }

    const stored = `${stamp}-${index + 1}-${name}`;
    const abs = path.join(inbox, stored);
    await writeFile(abs, bytes);
    const rel = `_inbox/${stored}`;
    const entry = { name, rel, abs, mime, kind: isPdf ? "pdf" : "image", bytes: bytes.length };
    files.push(entry);

    if (isImage) {
      images.push({
        type: "image",
        data: bytes.toString("base64"),
        mimeType: mime === "image/jpg" ? "image/jpeg" : mime || "image/png",
      });
      lines.push(`- Image: ${rel} (${name})`);
    } else {
      const extract = await extractPdf(abs);
      const txtRel = `${rel}.txt`;
      if (extract.text) await writeFile(path.join(workspace, txtRel), extract.text, "utf8");
      lines.push(`- PDF: ${rel} (${name})`);
      if (extract.text) {
        lines.push(`- Extract: ${txtRel} (${extract.tool || "text"})`);
        lines.push("");
        lines.push("```text");
        lines.push(extract.text);
        lines.push("```");
      } else {
        lines.push(`- PDF extract failed: ${extract.error || "no text"}. Use node "$CLOUD_PI_PDF" extract ${rel}`);
      }
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
