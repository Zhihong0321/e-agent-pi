import fs from "node:fs";
import { API_ORIGIN, apiPost, buttonByText, fillEditor, MERCHANT_ORIGIN, multipartText, NP_MERCHANT_HOST, npReady, readCreds, stamp } from "./np-shared.mjs";

export { npReady };

const MANAGE_NEWS_URL = `${MERCHANT_ORIGIN}/manage/news`;
const ADD_NEWS_URL = `${MERCHANT_ORIGIN}/manage/news/add`;
async function npNewsList(browser) {
  return browser.runIsolated(async (ctx, page) => {
    const creds = await readCreds(page, MANAGE_NEWS_URL);
    const data = await apiPost(ctx, creds, "newses");
    return {
      total: Number(data.total ?? 0),
      news: (data.news ?? []).map((n) => ({
        id: n.id,
        title: n.name,
        image: n.img || null,
        visible: n.visible === "1",
        subImages: Array.isArray(n.sub_images) ? n.sub_images.length : 0,
        sort: Number(n.sort ?? 0),
        createdAt: stamp(n.created_date),
        postedAt: stamp(n.real_date)
      }))
    };
  });
}
async function npNewsCategories(browser) {
  return browser.runIsolated(async (ctx, page) => {
    const creds = await readCreds(page, MANAGE_NEWS_URL);
    const data = await apiPost(ctx, creds, "news/categories");
    return data.allNewsCategory ?? [];
  });
}
const EDITOR_FRAMES = [
  'iframe[title="Rich Text Editor, editor1"]',
  'iframe[title="Rich Text Editor, editor2"]',
  'iframe[title="Rich Text Editor, editor3"]'
];
const TITLE_INPUTS = ["#for-item-name", "#for-item-name-cn", "#for-item-name-bm"];
const LANGUAGE_TABS = [/English/i, /Chinese/i, /Melayu/i];
const TAB = 'a[role="tab"]';
async function readBackForm(page) {
  return page.evaluate(() => {
    const val = (sel) => document.querySelector(sel)?.value ?? "";
    const files = (sel) => document.querySelector(sel)?.files?.length ?? 0;
    const bodies = [...document.querySelectorAll("iframe.cke_wysiwyg_frame")].map((f) => {
      try {
        return (f.contentDocument?.body.innerText ?? "").trim();
      } catch {
        return "[unreadable]";
      }
    });
    const box = document.querySelector("#image-input")?.closest(".form-group, .row, .col, .card-body") ?? null;
    const previews = box ? [...box.querySelectorAll("img")] : [];
    return {
      title: val("#for-item-name"),
      titleCN: val("#for-item-name-cn"),
      titleBM: val("#for-item-name-bm"),
      bodies,
      category: document.querySelector(".multiselect")?.innerText.trim() ?? "",
      date: val("input.mx-input"),
      imageAttached: files("#image-input") > 0 || previews.length > 0,
      subImagesAttached: files("#image-input-sub"),
      imagePreview: previews.length ? { count: previews.length, sample: previews[0].src.slice(0, 60) } : null
    };
  });
}
async function npNewsCreate(browser, input) {
  if (!input.title?.trim()) throw new Error("title is required");
  if (!input.imagePath) throw new Error("imagePath is required \u2014 the add form will not submit without a main image");
  if (!fs.existsSync(input.imagePath)) throw new Error(`image not found: ${input.imagePath}`);
  for (const p of input.subImagePaths ?? []) {
    if (!fs.existsSync(p)) throw new Error(`sub image not found: ${p}`);
  }
  const drive = async (ctx, page) => {
    await readCreds(page, MANAGE_NEWS_URL);
    await page.goto(ADD_NEWS_URL, { waitUntil: "domcontentloaded", timeout: 9e4 });
    await page.waitForSelector(TITLE_INPUTS[0], { timeout: 6e4 });
    await page.setInputFiles("#image-input", input.imagePath);
    if (input.subImagePaths?.length) {
      await page.setInputFiles("#image-input-sub", input.subImagePaths);
    }
    await page.waitForTimeout(2e3);
    if (input.category) {
      const picker = page.locator(".multiselect").first();
      await picker.click();
      const option = page.locator(".multiselect__element", { hasText: input.category }).first();
      if (await option.count() === 0) {
        throw new Error(`category "${input.category}" is not on this account \u2014 run np_news_categories to see the list`);
      }
      await option.click();
    }
    const titles = [input.title, input.titleCN, input.titleBM];
    const bodies = [input.body, input.bodyCN, input.bodyBM];
    for (let i = 0; i < LANGUAGE_TABS.length; i++) {
      if (!titles[i] && !bodies[i]) continue;
      if (i > 0) {
        await page.locator(TAB).filter({ hasText: LANGUAGE_TABS[i] }).first().click();
        await page.waitForTimeout(500);
      }
      if (titles[i]) await page.fill(TITLE_INPUTS[i], titles[i]);
      if (bodies[i]) await fillEditor(page, EDITOR_FRAMES[i], bodies[i]);
    }
    await page.locator(TAB).filter({ hasText: LANGUAGE_TABS[0] }).first().click();
    await page.waitForTimeout(500);
    if (input.dryRun) {
      const filled = await readBackForm(page);
      await page.bringToFront().catch(() => {
      });
      const gaps = [
        filled.title === input.title ? "" : "title did not take",
        filled.imageAttached ? "" : "NO IMAGE attached \u2014 the form will refuse to submit",
        input.category && filled.category !== input.category ? `category reads "${filled.category}"` : "",
        input.body && !filled.bodies[0] ? "English body is empty" : ""
      ].filter(Boolean);
      return {
        submitted: false,
        title: input.title,
        id: null,
        response: null,
        filled,
        detail: gaps.length ? `dry run \u2014 form left open on screen, nothing submitted. PROBLEMS: ${gaps.join("; ")}` : "dry run \u2014 form filled and verified, left open on screen; nothing was submitted"
      };
    }
    const answer = page.waitForResponse((r) => r.url().startsWith(API_ORIGIN) && r.request().method() === "POST", { timeout: 12e4 }).catch(() => null);
    await buttonByText(page, /^\s*Submit\s*$/i).first().click();
    const res = await answer;
    const responseText = res ? (await res.text().catch(() => "")).slice(0, 400) : null;
    const sent = res?.request();
    const payload = sent?.postData() ?? "";
    const submit = sent ? {
      endpoint: sent.url().replace(API_ORIGIN + "/", ""),
      method: sent.method(),
      contentType: (sent.headers()["content-type"] ?? "").split(";")[0],
      sentRecaptcha: /g-recaptcha-response|recaptcha/i.test(payload),
      // The UI posts multipart (it carries the image), so field names come from the
      // part headers. The urlencoded form is still parsed as a fallback, because
      // the endpoint may well accept either and this trace should survive that.
      fields: [
        ...new Set(
          payload.includes("Content-Disposition") ? [...payload.matchAll(/name="([^"]+)"/g)].map((m) => m[1]) : [...payload.matchAll(/(?:^|&)([a-z0-9_[\]]+)=/gi)].map((m) => m[1])
        )
      ].slice(0, 60),
      values: multipartText(payload),
      bytes: payload.length
    } : null;
    await page.waitForTimeout(3e3);
    const creds = await readCreds(page, MANAGE_NEWS_URL);
    const listed = await apiPost(ctx, creds, "newses").catch(() => ({ news: [] }));
    const match = (listed.news ?? []).find((n) => n.name === input.title);
    return {
      submitted: true,
      title: input.title,
      id: match?.id ?? null,
      response: responseText,
      submit,
      detail: match ? `posted \u2014 it is row ${match.id} on Manage Latest News, status ${match.visible === "1" ? "Public" : "Hidden"}` : "submitted, but no row with that exact title came back from the list \u2014 check Manage Latest News before re-running"
    };
  };
  return input.dryRun ? browser.openTab(drive) : browser.runIsolated(drive);
}
async function npNewsDelete(browser, id) {
  if (!/^\d+$/.test(id)) throw new Error(`news id must be numeric, got "${id}"`);
  return browser.runIsolated(async (ctx, page) => {
    const creds = await readCreds(page, MANAGE_NEWS_URL);
    const before = await apiPost(ctx, creds, "newses");
    const row = (before.news ?? []).find((n) => n.id === id);
    if (!row) {
      return { deleted: false, id, title: null, detail: `no news row with id ${id} on this account \u2014 nothing to delete` };
    }
    await page.goto(MANAGE_NEWS_URL, { waitUntil: "domcontentloaded", timeout: 9e4 });
    const card = page.locator(".ys-card").filter({ has: page.locator(`input[type=checkbox][value="${id}"]`) });
    await card.waitFor({ timeout: 6e4 });
    await card.locator(".each-action.red").click();
    const dialog = page.locator(".modal.show:visible");
    await dialog.waitFor({ timeout: 2e4 });
    const prompt = (await dialog.innerText()).replace(/\s+/g, " ");
    if (!prompt.includes(row.name.replace(/\s+/g, " "))) {
      throw new Error(
        `refusing to confirm: the dialog names something other than "${row.name}" \u2014 it says: ${prompt.slice(0, 160)}`
      );
    }
    const confirm = buttonByText(page, /^\s*(confirm|yes|ok|delete)\s*$/i).first();
    await confirm.waitFor({ timeout: 2e4 });
    await confirm.click();
    await page.waitForTimeout(3e3);
    const after = await apiPost(ctx, creds, "newses");
    const gone = !(after.news ?? []).some((n) => n.id === id);
    return {
      deleted: gone,
      id,
      title: row.name,
      detail: gone ? `deleted "${row.name}" (id ${id}) \u2014 ${(after.news ?? []).length} rows left` : `clicked delete on "${row.name}" (id ${id}) but it is STILL on the list \u2014 check Manage Latest News`
    };
  });
}
export {
  NP_MERCHANT_HOST,
  npNewsCategories,
  npNewsCreate,
  npNewsDelete,
  npNewsList
};
