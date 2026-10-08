// How a company has chosen to show a /demo page. The DEFAULT layout lives here, in code. A company's
// choices are stored as a small override (di.ui_config) holding only what it changed, so:
//   * "restore default" just removes the override;
//   * improvements to the default (a new tile, a better label) still reach companies that changed
//     something else, because the override is applied on top of whatever the default is today;
//   * the page looks only; rules (required fields, categories, limits) stay in the policy tables.
// An override is data from a closed vocabulary (show/hide, order, rename). Nothing here runs tenant code.
import { DiError } from "./common.mjs";

const ID = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_LABEL = 40;
const MAX_LIST = 20;
const MAX_BYTES = 4096;
const BLOCK_KEYS = ["order", "hidden", "labels"];

/**
 * Every page that can be customized. A block is a list of items the page draws; an item that is
 * `locked` can be renamed but never hidden (the page needs it), `pinned` always stays first.
 * `rev` goes up when the default changes in a way worth noting.
 */
export const PAGES = {
  expenses: {
    rev: 1,
    kicker: "EXPENSE CLAIMS",
    blocks: {
      tiles: {
        reorder: true,
        items: [
          { id: "claims", label: "Claims" },
          { id: "claimed", label: "Claimed" },
          { id: "approved", label: "Approved" },
          { id: "pending", label: "Pending" },
          { id: "rejected", label: "Rejected" },
        ],
      },
      columns: {
        reorder: true,
        items: [
          { id: "claim", label: "Claim", locked: true, pinned: true },
          { id: "claimant", label: "Claimant" },
          { id: "date", label: "Date" },
          { id: "merchant", label: "Merchant" },
          { id: "category", label: "Category" },
          { id: "amount", label: "Amount", locked: true },
          { id: "status", label: "Status", locked: true },
        ],
      },
      // Ids are claim statuses; a label here also names the status badge, so the two never disagree.
      chips: {
        reorder: true,
        items: [
          { id: "all", label: "All", locked: true },
          { id: "submitted", label: "Pending" },
          { id: "approved", label: "Approved" },
          { id: "rejected", label: "Rejected" },
        ],
      },
      detail: {
        reorder: true,
        items: [
          { id: "claimant", label: "Claimant" },
          { id: "date", label: "Receipt date" },
          { id: "category", label: "Category" },
          { id: "tax", label: "Tax" },
          { id: "paid_by", label: "Paid by" },
          { id: "description", label: "For" },
          { id: "submission", label: "Submission" },
          { id: "reviewed_by", label: "Reviewed by" },
          { id: "review_note", label: "Reviewer note" },
          { id: "no_receipt", label: "No receipt" },
        ],
      },
      // The filing form keeps its order: its fields sit in fixed pairs. `{currency}` is filled in by the page.
      form: {
        reorder: false,
        items: [
          { id: "claimant", label: "Claimant", locked: true },
          { id: "date", label: "Date on receipt", locked: true },
          { id: "amount", label: "Total ({currency})", locked: true },
          { id: "merchant", label: "Merchant", locked: true },
          { id: "category", label: "Category", locked: true },
          { id: "payment_method", label: "Paid by" },
          { id: "tax_amount", label: "Tax shown (optional)" },
          { id: "description", label: "What was it for?" },
          { id: "receipts", label: "Add receipt (photo, screenshot or PDF)", locked: true },
        ],
      },
    },
  },
};

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function pageDef(page, pages = PAGES) {
  const def = pages[page];
  if (!def) throw new DiError(`Page "${page}" cannot be customized. Customizable pages: ${Object.keys(pages).join(", ")}`);
  return def;
}

function requireAdmin(who) {
  if (!who?.id) throw new DiError("Sign-in required to customize a page.");
  if (who.role !== "admin") throw new DiError("Only an admin can customize this page.");
  return who;
}

// ---------------------------------------------------------------- labels

const hasControl = (text) => Array.from(text).some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);

/** A label is plain text, trimmed, 1 to 40 characters, no control characters. Returns null when it isn't one. */
function labelOf(value) {
  if (typeof value !== "string" || hasControl(value)) return null;
  const text = value.trim();
  return text && text.length <= MAX_LABEL ? text : null;
}

function strictLabel(value, where) {
  if (typeof value !== "string") throw new DiError(`${where} must be text`);
  if (hasControl(value)) throw new DiError(`${where} cannot contain line breaks or control characters`);
  const text = value.trim();
  if (!text) throw new DiError(`${where} cannot be empty`);
  if (text.length > MAX_LABEL) throw new DiError(`${where} is too long (at most ${MAX_LABEL} characters)`);
  return text;
}

// ---------------------------------------------------------------- resolve (lenient: used on every read)

/** One block's items in display order, with the override applied. Ignores anything it can't use. */
function resolveBlock(block, ov) {
  const known = new Map(block.items.map((item) => [item.id, item]));
  const order = [];
  const seen = new Set();
  if (block.reorder && Array.isArray(ov?.order)) {
    for (const id of ov.order) {
      if (typeof id === "string" && known.has(id) && !seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
  }
  // Items the override doesn't mention (a newly added default, say) follow in the default order.
  for (const item of block.items) if (!seen.has(item.id)) order.push(item.id);
  const pinned = block.items.filter((item) => item.pinned).map((item) => item.id);
  const ids = [...pinned, ...order.filter((id) => !pinned.includes(id))];

  const hidden = new Set(
    Array.isArray(ov?.hidden) ? ov.hidden.filter((id) => typeof id === "string" && known.has(id) && !known.get(id).locked) : [],
  );
  const labels = isObject(ov?.labels) ? ov.labels : {};
  return {
    reorder: block.reorder,
    items: ids.map((id) => {
      const item = known.get(id);
      return {
        id,
        label: (Object.hasOwn(labels, id) ? labelOf(labels[id]) : null) ?? item.label,
        default_label: item.label,
        visible: !hidden.has(id),
        locked: Boolean(item.locked),
        pinned: Boolean(item.pinned),
      };
    }),
  };
}

/**
 * The layout a page should draw: the default with the override applied. Never throws; anything in
 * the override that no longer fits the default is ignored (use validateOverride to find out).
 * @param {string} page
 * @param {object | null | undefined} override
 */
export function resolveLayout(page, override, pages = PAGES) {
  const def = pageDef(page, pages);
  const ov = isObject(override) ? override : {};
  return {
    page,
    default_rev: def.rev,
    kicker: { value: labelOf(ov.kicker) ?? def.kicker, default: def.kicker },
    blocks: Object.fromEntries(Object.entries(def.blocks).map(([name, block]) => [name, resolveBlock(block, isObject(ov[name]) ? ov[name] : undefined)])),
  };
}

// ---------------------------------------------------------------- validate (strict: used on save)

function idList(value, block, where, { allowLocked }) {
  if (!Array.isArray(value)) throw new DiError(`${where} must be a list`);
  if (value.length > MAX_LIST) throw new DiError(`${where} has too many entries (at most ${MAX_LIST})`);
  const known = new Map(block.items.map((item) => [item.id, item]));
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== "string" || !ID.test(id) || !known.has(id)) {
      throw new DiError(`${where} names "${String(id).slice(0, 40)}", which is not on this page. Use: ${block.items.map((i) => i.id).join(", ")}`);
    }
    if (seen.has(id)) throw new DiError(`${where} lists "${id}" twice`);
    if (!allowLocked && known.get(id).locked) throw new DiError(`${known.get(id).label} cannot be hidden: the page needs it`);
    seen.add(id);
  }
  return value;
}

/**
 * Checks a company's choices and returns them in their smallest form: anything equal to the default
 * is dropped, so `{}` means "no changes" and the page counts as not customized.
 * @param {string} page
 * @param {unknown} input
 * @returns {object} the normalised override
 */
export function validateOverride(page, input, pages = PAGES) {
  const def = pageDef(page, pages);
  if (!isObject(input)) throw new DiError("The page settings must be an object");
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_BYTES) throw new DiError(`The page settings are too large (at most ${MAX_BYTES} bytes)`);
  const allowed = ["kicker", ...Object.keys(def.blocks)];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new DiError(`"${key}" is not a setting of this page. Use: ${allowed.join(", ")}`);

  const out = {};
  if (input.kicker !== undefined) {
    const kicker = strictLabel(input.kicker, "The page heading");
    if (kicker !== def.kicker) out.kicker = kicker;
  }
  for (const [name, block] of Object.entries(def.blocks)) {
    const ov = input[name];
    if (ov === undefined) continue;
    if (!isObject(ov)) throw new DiError(`${name} must be an object`);
    for (const key of Object.keys(ov)) if (!BLOCK_KEYS.includes(key)) throw new DiError(`${name} has no setting "${key}". Use: ${BLOCK_KEYS.join(", ")}`);
    if (ov.order !== undefined && !block.reorder) throw new DiError(`${name} cannot be reordered`);

    const result = {};
    if (ov.order !== undefined) {
      idList(ov.order, block, `${name}.order`, { allowLocked: true });
      const effective = resolveBlock(block, { order: ov.order }).items.map((item) => item.id);
      if (effective.join() !== block.items.map((item) => item.id).join()) result.order = effective;
    }
    if (ov.hidden !== undefined) {
      idList(ov.hidden, block, `${name}.hidden`, { allowLocked: false });
      const hidden = block.items.map((item) => item.id).filter((id) => ov.hidden.includes(id));
      if (hidden.length) result.hidden = hidden;
    }
    if (ov.labels !== undefined) {
      if (!isObject(ov.labels)) throw new DiError(`${name}.labels must be an object`);
      const labels = {};
      for (const item of block.items) {
        if (!Object.hasOwn(ov.labels, item.id)) continue;
        const text = strictLabel(ov.labels[item.id], `The name for ${item.label}`);
        if (text !== item.label) labels[item.id] = text;
      }
      for (const id of Object.keys(ov.labels)) {
        if (!block.items.some((item) => item.id === id)) throw new DiError(`${name}.labels names "${id.slice(0, 40)}", which is not on this page`);
      }
      if (Object.keys(labels).length) result.labels = labels;
    }
    if (Object.keys(result).length) out[name] = result;
  }
  return out;
}

// ---------------------------------------------------------------- storage

const conflict = () => new DiError("Someone else changed this page. Reload and try again.");

/**
 * What `page` should look like for the current company, plus where it stands.
 * @param {{ query: Function }} tx a transaction scoped to one company (withContext)
 * @returns {Promise<ReturnType<typeof resolveLayout> & { rev: number, customized: boolean, override_invalid: boolean }>}
 */
export async function loadLayout(tx, page, pages = PAGES) {
  pageDef(page, pages);
  const row = (
    await tx.query("SELECT rev, config FROM di.ui_config WHERE tenant_id = di.current_tenant() AND page = $1 AND deleted_at IS NULL", [page])
  ).rows[0];
  const layout = resolveLayout(page, row?.config, pages);
  if (!row) return { ...layout, rev: 0, customized: false, override_invalid: false };
  let normalised = null;
  try {
    normalised = validateOverride(page, row.config, pages);
  } catch {
    // Stale or damaged: the page still draws (whatever still fits is applied) and the admin is told.
  }
  return { ...layout, rev: row.rev, customized: normalised ? Object.keys(normalised).length > 0 : true, override_invalid: normalised === null };
}

/**
 * Admin only. `expected_rev` is the rev the editor was opened on (0 when the page was on the default).
 * Saving choices that equal the default is the same as restoring it.
 */
export async function saveLayout(tx, page, input, { who, expected_rev, pages = PAGES } = {}) {
  requireAdmin(who);
  const config = validateOverride(page, input, pages);
  if (!Number.isInteger(expected_rev) || expected_rev < 0) throw new DiError("expected_rev is required (the revision you started from)");
  const active = (
    await tx.query("SELECT id, rev FROM di.ui_config WHERE tenant_id = di.current_tenant() AND page = $1 AND deleted_at IS NULL", [page])
  ).rows[0];
  if ((active?.rev ?? 0) !== expected_rev) throw conflict();

  if (!Object.keys(config).length) {
    if (active) await tx.query("UPDATE di.ui_config SET deleted_at = now() WHERE id = $1", [active.id]);
    return { layout: await loadLayout(tx, page, pages), restored: Boolean(active) };
  }
  const json = JSON.stringify(config);
  const defaultRev = pageDef(page, pages).rev;
  if (active) {
    const { rows } = await tx.query(
      "UPDATE di.ui_config SET config = $1::jsonb, rev = rev + 1, default_rev = $2 WHERE id = $3 AND rev = $4 RETURNING id",
      [json, defaultRev, active.id, expected_rev],
    );
    if (rows.length === 0) throw conflict();
  } else {
    try {
      await tx.query("INSERT INTO di.ui_config (page, config, default_rev) VALUES ($1, $2::jsonb, $3)", [page, json, defaultRev]);
    } catch (error) {
      if (error?.code === "23505") throw conflict();
      throw error;
    }
  }
  return { layout: await loadLayout(tx, page, pages), restored: false };
}

/** Admin only. Puts the page back on the default; the old choices stay behind as history. */
export async function resetLayout(tx, page, { who, pages = PAGES } = {}) {
  requireAdmin(who);
  pageDef(page, pages);
  const { rows } = await tx.query(
    "UPDATE di.ui_config SET deleted_at = now() WHERE tenant_id = di.current_tenant() AND page = $1 AND deleted_at IS NULL RETURNING id",
    [page],
  );
  return { layout: await loadLayout(tx, page, pages), reset: rows.length > 0 };
}
