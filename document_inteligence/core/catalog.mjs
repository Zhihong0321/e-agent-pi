// Catalogue: products/services, packages (bundles) and tax codes.
import { DiError, defined, isUuid, requireRow, round2, setClause, validateCustom } from "./common.mjs";

const PRODUCT_FIELDS = ["sku", "name", "description", "category", "unit", "unit_price", "tax_code", "is_active", "custom"];
const PACKAGE_FIELDS = ["code", "name", "description", "price", "tax_code", "is_active", "custom"];

export async function listTaxCodes(tx) {
  const { rows } = await tx.query(
    "SELECT code, name, rate, kind, is_default FROM di.tax_code WHERE deleted_at IS NULL ORDER BY is_default DESC, code",
  );
  return { tax_codes: rows.map((r) => ({ ...r, rate: Number(r.rate) })) };
}

export async function taxRate(tx, code) {
  if (!code) return null;
  const { rows } = await tx.query("SELECT code, rate FROM di.tax_code WHERE upper(code) = upper($1) AND deleted_at IS NULL", [
    code,
  ]);
  if (!rows[0]) {
    const known = (await listTaxCodes(tx)).tax_codes.map((t) => t.code).join(", ");
    throw new DiError(`Unknown tax code "${code}". Known: ${known}`);
  }
  return { code: rows[0].code, rate: Number(rows[0].rate) };
}

export async function defaultTaxCode(tx) {
  const { rows } = await tx.query("SELECT code FROM di.tax_code WHERE is_default AND deleted_at IS NULL LIMIT 1");
  return rows[0]?.code ?? null;
}

async function uniqueCode(tx, table, column, base) {
  const stem = String(base || "ITEM")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 20) || "ITEM";
  for (let i = 1; i < 500; i += 1) {
    const candidate = i === 1 ? stem : `${stem}-${i}`;
    const { rows } = await tx.query(`SELECT 1 FROM di.${table} WHERE upper(${column}) = $1`, [candidate]);
    if (!rows.length) return candidate;
  }
  throw new DiError(`Could not find a free ${column} for ${base}`);
}

function insertSql(table, row) {
  const cols = Object.keys(row);
  const values = cols.map((k) => (row[k] !== null && typeof row[k] === "object" ? JSON.stringify(row[k]) : row[k]));
  return {
    sql: `INSERT INTO di.${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
    values,
  };
}

export async function saveProduct(tx, args = {}) {
  const { id, ...rest } = args;
  const patch = defined(rest);
  if (patch.tax_code) patch.tax_code = (await taxRate(tx, patch.tax_code)).code;
  if (patch.custom) patch.custom = await validateCustom(tx, "product", patch.custom, { creating: !id });
  if (patch.unit_price !== undefined) patch.unit_price = round2(patch.unit_price);
  if (id) {
    const existing = await requireRow(tx, "product", id, "Product");
    if (patch.custom) patch.custom = { ...existing.custom, ...patch.custom };
    const { sql, values } = setClause(patch, PRODUCT_FIELDS);
    if (!sql) return { product: existing };
    const { rows } = await tx.query(`UPDATE di.product SET ${sql} WHERE id = $${values.length + 1} RETURNING *`, [...values, id]);
    return { product: rows[0] };
  }
  if (!patch.name) throw new DiError("A product needs a name");
  if (patch.unit_price === undefined) throw new DiError("A product needs a unit_price (use 0 only for free items)");
  patch.sku = patch.sku ? String(patch.sku).toUpperCase() : await uniqueCode(tx, "product", "sku", patch.name);
  patch.tax_code ??= await defaultTaxCode(tx);
  const dup = await tx.query("SELECT id FROM di.product WHERE upper(sku) = $1", [patch.sku]);
  if (dup.rows.length) throw new DiError(`SKU ${patch.sku} already exists; update that product instead`);
  const row = Object.fromEntries(Object.entries(patch).filter(([k]) => PRODUCT_FIELDS.includes(k)));
  const { sql, values } = insertSql("product", row);
  return { product: (await tx.query(sql, values)).rows[0] };
}

async function resolveProduct(tx, ref) {
  const { rows } = isUuid(ref)
    ? await tx.query("SELECT * FROM di.product WHERE id = $1 AND deleted_at IS NULL", [ref])
    : await tx.query("SELECT * FROM di.product WHERE upper(sku) = upper($1) AND deleted_at IS NULL", [ref]);
  if (!rows[0]) throw new DiError(`Product ${ref} not found`);
  return rows[0];
}

async function resolvePackage(tx, ref) {
  const { rows } = isUuid(ref)
    ? await tx.query("SELECT * FROM di.package WHERE id = $1 AND deleted_at IS NULL", [ref])
    : await tx.query("SELECT * FROM di.package WHERE upper(code) = upper($1) AND deleted_at IS NULL", [ref]);
  if (!rows[0]) throw new DiError(`Package ${ref} not found`);
  return rows[0];
}

export async function getPackage(tx, { ref }) {
  const pkg = await resolvePackage(tx, ref);
  const items = (
    await tx.query(
      `SELECT pi.id, pi.quantity, p.id AS product_id, p.sku, p.name, p.unit, p.unit_price
         FROM di.package_item pi JOIN di.product p ON p.id = pi.product_id
        WHERE pi.package_id = $1 AND pi.deleted_at IS NULL ORDER BY pi.sort`,
      [pkg.id],
    )
  ).rows.map((r) => ({ ...r, quantity: Number(r.quantity), unit_price: Number(r.unit_price) }));
  const itemsTotal = round2(items.reduce((s, i) => s + i.quantity * i.unit_price, 0));
  return {
    package: { ...pkg, price: pkg.price == null ? null : Number(pkg.price) },
    items,
    effective_price: pkg.price == null ? itemsTotal : Number(pkg.price),
    items_total: itemsTotal,
  };
}

export async function savePackage(tx, args = {}) {
  const { id, items, ...rest } = args;
  const patch = defined(rest);
  if (patch.tax_code) patch.tax_code = (await taxRate(tx, patch.tax_code)).code;
  if (patch.custom) patch.custom = await validateCustom(tx, "package", patch.custom, { creating: !id });
  if (patch.price !== undefined && patch.price !== null) patch.price = round2(patch.price);
  let pkg;
  if (id) {
    const existing = await requireRow(tx, "package", id, "Package");
    if (patch.custom) patch.custom = { ...existing.custom, ...patch.custom };
    const { sql, values } = setClause(patch, PACKAGE_FIELDS);
    pkg = sql
      ? (await tx.query(`UPDATE di.package SET ${sql} WHERE id = $${values.length + 1} RETURNING *`, [...values, id])).rows[0]
      : existing;
  } else {
    if (!patch.name) throw new DiError("A package needs a name");
    if (!items?.length) throw new DiError("A package needs at least one item");
    patch.code = patch.code ? String(patch.code).toUpperCase() : await uniqueCode(tx, "package", "code", patch.name);
    patch.tax_code ??= await defaultTaxCode(tx);
    const row = Object.fromEntries(Object.entries(patch).filter(([k]) => PACKAGE_FIELDS.includes(k)));
    const { sql, values } = insertSql("package", row);
    pkg = (await tx.query(sql, values)).rows[0];
  }
  if (items) {
    // Replacing the item list soft-deletes the old items; history stays in the audit log.
    await tx.query("UPDATE di.package_item SET deleted_at = now() WHERE package_id = $1 AND deleted_at IS NULL", [pkg.id]);
    let sort = 0;
    for (const item of items) {
      const product = await resolveProduct(tx, item.product);
      await tx.query("INSERT INTO di.package_item (package_id, product_id, quantity, sort) VALUES ($1, $2, $3, $4)", [
        pkg.id,
        product.id,
        Number(item.quantity ?? 1),
        sort++,
      ]);
    }
  }
  return getPackage(tx, { ref: pkg.id });
}

export async function findCatalog(tx, { query = "", limit = 10 } = {}) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const patterns = words.length ? words.map((w) => `%${w}%`) : ["%"];
  const lim = Math.min(Number(limit) || 10, 50);
  const products = (
    await tx.query(
      `SELECT id, sku, name, description, unit, unit_price, tax_code, is_active FROM di.product
        WHERE deleted_at IS NULL AND lower(sku || ' ' || name || ' ' || coalesce(description, '') || ' ' || coalesce(category, '')) LIKE ALL($1::text[])
        ORDER BY is_active DESC, name LIMIT $2`,
      [patterns, lim],
    )
  ).rows.map((r) => ({ ...r, unit_price: Number(r.unit_price) }));
  const packageRows = (
    await tx.query(
      `SELECT id FROM di.package
        WHERE deleted_at IS NULL AND lower(code || ' ' || name || ' ' || coalesce(description, '')) LIKE ALL($1::text[])
        ORDER BY is_active DESC, name LIMIT $2`,
      [patterns, lim],
    )
  ).rows;
  const packages = [];
  for (const r of packageRows) {
    const p = await getPackage(tx, { ref: r.id });
    packages.push({
      id: p.package.id,
      code: p.package.code,
      name: p.package.name,
      description: p.package.description,
      tax_code: p.package.tax_code,
      is_active: p.package.is_active,
      price: p.effective_price,
      items: p.items.map((i) => `${i.quantity} × ${i.name}`),
    });
  }
  return { products, packages };
}

export { resolveProduct, resolvePackage };
