import { randomUUID } from "node:crypto";
import { getPool } from "./db.mjs";

export const NEWPAGES_SITE_SLUG = "newpages";

const SITE_SELECT = `id, slug, name, origin, login_url AS "loginUrl", username,
  CASE WHEN password IS NOT NULL AND password <> '' THEN true ELSE false END AS "passwordSet",
  extra, last_login_at AS "lastLoginAt", last_error AS "lastError",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

export async function ensureSitesSchema() {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_logins (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      origin TEXT NOT NULL,
      login_url TEXT NOT NULL,
      username TEXT NOT NULL DEFAULT '',
      password TEXT NOT NULL DEFAULT '',
      extra JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_login_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(
    `INSERT INTO site_logins (id, slug, name, origin, login_url, extra)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (slug) DO NOTHING`,
    [
      "newpages",
      NEWPAGES_SITE_SLUG,
      "NEWPAGES merchant",
      "https://merchant.newpages.com.my",
      "https://merchant.newpages.com.my/login",
      JSON.stringify({ kind: "newpages", persist: "localStorage" }),
    ],
  );
}

function mapSite(row, { secrets = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    origin: row.origin,
    loginUrl: row.loginUrl ?? row.login_url,
    username: row.username || "",
    passwordSet: Boolean(row.passwordSet ?? (row.password && row.password.length)),
    password: secrets ? row.password || "" : undefined,
    extra: row.extra && typeof row.extra === "object" ? row.extra : {},
    lastLoginAt: row.lastLoginAt ?? row.last_login_at ?? null,
    lastError: row.lastError ?? row.last_error ?? null,
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
  };
}

export async function listSites({ secrets = false } = {}) {
  const sql = secrets
    ? `SELECT id, slug, name, origin, login_url AS "loginUrl", username, password,
         extra, last_login_at AS "lastLoginAt", last_error AS "lastError",
         created_at AS "createdAt", updated_at AS "updatedAt" FROM site_logins ORDER BY name ASC`
    : `SELECT ${SITE_SELECT} FROM site_logins ORDER BY name ASC`;
  const result = await getPool().query(sql);
  return result.rows.map((row) => mapSite(row, { secrets }));
}

export async function getSite(idOrSlug, { secrets = false } = {}) {
  const sql = secrets
    ? `SELECT id, slug, name, origin, login_url AS "loginUrl", username, password,
         extra, last_login_at AS "lastLoginAt", last_error AS "lastError",
         created_at AS "createdAt", updated_at AS "updatedAt"
       FROM site_logins WHERE id = $1 OR slug = $1`
    : `SELECT ${SITE_SELECT} FROM site_logins WHERE id = $1 OR slug = $1`;
  const result = await getPool().query(sql, [idOrSlug]);
  return mapSite(result.rows[0], { secrets });
}

export async function upsertSite(input) {
  const current = input.id || input.slug ? await getSite(input.id || input.slug, { secrets: true }) : null;
  const slug = String(input.slug || current?.slug || input.name || "site")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "site";
  const password =
    typeof input.password === "string" && input.password.trim()
      ? input.password.trim()
      : current?.password || "";
  const id = current?.id || input.id || randomUUID();
  const result = await getPool().query(
    `INSERT INTO site_logins (id, slug, name, origin, login_url, username, password, extra)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name,
       origin = EXCLUDED.origin,
       login_url = EXCLUDED.login_url,
       username = EXCLUDED.username,
       password = CASE WHEN EXCLUDED.password = '' THEN site_logins.password ELSE EXCLUDED.password END,
       extra = EXCLUDED.extra,
       updated_at = NOW()
     RETURNING ${SITE_SELECT}`,
    [
      id,
      slug,
      String(input.name || current?.name || slug).trim(),
      String(input.origin || current?.origin || "").trim(),
      String(input.loginUrl || input.login_url || current?.loginUrl || input.origin || "").trim(),
      String(input.username ?? current?.username ?? "").trim(),
      password,
      JSON.stringify(input.extra || current?.extra || {}),
    ],
  );
  return mapSite(result.rows[0]);
}

export async function deleteSite(idOrSlug) {
  const result = await getPool().query(`DELETE FROM site_logins WHERE id = $1 OR slug = $1 RETURNING id`, [idOrSlug]);
  return Boolean(result.rows[0]);
}

export async function markSiteLogin(id, { ok, error }) {
  await getPool().query(
    `UPDATE site_logins SET
       last_login_at = CASE WHEN $2 THEN NOW() ELSE last_login_at END,
       last_error = $3,
       updated_at = NOW()
     WHERE id = $1 OR slug = $1`,
    [id, Boolean(ok), ok ? null : String(error || "").slice(0, 1000)],
  );
}
