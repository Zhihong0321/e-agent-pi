import { createHash } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { rememberSecret, secret } from "./secrets.mjs";
import { WORKSPACE } from "./paths.mjs";
import { zipDirectory } from "./zip.mjs";

export const DEFAULT_HOST_BASE = "https://ee-html.up.railway.app";
export const DEFAULT_HOST_SLUG = "e-agent-site";

function stripSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function hostBaseUrl() {
  return stripSlash(secret("ee_html_base_url") || process.env.EE_HTML_BASE_URL || DEFAULT_HOST_BASE) || DEFAULT_HOST_BASE;
}

export function hostApiKey() {
  return secret("ee_html_api_key") || process.env.EE_HTML_API_KEY?.trim() || "";
}

export function hostSlug() {
  const slug = secret("ee_html_slug") || DEFAULT_HOST_SLUG;
  return slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || DEFAULT_HOST_SLUG;
}

export function hostConfigured() {
  return Boolean(hostApiKey());
}

export function hostPublic() {
  const url = secret("ee_html_url") || (hostConfigured() ? `${hostBaseUrl()}/app/${hostSlug()}/` : "");
  return {
    configured: hostConfigured(),
    baseUrl: hostBaseUrl(),
    slug: hostSlug(),
    name: secret("ee_html_name") || "Website Dev Agent",
    url: url || null,
    lastError: secret("ee_html_last_error") || null,
  };
}

export function hostSystemPrompt() {
  const live = hostPublic();
  const url = live.url || `${live.baseUrl}/app/${live.slug}/`;
  if (!live.configured) {
    return `## Live hosting (ee-html)

The HTML host API key is NOT set. The studio will NOT publish this workspace.

Tell the human, plainly: open the studio Settings page, paste the ee-html API key in the HTML host section, set the slug if needed, and click Save. Saving is what publishes. Do not ask them to paste the key in chat. If they paste a key here, refuse to use it and point them at Settings.

Rules:
- NEVER run git. NEVER git add, commit, push, init, or clone.
- NEVER curl /api/apps, NEVER send an API key, NEVER zip-and-upload.
- Do not say the site will go live after this chat. It will not, until the key is saved on Settings.
- Intended URL after the key is saved: ${url}
`;
  }
  return `## Live hosting (ee-html)

The studio host publishes this workspace as a static zip to ${live.baseUrl} after you edit files.
Live URL for the human: ${url}

Rules:
- NEVER run git. NEVER git add, commit, push, init, or clone. There is no GitHub remote for this site.
- NEVER curl /api/apps or send the host API key. You do not publish. The host does.
- Use relative asset paths (href="styles.css", not /styles.css) because the site is served under /app/<slug>/.
- The bundle root must contain index.html.
- After you change files, tell the human the live URL above. Do not mention GitHub.
`;
}

async function remember(key, value) {
  await rememberSecret(key, String(value ?? ""));
}

export async function forgetBundleHash() {
  await remember("ee_html_bundle_hash", "");
}

/**
 * Zip the workspace and POST it to the HTML host engine.
 * Skips when the zip hash is unchanged unless `force` is set.
 * @param {{ force?: boolean }} [opts]
 */
export async function publishWorkspace(opts = {}) {
  const status = hostPublic();
  if (!hostConfigured()) {
    const error = "Add the HTML host API key on the Settings page.";
    await remember("ee_html_last_error", error);
    return { ...status, skipped: true, lastError: error };
  }

  const index = path.join(WORKSPACE, "index.html");
  try {
    await access(index);
  } catch {
    const error = "Workspace has no index.html; nothing to publish.";
    await remember("ee_html_last_error", error);
    return { ...status, url: null, lastError: error };
  }

  const zip = await zipDirectory(WORKSPACE);
  const hash = createHash("sha1").update(zip).digest("hex");
  if (!opts.force && hash === secret("ee_html_bundle_hash") && secret("ee_html_url")) {
    await remember("ee_html_last_error", "");
    return { ...hostPublic(), skipped: true };
  }

  const slug = hostSlug();
  const name = secret("ee_html_name") || "Website Dev Agent";
  const form = new FormData();
  form.append("bundle", new File([new Uint8Array(zip)], "site.zip", { type: "application/zip" }));
  form.append("slug", slug);
  form.append("name", name);

  const res = await fetch(`${hostBaseUrl()}/api/apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${hostApiKey()}` },
    body: form,
  });
  const raw = await res.text();
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { error: raw };
  }
  if (!res.ok) {
    const error = String(body.error || body.message || raw || `HTML host ${res.status}`).slice(0, 400);
    await remember("ee_html_last_error", error);
    return { ...hostPublic(), lastError: error };
  }

  const url = String(body.url || `${hostBaseUrl()}/app/${body.slug || slug}/`);
  await remember("ee_html_slug", body.slug || slug);
  await remember("ee_html_url", url);
  await remember("ee_html_bundle_hash", hash);
  await remember("ee_html_last_error", "");
  return {
    configured: true,
    baseUrl: hostBaseUrl(),
    slug: body.slug || slug,
    name,
    url,
    lastError: null,
    files: body.files,
    skipped: false,
  };
}

/** ee-html slugs are lowercase, hyphenated, and capped at 63 characters. */
export function normalizeSlug(value, fallback = "prototype") {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return slug || fallback;
}

/**
 * POST one directory to the HTML host as its own app.
 *
 * Unlike publishWorkspace this touches none of the shared ee_html_* settings:
 * the caller owns the slug, so many prototypes can live side by side under the
 * one API key without overwriting the company site.
 *
 * @param {{ dir: string; slug: string; name?: string }} opts
 */
export async function publishDirectory(opts) {
  const slug = normalizeSlug(opts.slug);
  if (!hostConfigured()) {
    return { slug, url: null, lastError: "Add the HTML host API key on the Settings page." };
  }
  try {
    await access(path.join(opts.dir, "index.html"));
  } catch {
    return { slug, url: null, lastError: "No index.html in this folder; nothing to publish." };
  }

  const zip = await zipDirectory(opts.dir);
  const form = new FormData();
  form.append("bundle", new File([new Uint8Array(zip)], "site.zip", { type: "application/zip" }));
  form.append("slug", slug);
  form.append("name", opts.name || slug);

  const res = await fetch(`${hostBaseUrl()}/api/apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${hostApiKey()}` },
    body: form,
  });
  const raw = await res.text();
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { error: raw };
  }
  if (!res.ok) {
    return {
      slug,
      url: null,
      lastError: String(body.error || body.message || raw || `HTML host ${res.status}`).slice(0, 400),
    };
  }
  return {
    slug: body.slug || slug,
    url: String(body.url || `${hostBaseUrl()}/app/${body.slug || slug}/`),
    lastError: null,
    hash: createHash("sha1").update(zip).digest("hex"),
  };
}

/** Per-folder zip hashes, so an untouched prototype isn't re-uploaded every turn. */
const prototypeHashes = new Map();

/**
 * Publish every prototype folder in a Prototyper's workspace.
 *
 * One folder is one app and the folder name is the slug, so the agent owns its
 * own URLs — a `stock-count-v2` folder simply gets a v2 URL, and an approved
 * blueprint's link keeps working because nothing overwrites it. The host stays
 * dumb on purpose. `source/` is the read-only checkout, never a prototype.
 *
 * @param {{ dir: string; prefix?: string; skip?: string[] }} opts
 */
export async function publishPrototypes(opts) {
  const prefix = opts.prefix ? `${normalizeSlug(opts.prefix)}-` : "";
  const skip = new Set(opts.skip || ["source"]);
  if (!hostConfigured()) {
    return { configured: false, prototypes: [], lastError: "Add the HTML host API key on the Settings page." };
  }

  let entries = [];
  try {
    entries = await readdir(opts.dir, { withFileTypes: true });
  } catch {
    return { configured: true, prototypes: [], lastError: null };
  }

  const published = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || skip.has(entry.name)) continue;
    const dir = path.join(opts.dir, entry.name);
    try {
      await access(path.join(dir, "index.html"));
    } catch {
      continue;
    }
    const slug = normalizeSlug(`${prefix}${entry.name}`);
    const hash = createHash("sha1").update(await zipDirectory(dir)).digest("hex");
    if (prototypeHashes.get(slug) === hash) {
      published.push({ slug, url: `${hostBaseUrl()}/app/${slug}/`, lastError: null, skipped: true });
      continue;
    }
    const result = await publishDirectory({ dir, slug, name: entry.name });
    if (!result.lastError) prototypeHashes.set(slug, result.hash || hash);
    published.push({ ...result, skipped: false });
  }

  return {
    configured: true,
    prototypes: published,
    lastError: published.find((p) => p.lastError)?.lastError || null,
  };
}
