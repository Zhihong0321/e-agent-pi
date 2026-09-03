import { browserManager } from "./browser.mjs";
import { getSite, markSiteLogin, NEWPAGES_SITE_SLUG } from "./sites.mjs";
import {
  NP_MERCHANT_HOST,
  npNewsCategories,
  npNewsCreate,
  npNewsDelete,
  npNewsList,
  npReady,
} from "./newpages/npmerchant.mjs";

const SITE_SLUG = NEWPAGES_SITE_SLUG;

function manager() {
  return browserManager(SITE_SLUG);
}

/**
 * Fill the merchant login form if localStorage has no token yet.
 * Persistent Chromium profile keeps the token after the first success.
 */
export async function loginNewpagesSite(site) {
  const login = site || (await getSite(SITE_SLUG, { secrets: true }));
  if (!login) throw new Error("NEWPAGES site is not in Settings → Sites.");
  if (!login.username || !login.password) {
    throw new Error("Save the NEWPAGES merchant username and password on Settings → Sites first.");
  }
  const browser = manager();
  return browser.runIsolated(async (_ctx, page) => {
    await page.goto(login.loginUrl || login.origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const existing = await page.evaluate(() => ({
      token: localStorage.getItem("token") || "",
      companyId: localStorage.getItem("company_id") || "",
    }));
    if (existing.token && existing.companyId) {
      return { ok: true, skipped: true, detail: "already signed in (token in profile)" };
    }

    const password = page.locator('input[type="password"]:visible').first();
    await password.waitFor({ timeout: 30_000 });
    const user = page
      .locator(
        'input[type="email"]:visible, input[name="email"]:visible, input[name="username"]:visible, input[name="account"]:visible, input[type="text"]:visible',
      )
      .first();
    await user.fill(login.username);
    await password.fill(login.password);
    const submit = page.locator("button:visible").filter({ hasText: /^\s*(login|log in|sign in|submit)\s*$/i }).first();
    if ((await submit.count()) === 0) {
      await password.press("Enter");
    } else {
      await submit.click();
    }

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const creds = await page.evaluate(() => ({
        token: localStorage.getItem("token") || "",
        companyId: localStorage.getItem("company_id") || "",
        companyName: localStorage.getItem("company_name") || "",
      }));
      if (creds.token && creds.companyId) {
        return {
          ok: true,
          skipped: false,
          detail: `signed in as ${creds.companyName || creds.companyId}`,
          companyName: creds.companyName,
        };
      }
      await page.waitForTimeout(1_000);
    }
    throw new Error(
      `Login did not produce a localStorage token on ${NP_MERCHANT_HOST}. Check username/password, or complete a CAPTCHA/2FA once.`,
    );
  });
}

export async function ensureNewpagesLogin() {
  const site = await getSite(SITE_SLUG, { secrets: true });
  const ready = await npReady(manager());
  if (ready.ready) {
    await markSiteLogin(SITE_SLUG, { ok: true });
    return ready;
  }
  try {
    const logged = await loginNewpagesSite(site);
    await markSiteLogin(SITE_SLUG, { ok: true });
    return { ready: true, detail: logged.detail, companyName: logged.companyName };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markSiteLogin(SITE_SLUG, { ok: false, error: message });
    throw error;
  }
}

export async function newpagesStatus() {
  try {
    const ready = await npReady(manager());
    return { site: SITE_SLUG, ...ready };
  } catch (error) {
    return {
      site: SITE_SLUG,
      ready: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function newpagesNews() {
  await ensureNewpagesLogin();
  return npNewsList(manager());
}

export async function newpagesCategories() {
  await ensureNewpagesLogin();
  return npNewsCategories(manager());
}

export async function newpagesCreate(input) {
  await ensureNewpagesLogin();
  return npNewsCreate(manager(), input);
}

export async function newpagesDelete(id) {
  await ensureNewpagesLogin();
  return npNewsDelete(manager(), String(id));
}
