import { access } from "node:fs/promises";
import path from "node:path";
import { BROWSER_PROFILES, findChromiumExecutable } from "./browser.mjs";
import { dbReady } from "./db.mjs";
import { ensureNewpagesLogin, newpagesStatus } from "./newpages.mjs";
import { getSite, NEWPAGES_SITE_SLUG } from "./sites.mjs";
import { publicNewpagesSiteView } from "./newpages/login-diagnose.mjs";

function exists(file) {
  return access(file).then(
    () => true,
    () => false,
  );
}

/**
 * Cheap NEWPAGES diagnostic, same idea as /api/health.
 * `probe=ready` opens Chromium and reads localStorage.
 * `probe=login` also drives Settings credentials through the merchant form.
 */
export async function newpagesHealth({ probe = "" } = {}) {
  const chromiumPath = await findChromiumExecutable();
  const profileDir = path.join(BROWSER_PROFILES, NEWPAGES_SITE_SLUG);
  const profileExists = await exists(profileDir);
  const site = dbReady() ? await getSite(NEWPAGES_SITE_SLUG).catch(() => null) : null;
  const body = {
    ok: Boolean(chromiumPath && site?.passwordSet),
    chromium: { found: Boolean(chromiumPath), path: chromiumPath || null },
    profile: {
      exists: profileExists,
      singletonLock: profileExists ? await exists(path.join(profileDir, "SingletonLock")) : false,
    },
    site: publicNewpagesSiteView(site),
  };

  const kind = String(probe || "").toLowerCase();
  if (kind !== "ready" && kind !== "login") return body;

  try {
    if (kind === "login") {
      const result = await ensureNewpagesLogin();
      body.probe = { kind, ready: Boolean(result.ready), detail: result.detail || "", companyName: result.companyName || null };
    } else {
      const result = await newpagesStatus();
      body.probe = { kind, ready: Boolean(result.ready), detail: result.detail || "", companyName: result.companyName || null };
    }
    body.ok = Boolean(body.probe.ready);
    body.site = publicNewpagesSiteView(dbReady() ? await getSite(NEWPAGES_SITE_SLUG).catch(() => null) : null);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    body.ok = false;
    body.probe = { kind, ready: false, detail };
    body.site = publicNewpagesSiteView(dbReady() ? await getSite(NEWPAGES_SITE_SLUG).catch(() => null) : null);
  }
  return body;
}
