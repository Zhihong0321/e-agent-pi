import fs from "node:fs";
import { API_ORIGIN, apiPost, buttonByText, clearEditor, fillEditor, MERCHANT_ORIGIN, multipartText, readCreds } from "./np-shared.mjs";

const MANAGE_SERVICES_URL = `${MERCHANT_ORIGIN}/manage/services`;
const ADD_SERVICE_URL = `${MERCHANT_ORIGIN}/manage/services/add`;
const editServiceUrl = (id) => `${MERCHANT_ORIGIN}/manage/services/edit/${id}`;

const EDITOR_FRAMES = [
  'iframe[title="Rich Text Editor, editor1"]',
  'iframe[title="Rich Text Editor, editor2"]',
  'iframe[title="Rich Text Editor, editor3"]',
];
const TITLE_INPUTS = ["#for-item-name", "#for-item-name-cn", "#for-item-name-bm"];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function npServicesList(browser, { category = null } = {}) {
  return browser.runIsolated(async (ctx, page) => {
    const creds = await readCreds(page, MANAGE_SERVICES_URL);
    const data = await apiPost(ctx, creds, "services", { page: "1", num: "200", cat: category ?? "-1" });
    return {
      total: Number(data.total ?? 0),
      services: (data.services ?? []).map((s) => ({
        id: s.id,
        title: s.name,
        image: s.img || null,
        visible: s.visible === "1",
        subImages: Array.isArray(s.sub_images) ? s.sub_images.length : 0,
        sort: Number(s.npSort ?? 0),
      })),
    };
  });
}

async function npServicesCategories(browser) {
  return browser.runIsolated(async (ctx, page) => {
    const creds = await readCreds(page, MANAGE_SERVICES_URL);
    const data = await apiPost(ctx, creds, "service/categories");
    return data.allServiceCategory ?? [];
  });
}

async function npServicesTags(browser) {
  return browser.runIsolated(async (ctx, page) => {
    const creds = await readCreds(page, MANAGE_SERVICES_URL);
    const data = await apiPost(ctx, creds, "serviceTag/list");
    return {
      maxTags: Number(data.max_service_tag ?? 5),
      tags: (data.service_tag ?? []).map((t) => ({ id: t.tag_id, tag: t.tag, uses: Number(t.total ?? 0) })),
    };
  });
}

async function npServicesDetail(browser, id) {
  if (!/^\d+$/.test(String(id))) throw new Error(`service id must be numeric, got "${id}"`);
  return browser.runIsolated(async (ctx, page) => {
    const creds = await readCreds(page, MANAGE_SERVICES_URL);
    const data = await apiPost(ctx, creds, "service", { id: String(id) });
    const s = data.service ?? {};
    return {
      id: s.id,
      title: s.name ?? "",
      titleCN: s.nameCN ?? "",
      titleBM: s.nameBM ?? "",
      body: s.ckeditor_desc ?? "",
      bodyCN: s.ckeditor_descCN ?? "",
      bodyBM: s.ckeditor_descBM ?? "",
      image: s.img || null,
      categoryId: s.category_id && s.category_id !== "0" ? s.category_id : null,
      tags: String(s.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean),
      visible: s.visible === "1",
      sort: Number(s.npSort ?? 0),
    };
  });
}

async function readBackServiceForm(page) {
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
    const tagHeading = [...document.querySelectorAll(".tag-area h6")].map((el) => el.innerText.trim())[0] ?? "";
    const tagChips = [...document.querySelectorAll(".tag-area .ys-fake-textarea > *:not(input)")].map((el) => el.innerText.trim()).filter(Boolean);
    return {
      title: val("#for-item-name"),
      titleCN: val("#for-item-name-cn"),
      titleBM: val("#for-item-name-bm"),
      bodies,
      category: document.querySelector(".multiselect")?.innerText.trim() ?? "",
      tagHeading,
      tagChips,
      imageAttached: files("#image-input") > 0 || previews.length > 0,
      subImagesAttached: files("#image-input-sub"),
      imagePreview: previews.length ? { count: previews.length, sample: previews[0].src.slice(0, 60) } : null,
    };
  });
}

async function pickCategory(page, category) {
  const picker = page.locator(".multiselect").first();
  await picker.click();
  const option = page.locator(".multiselect__element", { hasText: category }).first();
  if ((await option.count()) === 0) {
    throw new Error(`category "${category}" is not on this account — run np_services_categories to see the list`);
  }
  await option.click();
}

async function addTags(page, tags) {
  const input = page.locator(".tag-area input[type=text]").first();
  for (const tag of tags) {
    await input.click();
    await input.fill(tag);
    await page.waitForTimeout(400);
    const option = page.locator(".tag-area .myDropdown a").filter({ hasText: new RegExp(`^\\s*${escapeRegExp(tag)}\\s*$`, "i") }).first();
    if ((await option.count()) === 0) {
      throw new Error(`tag "${tag}" is not in this account's tag catalog — run np_services_tags to see existing tags (new tags cannot be coined by this automation yet)`);
    }
    await option.click();
    await page.waitForTimeout(300);
  }
}

async function fillServiceForm(page, input) {
  if (input.category) await pickCategory(page, input.category);

  const titles = [input.title, input.titleCN, input.titleBM];
  const bodies = [input.body, input.bodyCN, input.bodyBM];
  for (let i = 0; i < TITLE_INPUTS.length; i++) {
    if (titles[i] !== undefined && titles[i] !== null) await page.fill(TITLE_INPUTS[i], titles[i]);
    if (bodies[i]) {
      if (input.replaceBody) await clearEditor(page, EDITOR_FRAMES[i]);
      await fillEditor(page, EDITOR_FRAMES[i], bodies[i]);
    }
  }

  if (input.tags?.length) await addTags(page, input.tags);
}

async function npServicesCreate(browser, input) {
  if (!input.title?.trim()) throw new Error("title is required");
  if (!input.imagePath) throw new Error("imagePath is required — the add form will not submit without a Service Picture");
  if (!fs.existsSync(input.imagePath)) throw new Error(`image not found: ${input.imagePath}`);
  for (const p of input.subImagePaths ?? []) {
    if (!fs.existsSync(p)) throw new Error(`sub image not found: ${p}`);
  }

  const drive = async (ctx, page) => {
    await readCreds(page, MANAGE_SERVICES_URL);
    await page.goto(ADD_SERVICE_URL, { waitUntil: "domcontentloaded", timeout: 9e4 });
    await page.waitForSelector(TITLE_INPUTS[0], { timeout: 6e4 });
    await page.setInputFiles("#image-input", input.imagePath);
    if (input.subImagePaths?.length) {
      await page.setInputFiles("#image-input-sub", input.subImagePaths);
    }
    await page.waitForTimeout(2e3);

    await fillServiceForm(page, input);

    if (input.dryRun) {
      const filled = await readBackServiceForm(page);
      await page.bringToFront().catch(() => {});
      const gaps = [
        filled.title === input.title ? "" : "title did not take",
        filled.imageAttached ? "" : "NO IMAGE attached — the form will refuse to submit",
        input.category && filled.category !== input.category ? `category reads "${filled.category}"` : "",
        input.body && !filled.bodies[0] ? "English body is empty" : "",
        input.tags?.length && filled.tagChips.length < input.tags.length
          ? `only ${filled.tagChips.length}/${input.tags.length} tags took — check the tag names against np_services_tags`
          : "",
      ].filter(Boolean);
      return {
        submitted: false,
        title: input.title,
        id: null,
        response: null,
        filled,
        detail: gaps.length
          ? `dry run — form left open on screen, nothing submitted. PROBLEMS: ${gaps.join("; ")}`
          : "dry run — form filled and verified, left open on screen; nothing was submitted",
      };
    }

    const answer = page.waitForResponse((r) => r.url().startsWith(API_ORIGIN) && r.request().method() === "POST", { timeout: 12e4 }).catch(() => null);
    await buttonByText(page, /^\s*Submit\s*$/i).first().click();
    const res = await answer;
    const responseText = res ? (await res.text().catch(() => "")).slice(0, 400) : null;
    const sent = res?.request();
    const payload = sent?.postData() ?? "";
    const submit = sent
      ? {
          endpoint: sent.url().replace(API_ORIGIN + "/", ""),
          method: sent.method(),
          contentType: (sent.headers()["content-type"] ?? "").split(";")[0],
          fields: [
            ...new Set(
              payload.includes("Content-Disposition")
                ? [...payload.matchAll(/name="([^"]+)"/g)].map((m) => m[1])
                : [...payload.matchAll(/(?:^|&)([a-z0-9_[\]]+)=/gi)].map((m) => m[1]),
            ),
          ].slice(0, 60),
          values: multipartText(payload),
          bytes: payload.length,
        }
      : null;
    await page.waitForTimeout(3e3);
    const creds = await readCreds(page, MANAGE_SERVICES_URL);
    const listed = await apiPost(ctx, creds, "services", { page: "1", num: "200", cat: "-1" }).catch(() => ({ services: [] }));
    const match = (listed.services ?? []).find((s) => s.name === input.title);
    return {
      submitted: true,
      title: input.title,
      id: match?.id ?? null,
      response: responseText,
      submit,
      detail: match
        ? `posted — it is row ${match.id} on Manage Services, status ${match.visible === "1" ? "Public" : "Hidden"}`
        : "submitted, but no row with that exact title came back from the list — check Manage Services before re-running",
    };
  };
  return input.dryRun ? browser.openTab(drive) : browser.runIsolated(drive);
}

async function npServicesEdit(browser, id, input) {
  if (!/^\d+$/.test(String(id))) throw new Error(`service id must be numeric, got "${id}"`);
  if (input.imagePath && !fs.existsSync(input.imagePath)) throw new Error(`image not found: ${input.imagePath}`);
  for (const p of input.subImagePaths ?? []) {
    if (!fs.existsSync(p)) throw new Error(`sub image not found: ${p}`);
  }

  const drive = async (ctx, page) => {
    const creds = await readCreds(page, MANAGE_SERVICES_URL);
    const before = await apiPost(ctx, creds, "services", { page: "1", num: "200", cat: "-1" });
    const row = (before.services ?? []).find((s) => s.id === String(id));
    if (!row) {
      return { updated: false, id, title: null, detail: `no service row with id ${id} on this account — nothing to edit` };
    }

    await page.goto(editServiceUrl(id), { waitUntil: "domcontentloaded", timeout: 9e4 });
    await page.waitForFunction(
      (sel) => (document.querySelector(sel)?.value ?? "").length > 0,
      TITLE_INPUTS[0],
      { timeout: 6e4 },
    );

    if (input.imagePath) await page.setInputFiles("#image-input", input.imagePath);
    if (input.subImagePaths?.length) await page.setInputFiles("#image-input-sub", input.subImagePaths);

    await fillServiceForm(page, { ...input, replaceBody: true });

    if (input.dryRun) {
      const filled = await readBackServiceForm(page);
      await page.bringToFront().catch(() => {});
      return {
        submitted: false,
        id,
        title: row.name,
        filled,
        detail: "dry run — edit form filled and left open on screen; nothing was submitted",
      };
    }

    const answer = page.waitForResponse((r) => r.url().startsWith(API_ORIGIN) && r.request().method() === "POST", { timeout: 12e4 }).catch(() => null);
    await buttonByText(page, /^\s*Submit\s*$/i).first().click();
    const res = await answer;
    const responseText = res ? (await res.text().catch(() => "")).slice(0, 400) : null;
    await page.waitForTimeout(3e3);

    const detail = await apiPost(ctx, creds, "service", { id: String(id) }).catch(() => null);
    const after = detail?.service ?? null;
    const applied = [];
    if (input.title !== undefined && after?.name === input.title) applied.push("title");
    if (input.titleCN !== undefined && after?.nameCN === input.titleCN) applied.push("titleCN");
    if (input.titleBM !== undefined && after?.nameBM === input.titleBM) applied.push("titleBM");
    if (input.body && after?.ckeditor_desc?.includes(input.body.slice(0, 40))) applied.push("body");
    return {
      submitted: true,
      id,
      title: after?.name ?? row.name,
      response: responseText,
      applied,
      detail: after ? `updated — fields confirmed changed: ${applied.join(", ") || "none matched, check manually"}` : "submitted, but could not re-fetch the record to verify — check Manage Services",
    };
  };
  return input.dryRun ? browser.openTab(drive) : browser.runIsolated(drive);
}

async function npServicesSetVisibility(browser, id, visible) {
  if (!/^\d+$/.test(String(id))) throw new Error(`service id must be numeric, got "${id}"`);
  return browser.runIsolated(async (ctx, page) => {
    const creds = await readCreds(page, MANAGE_SERVICES_URL);
    const before = await apiPost(ctx, creds, "services", { page: "1", num: "200", cat: "-1" });
    const row = (before.services ?? []).find((s) => s.id === String(id));
    if (!row) {
      return { toggled: false, id, title: null, detail: `no service row with id ${id} on this account` };
    }
    const currentlyVisible = row.visible === "1";
    if (currentlyVisible === visible) {
      return { toggled: false, id, title: row.name, visible: currentlyVisible, detail: `already ${visible ? "Public" : "Hidden"} — nothing to do` };
    }

    await page.goto(MANAGE_SERVICES_URL, { waitUntil: "domcontentloaded", timeout: 9e4 });
    const tr = page.locator("tr[role=row]").filter({ has: page.locator(`input[type=checkbox][value="${id}"]`) });
    await tr.waitFor({ timeout: 6e4 });
    const toggle = tr.locator('div[title="Hide"], div[title="Show"]').first();
    await toggle.waitFor({ timeout: 2e4 });
    await toggle.click();

    const modal = page.locator(".swal2-popup.swal2-show");
    await modal.waitFor({ timeout: 2e4 });
    const prompt = (await modal.innerText()).replace(/\s+/g, " ");
    if (!prompt.includes(row.name.replace(/\s+/g, " "))) {
      throw new Error(`refusing to confirm: the dialog names something other than "${row.name}" — it says: ${prompt.slice(0, 160)}`);
    }
    await page.locator(".swal2-confirm:visible").click({ timeout: 2e4 });
    await page.waitForTimeout(2e3);

    const after = await apiPost(ctx, creds, "services", { page: "1", num: "200", cat: "-1" });
    const row2 = (after.services ?? []).find((s) => s.id === String(id));
    const nowVisible = row2?.visible === "1";
    return {
      toggled: nowVisible === visible,
      id,
      title: row.name,
      visible: nowVisible,
      detail: nowVisible === visible
        ? `${row.name} (id ${id}) is now ${visible ? "Public" : "Hidden"}`
        : `clicked the toggle on "${row.name}" (id ${id}) but it still reads ${nowVisible ? "Public" : "Hidden"} — check Manage Services`,
    };
  });
}

export {
  npServicesList,
  npServicesCategories,
  npServicesTags,
  npServicesDetail,
  npServicesCreate,
  npServicesEdit,
  npServicesSetVisibility,
};
