import { getPool } from "./db.mjs";

export async function ensureStockSchema() {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_items (
      product_key TEXT PRIMARY KEY,
      model_name TEXT NOT NULL,
      qty_on_hand NUMERIC NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT 'pcs',
      notes TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS stock_movements (
      id BIGSERIAL PRIMARY KEY,
      product_key TEXT NOT NULL,
      model_name TEXT NOT NULL,
      delta NUMERIC NOT NULL,
      qty_after NUMERIC NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by TEXT
    );
    CREATE INDEX IF NOT EXISTS stock_movements_product_idx ON stock_movements (product_key, created_at DESC);
  `);
}

function slugifyKey(value) {
  const slug = String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return slug || "item";
}

const STOCK_SELECT = `product_key AS "productKey", model_name AS "modelName", qty_on_hand AS "qtyOnHand",
  unit, notes, updated_at AS "updatedAt", updated_by AS "updatedBy"`;

export async function listStockItems() {
  const result = await getPool().query(`SELECT ${STOCK_SELECT} FROM stock_items ORDER BY model_name ASC`);
  return result.rows;
}

export async function getStockItem(productKey) {
  const key = slugifyKey(productKey);
  const result = await getPool().query(`SELECT ${STOCK_SELECT} FROM stock_items WHERE product_key = $1`, [key]);
  return result.rows[0] ?? null;
}

/**
 * Absolute set: records the resulting on-hand qty and logs the delta from the previous value.
 * @param {{ productKey?: string; modelName?: string; qty: number|string; unit?: string; notes?: string; updatedBy?: string; reason?: string }} input
 */
export async function setStockItem({ productKey, modelName, qty, unit, notes, updatedBy, reason }) {
  const key = slugifyKey(productKey || modelName);
  const name = String(modelName || productKey || key).trim();
  const qtyNum = Number(qty);
  if (!Number.isFinite(qtyNum)) throw new Error("qty must be a number");
  const pool = getPool();
  const previous = await getStockItem(key);
  const previousQty = previous ? Number(previous.qtyOnHand) : 0;
  const nextUnit = unit || previous?.unit || "pcs";
  const nextNotes = notes ?? previous?.notes ?? "";
  await pool.query(
    `INSERT INTO stock_items (product_key, model_name, qty_on_hand, unit, notes, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, NOW(), $6)
     ON CONFLICT (product_key) DO UPDATE SET
       model_name = EXCLUDED.model_name, qty_on_hand = EXCLUDED.qty_on_hand,
       unit = EXCLUDED.unit, notes = EXCLUDED.notes, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [key, name, qtyNum, nextUnit, nextNotes, updatedBy || null],
  );
  await pool.query(
    `INSERT INTO stock_movements (product_key, model_name, delta, qty_after, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [key, name, qtyNum - previousQty, qtyNum, reason || "set", updatedBy || null],
  );
  return getStockItem(key);
}

/**
 * Records many counts in one call. A stock-take arrives as a whole list, and asking the operator to
 * dictate models one at a time through chat is why the table stayed empty; this takes the list.
 * Rows are applied in order and each one is logged as its own movement, so history stays intact.
 * @param {{ rows: Array<{ productKey?: string; modelName?: string; qty: number|string; unit?: string }>; updatedBy?: string; reason?: string }} input
 * @returns {Promise<{ items: unknown[]; failed: Array<{ modelName?: string; error: string }> }>}
 */
export async function setStockItems({ rows, updatedBy, reason } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new Error("rows must be a non-empty array");
  const items = [];
  const failed = [];
  for (const row of rows) {
    try {
      items.push(await setStockItem({ ...row, updatedBy, reason: row.reason || reason || "bulk set" }));
    } catch (error) {
      failed.push({ modelName: row?.modelName || row?.productKey, error: String(error?.message || error) });
    }
  }
  return { items, failed };
}

/**
 * Creates a zero-qty row for every model that has none yet, leaving existing counts untouched.
 * An empty table cannot be reported on at all; a table of known models at qty 0 can, and it shows
 * the operator exactly which counts are still missing.
 * @param {{ models: Array<string|{ modelName: string; unit?: string }>; updatedBy?: string }} input
 * @returns {Promise<{ created: string[]; skipped: number }>}
 */
export async function seedStockItems({ models, updatedBy } = {}) {
  if (!Array.isArray(models) || !models.length) throw new Error("models must be a non-empty array");
  const existing = new Set((await listStockItems()).map((row) => row.productKey));
  const created = [];
  let skipped = 0;
  for (const entry of models) {
    const modelName = typeof entry === "string" ? entry : entry?.modelName;
    if (!modelName) continue;
    if (existing.has(slugifyKey(modelName))) {
      skipped += 1;
      continue;
    }
    await setStockItem({
      modelName,
      qty: 0,
      unit: typeof entry === "object" ? entry.unit : undefined,
      updatedBy,
      reason: "seeded from catalog — count not taken yet",
    });
    existing.add(slugifyKey(modelName));
    created.push(modelName);
  }
  return { created, skipped };
}

/**
 * Relative adjustment (restock +N, correction/wastage -N). Creates the item if modelName is given.
 * @param {{ productKey?: string; modelName?: string; delta: number|string; reason?: string; updatedBy?: string }} input
 */
export async function adjustStockItem({ productKey, modelName, delta, reason, updatedBy }) {
  const key = slugifyKey(productKey || modelName);
  const deltaNum = Number(delta);
  if (!Number.isFinite(deltaNum)) throw new Error("delta must be a number");
  const current = await getStockItem(key);
  if (!current && !modelName) throw new Error(`Unknown stock item "${key}". Pass modelName to create it.`);
  const nextQty = (current ? Number(current.qtyOnHand) : 0) + deltaNum;
  return setStockItem({
    productKey: key,
    modelName: modelName || current.modelName,
    qty: nextQty,
    updatedBy,
    reason: reason || "adjust",
  });
}

export async function listStockMovements({ productKey, limit = 50 } = {}) {
  const cap = Math.max(1, Math.min(200, Number(limit) || 50));
  const pool = getPool();
  const select = `product_key AS "productKey", model_name AS "modelName", delta, qty_after AS "qtyAfter", reason,
    created_at AS "createdAt", created_by AS "createdBy"`;
  if (productKey) {
    const key = slugifyKey(productKey);
    const result = await pool.query(
      `SELECT ${select} FROM stock_movements WHERE product_key = $1 ORDER BY created_at DESC LIMIT $2`,
      [key, cap],
    );
    return result.rows;
  }
  const result = await pool.query(`SELECT ${select} FROM stock_movements ORDER BY created_at DESC LIMIT $1`, [cap]);
  return result.rows;
}
