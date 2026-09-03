import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { secret } from "./secrets.mjs";
import { WORKSPACE } from "./paths.mjs";

export const DEFAULT_IMAGEN_MODEL = "gemini-3.1-flash-image";
export const DEFAULT_GOOGLE_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1";

/**
 * @returns {{ apiKey: string; baseUrl: string; model: string; api: string }}
 */
export function resolveImagenConfig() {
  const apiKey = secret("imagen_api_key");
  const model = secret("imagen_model") || DEFAULT_IMAGEN_MODEL;
  const requested = (secret("imagen_api") || "auto").toLowerCase();
  const storedBase = secret("imagen_base_url");
  const api = requested === "google" || requested === "openai" ? requested : detectApi(storedBase, model);
  const baseUrl = storedBase || (api === "openai" ? DEFAULT_OPENAI_BASE : DEFAULT_GOOGLE_BASE);
  return { apiKey, baseUrl: stripSlash(baseUrl), model, api };
}

export function imagenConfigured() {
  return Boolean(secret("imagen_api_key"));
}

export function imagenPublic() {
  const cfg = resolveImagenConfig();
  return {
    configured: imagenConfigured(),
    model: cfg.model,
    api: cfg.api,
    baseUrl: cfg.baseUrl,
  };
}

export function imagenSystemPrompt() {
  if (!imagenConfigured()) return "";
  const { model, api } = resolveImagenConfig();
  return `## Image generation (host Imagen)

The operator configured a host image model for every agent: \`${model}\` (${api}).

To generate an image into this workspace, run:

\`\`\`bash
node "$CLOUD_PI_IMAGEN" generate --prompt "your image prompt" --out assets/hero.png
\`\`\`

Optional: \`--aspect 16:9\` (Google) or \`--size 1024x1024\` (OpenAI-compatible).

Rules:
- Use this CLI only. Do not curl \`/api/*\`. Do not invent another image API or put the key in files.
- Write files under the workspace (\`assets/\` is preferred). Then reference the file from HTML/CSS.
- If \`$CLOUD_PI_IMAGEN\` is missing, image generation is not configured.
`;
}

/**
 * @param {{ prompt: string; out?: string; aspect?: string; size?: string }} opts
 */
export async function generateImage(opts) {
  const prompt = String(opts.prompt || "").trim();
  if (!prompt) throw new Error("prompt is required");
  if (!imagenConfigured()) {
    throw new Error("Imagen is not configured. Add the model on the Settings page.");
  }

  const cfg = resolveImagenConfig();
  const image = cfg.api === "openai" ? await generateOpenAi(cfg, opts) : await generateGoogle(cfg, opts);
  const target = resolveWorkspaceOut(opts.out, image.ext);
  await mkdir(path.dirname(target.full), { recursive: true });
  await writeFile(target.full, image.bytes);
  return {
    ok: true,
    path: target.rel,
    bytes: image.bytes.length,
    mime: image.mime,
    model: cfg.model,
    api: cfg.api,
  };
}

function detectApi(baseUrl, model) {
  const url = (baseUrl || "").toLowerCase();
  const id = (model || "").toLowerCase();
  if (url.includes("googleapis.com") || url.includes("generativelanguage") || url.includes("aiplatform")) {
    return "google";
  }
  if (id.startsWith("imagen-") || id.startsWith("gemini-")) return "google";
  if (url.includes("openai.com") || id.startsWith("dall-e") || id.startsWith("gpt-image")) return "openai";
  return url ? "openai" : "google";
}

function stripSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function extForMime(mime) {
  if (mime?.includes("jpeg") || mime?.includes("jpg")) return ".jpg";
  if (mime?.includes("webp")) return ".webp";
  return ".png";
}

/**
 * @param {string | undefined} out
 * @param {string} ext
 */
export function resolveWorkspaceOut(out, ext = ".png") {
  const fallback = `assets/generated/imagen-${Date.now()}${ext}`;
  let rel = String(out || "").trim() || fallback;
  rel = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!path.extname(rel)) rel = `${rel}${ext}`;
  const full = path.resolve(WORKSPACE, rel);
  const root = path.resolve(WORKSPACE);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error("Output path must stay inside the workspace");
  }
  return { full, rel: path.relative(root, full).replaceAll("\\", "/") };
}

/**
 * @param {{ apiKey: string; baseUrl: string; model: string }} cfg
 * @param {{ prompt: string; aspect?: string }} opts
 */
async function generateGoogle(cfg, opts) {
  if (cfg.model.toLowerCase().startsWith("imagen-")) {
    return requestGooglePredict(cfg, opts);
  }
  return requestGoogleGenerateContent(cfg, opts);
}

/**
 * @param {{ apiKey: string; baseUrl: string; model: string }} cfg
 * @param {{ prompt: string; aspect?: string }} opts
 */
async function requestGoogleGenerateContent(cfg, opts) {
  const url = `${cfg.baseUrl}/models/${encodeURIComponent(cfg.model)}:generateContent`;
  const body = {
    contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  };
  if (opts.aspect) {
    body.generationConfig.imageConfig = { aspectRatio: opts.aspect };
  }
  const data = await postJson(url, body, googleHeaders(cfg.apiKey));
  const image = extractGoogleImage(data);
  if (!image) throw new Error(googleError(data) || "Google image model returned no image");
  return image;
}

/**
 * @param {{ apiKey: string; baseUrl: string; model: string }} cfg
 * @param {{ prompt: string; aspect?: string }} opts
 */
async function requestGooglePredict(cfg, opts) {
  const url = `${cfg.baseUrl}/models/${encodeURIComponent(cfg.model)}:predict`;
  const parameters = { sampleCount: 1 };
  if (opts.aspect) parameters.aspectRatio = opts.aspect;
  const data = await postJson(
    url,
    { instances: [{ prompt: opts.prompt }], parameters },
    googleHeaders(cfg.apiKey),
  );
  const pred = data?.predictions?.[0] || data?.generatedImages?.[0] || data;
  const b64 = pred?.bytesBase64Encoded || pred?.bytes_base64_encoded || pred?.image?.bytesBase64Encoded;
  if (!b64) throw new Error(googleError(data) || "Imagen predict returned no image");
  const mime = pred?.mimeType || pred?.mime_type || "image/png";
  return { bytes: Buffer.from(String(b64), "base64"), mime, ext: extForMime(mime) };
}

/**
 * @param {{ apiKey: string; baseUrl: string; model: string }} cfg
 * @param {{ prompt: string; size?: string }} opts
 */
async function generateOpenAi(cfg, opts) {
  const base = cfg.baseUrl.endsWith("/v1") ? cfg.baseUrl : `${cfg.baseUrl}/v1`;
  const url = `${base}/images/generations`;
  const data = await postJson(
    url,
    {
      model: cfg.model,
      prompt: opts.prompt,
      n: 1,
      size: opts.size || "1024x1024",
      response_format: "b64_json",
    },
    {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
  );
  const item = data?.data?.[0];
  if (item?.b64_json) {
    return { bytes: Buffer.from(String(item.b64_json), "base64"), mime: "image/png", ext: ".png" };
  }
  if (item?.url) {
    const res = await fetch(item.url);
    if (!res.ok) throw new Error(`Image download failed (${res.status})`);
    const mime = res.headers.get("content-type") || "image/png";
    return { bytes: Buffer.from(await res.arrayBuffer()), mime, ext: extForMime(mime) };
  }
  throw new Error(data?.error?.message || "OpenAI-compatible image API returned no image");
}

function googleHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
  };
}

function extractGoogleImage(data) {
  const parts = [];
  for (const cand of data?.candidates || []) {
    for (const part of cand?.content?.parts || []) parts.push(part);
  }
  for (const part of data?.contents?.flatMap((c) => c.parts || []) || []) parts.push(part);
  for (const part of parts) {
    const inline = part.inlineData || part.inline_data;
    if (inline?.data) {
      const mime = inline.mimeType || inline.mime_type || "image/png";
      return { bytes: Buffer.from(String(inline.data), "base64"), mime, ext: extForMime(mime) };
    }
  }
  return null;
}

function googleError(data) {
  return data?.error?.message || data?.promptFeedback?.blockReason || "";
}

async function postJson(url, body, headers) {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    if (!res.ok) throw new Error(`Image API ${res.status}: ${text.slice(0, 240)}`);
    throw new Error("Image API returned non-JSON");
  }
  if (!res.ok) {
    throw new Error(data?.error?.message || `Image API ${res.status}`);
  }
  return data;
}
