import { readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { WORKSPACE } from "./paths.mjs";
import { logEvent } from "./debug.mjs";

const STRAY = ["README.md", "Dockerfile", ".dockerignore"];

/** Unused / unpublished locally — originals live on the PR Center. */
const DROP = [
  "assets/certs/profile-2025.pdf",
  "assets/certs/all-certs.pdf",
  "assets/solar-panel.png",
  "assets/solar-panel-2.png",
];

/**
 * One-shot workspace hygiene for Website Dev Agent. Fonts 404 and stray
 * files live on the volume, not in this git repo.
 */
export async function healWebsiteWorkspace() {
  const cssPath = path.join(WORKSPACE, "styles.css");
  try {
    const css = await readFile(cssPath, "utf8");
    if (css.includes("../assets/fonts/")) {
      await writeFile(cssPath, css.replaceAll("../assets/fonts/", "assets/fonts/"), "utf8");
      logEvent("info", "healed styles.css font paths (../assets/fonts → assets/fonts)");
    }
  } catch {
    // workspace may be empty on first boot
  }

  for (const name of STRAY) {
    try {
      await unlink(path.join(WORKSPACE, name));
      logEvent("info", `removed stray workspace file ${name}`);
    } catch {
      // absent
    }
  }

  try {
    await rm(path.join(WORKSPACE, ".impeccable", "build"), { recursive: true, force: true });
  } catch {
    // optional
  }

  for (const rel of DROP) {
    try {
      await unlink(path.join(WORKSPACE, rel));
      logEvent("info", `removed unused workspace file ${rel}`);
    } catch {
      // absent
    }
  }

  await healWebsiteIdentity();
}

/**
 * PR Center (https://ee-pr.up.railway.app/) is the source of truth.
 * It publishes SSM 202301029164 (1523087-A) and pr@eternalgy.me.
 * It does not publish a phone number or street address.
 */
async function healWebsiteIdentity() {
  const htmlPath = path.join(WORKSPACE, "index.html");
  let html;
  try {
    html = await readFile(htmlPath, "utf8");
  } catch {
    return;
  }
  const before = html;
  html = html.replace(/\s*"telephone"\s*:\s*"\+60 12-345 6789",?\s*/g, "\n    ");
  html = html.replace("or call 012-345 6789. ", "");
  html = html.replace(
    /\s*<a class="btn btn-line btn-lg" href="tel:\+60123456789">[\s\S]*?<\/a>/,
    "",
  );
  html = html.replace("pr@eternalgy.me · 012-345 6789", "pr@eternalgy.me");
  html = html.replaceAll("012-345 6789", "");
  if (html !== before) {
    await writeFile(htmlPath, html, "utf8");
    logEvent("info", "healed index.html company identity (removed placeholder phone; PR Center has none)");
  }
}
