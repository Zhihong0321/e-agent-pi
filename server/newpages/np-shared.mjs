export const NP_MERCHANT_HOST = "merchant.newpages.com.my";
export const MERCHANT_ORIGIN = `https://${NP_MERCHANT_HOST}`;
export const API_ORIGIN = "https://server.newpages.com.my";

export async function readCreds(page, landingUrl = MERCHANT_ORIGIN) {
  if (!page.url().startsWith(MERCHANT_ORIGIN)) {
    await page.goto(landingUrl, { waitUntil: "domcontentloaded", timeout: 6e4 });
  }
  const creds = await page.evaluate(() => ({
    token: localStorage.getItem("token") ?? "",
    companyId: localStorage.getItem("company_id") ?? "",
    companyName: localStorage.getItem("company_name") ?? "",
    npCompanyId: localStorage.getItem("np_company_id") ?? "",
  }));
  if (!creds.token || !creds.companyId) {
    throw new Error(
      `Not signed in to ${NP_MERCHANT_HOST} — no token in localStorage. Save the merchant username/password on Settings → Sites and run: node "$CLOUD_PI_SITES" login newpages`,
    );
  }
  return creds;
}

export async function npReady(browser) {
  return browser.runIsolated(async (_ctx, page) => {
    try {
      const c = await readCreds(page);
      return { ready: true, companyName: c.companyName, detail: `signed in as ${c.companyName} (company_id=${c.companyId})` };
    } catch (err) {
      return { ready: false, detail: err instanceof Error ? err.message : String(err) };
    }
  });
}

export async function apiPost(ctx, creds, path, fields = {}) {
  const res = await ctx.request.post(`${API_ORIGIN}/${path}`, {
    form: { token: creds.token, company_id: creds.companyId, ...fields },
    timeout: 3e4,
  });
  if (!res.ok()) throw new Error(`${path} returned HTTP ${res.status()}`);
  const body = await res.json();
  if (body.error === void 0) throw new Error(`${path} returned an unrecognised body: ${JSON.stringify(body).slice(0, 200)}`);
  if (String(body.error) !== "0") {
    const detail = Array.isArray(body.data) ? body.data.join("; ") : JSON.stringify(body.data ?? {}).slice(0, 200);
    throw new Error(`${path} refused the request: ${detail}`);
  }
  return body.data;
}

export const stamp = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1e3).toISOString() : "";
};

export const buttonByText = (page, text) => page.locator("button:visible").filter({ hasText: text });

export function multipartText(payload) {
  const out = {};
  const boundary = payload.match(/^(--[^\r\n]+)\r?\n/)?.[1];
  if (!boundary) return out;
  for (const part of payload.split(boundary)) {
    const split = part.indexOf("\r\n\r\n");
    if (split < 0) continue;
    const headers = part.slice(0, split);
    if (/filename=/i.test(headers)) continue;
    const name = headers.match(/name="([^"]+)"/)?.[1];
    if (!name) continue;
    out[name] = part.slice(split + 4).replace(/\r?\n--?$/, "").slice(0, 200);
  }
  return out;
}

export async function fillEditor(page, frameSel, text) {
  const body = page.frameLocator(frameSel).locator("body");
  await body.click({ timeout: 15e3 });
  await page.keyboard.insertText(text);
}

export async function clearEditor(page, frameSel) {
  const body = page.frameLocator(frameSel).locator("body");
  await body.click({ timeout: 15e3 });
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
}
