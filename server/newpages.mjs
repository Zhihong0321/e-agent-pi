import { browserManager } from "./browser.mjs";
import { getSite, markSiteLogin, NEWPAGES_SITE_SLUG, saveSiteSession } from "./sites.mjs";
import { diagnoseNewpagesLogin, parseNewpagesLoginApi } from "./newpages/login-diagnose.mjs";
import {
  NP_MERCHANT_HOST,
  npNewsCategories,
  npNewsCreate,
  npNewsDelete,
  npNewsList,
  npReady,
} from "./newpages/npmerchant.mjs";
import {
  npServicesCategories,
  npServicesCreate,
  npServicesDetail,
  npServicesEdit,
  npServicesList,
  npServicesSetVisibility,
  npServicesTags,
} from "./newpages/npservices.mjs";

const SITE_SLUG = NEWPAGES_SITE_SLUG;
const MERCHANT_ORIGIN = `https://${NP_MERCHANT_HOST}`;
const RECAPTCHA_SITE_KEY = "6LfEunkiAAAAAOn6IzpO3byUk1OBayBLvMgc17_-";

function manager() {
  return browserManager(SITE_SLUG);
}

function sessionFromSite(site) {
  const session = site?.extra?.session;
  if (!session?.token || !session?.companyId) return null;
  return session;
}

async function fillVueInput(page, selector, value) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: "visible", timeout: 45_000 });
  await loc.click();
  await loc.fill(value);
  await loc.evaluate((el, next) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, next);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function readLoginState(page) {
  return page.evaluate(() => ({
    href: location.href,
    token: localStorage.getItem("token") || "",
    companyId: localStorage.getItem("company_id") || "",
    companyName: localStorage.getItem("company_name") || "",
    npCompanyId: localStorage.getItem("np_company_id") || "",
    otpToken: localStorage.getItem("otp_token") || "",
    authError: [...document.querySelectorAll(".alert-danger, .alert.alert-danger")]
      .map((el) => (el.innerText || "").trim())
      .find(Boolean) || "",
    invalidUser: Boolean(document.querySelector("#username.is-invalid")),
    invalidPass: Boolean(document.querySelector("#password.is-invalid")),
    usernameEmpty: !(document.querySelector("#username")?.value || "").trim(),
  }));
}

async function waitForSession(page, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readLoginState(page);
    if (state.token && state.companyId) return state;
    if (state.otpToken || /\/otp\b/i.test(state.href)) return state;
    await page.waitForTimeout(500);
  }
  return readLoginState(page);
}

async function hydrateProfile(site) {
  const session = sessionFromSite(site);
  if (!session) return false;
  return manager().runIsolated(async (_ctx, page) => {
    await page.goto(site.origin || MERCHANT_ORIGIN, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const existing = await page.evaluate(() => localStorage.getItem("token") || "");
    if (existing) return true;
    await page.evaluate((snap) => {
      localStorage.setItem("token", snap.token);
      localStorage.setItem("company_id", snap.companyId);
      if (snap.companyName) localStorage.setItem("company_name", snap.companyName);
      if (snap.npCompanyId) localStorage.setItem("np_company_id", snap.npCompanyId);
    }, session);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    return true;
  });
}

async function persistSession(state) {
  if (!state?.token || !state?.companyId) return;
  await saveSiteSession(SITE_SLUG, state);
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
  const result = await browser.runIsolated(async (_ctx, page) => {
    await page.goto(login.loginUrl || login.origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const existing = await readLoginState(page);
    if (existing.token && existing.companyId) {
      return { ok: true, skipped: true, detail: "already signed in (token in profile)", session: existing };
    }

    await fillVueInput(page, "#username", login.username);
    await fillVueInput(page, "#password", login.password);

    await page
      .evaluate(async (siteKey) => {
        const grecaptcha = window.grecaptcha;
        if (!grecaptcha?.ready || !grecaptcha.execute) return "";
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("grecaptcha.ready timeout")), 12_000);
          grecaptcha.ready(() => {
            clearTimeout(timer);
            resolve();
          });
        });
        return grecaptcha.execute(siteKey, { action: "submit" });
      }, RECAPTCHA_SITE_KEY)
      .catch(() => "");

    const loginResponse = page.waitForResponse(
      (res) => {
        try {
          const url = new URL(res.url());
          return res.request().method() === "POST" && url.pathname === "/login";
        } catch {
          return false;
        }
      },
      { timeout: 45_000 },
    );

    const submit = page.locator("#button").first();
    if ((await submit.count()) > 0) {
      await submit.click();
    } else {
      await page.locator("#password").press("Enter");
    }

    let loginApi = null;
    const response = await loginResponse.catch(() => null);
    if (response) {
      const body = await response.json().catch(() => null);
      loginApi = parseNewpagesLoginApi(body);
      if (loginApi.hasToken) {
        const token = body?.data?.token;
        const companyMissing = !(await page.evaluate(() => localStorage.getItem("company_id") || ""));
        if (token && companyMissing) {
          await page.evaluate((value) => localStorage.setItem("token", value), token);
          await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
        }
      }
    }

    const state = await waitForSession(page, 30_000);
    if (state.token && state.companyId) {
      return {
        ok: true,
        skipped: false,
        detail: `signed in as ${state.companyName || state.companyId}`,
        companyName: state.companyName,
        session: state,
      };
    }
    throw new Error(diagnoseNewpagesLogin({ ...state, loginApi }) || `Login did not produce a localStorage token on ${NP_MERCHANT_HOST}.`);
  });
  if (result.session) await persistSession(result.session);
  const { session: _session, ...publicResult } = result;
  return publicResult;
}

export async function ensureNewpagesLogin() {
  const site = await getSite(SITE_SLUG, { secrets: true });
  await hydrateProfile(site).catch(() => false);
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
    const site = await getSite(SITE_SLUG, { secrets: true });
    await hydrateProfile(site).catch(() => false);
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

export async function newpagesServices(options) {
  await ensureNewpagesLogin();
  return npServicesList(manager(), options);
}

export async function newpagesServiceCategories() {
  await ensureNewpagesLogin();
  return npServicesCategories(manager());
}

export async function newpagesServiceTags() {
  await ensureNewpagesLogin();
  return npServicesTags(manager());
}

export async function newpagesServiceDetail(id) {
  await ensureNewpagesLogin();
  return npServicesDetail(manager(), id);
}

export async function newpagesServiceCreate(input) {
  await ensureNewpagesLogin();
  return npServicesCreate(manager(), input);
}

export async function newpagesServiceEdit(id, input) {
  await ensureNewpagesLogin();
  return npServicesEdit(manager(), id, input);
}

export async function newpagesServiceSetVisibility(id, visible) {
  await ensureNewpagesLogin();
  return npServicesSetVisibility(manager(), id, visible);
}
