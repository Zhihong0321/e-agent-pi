import { getPool } from "./db.mjs";

const SELECT = `slug, name, kind, origin, login_url AS "loginUrl", probe,
  signed_in AS "signedIn", last_auth_at AS "lastAuthAt", last_error AS "lastError",
  extra, created_at AS "createdAt", updated_at AS "updatedAt"`;

export async function ensureBrowserSchema() {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS browser_signins (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'oauth-interactive',
      origin TEXT NOT NULL,
      login_url TEXT NOT NULL,
      probe JSONB NOT NULL DEFAULT '{}'::jsonb,
      signed_in BOOLEAN NOT NULL DEFAULT false,
      last_auth_at TIMESTAMPTZ,
      last_error TEXT,
      extra JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(
    `INSERT INTO browser_signins (slug, name, kind, origin, login_url, probe)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (slug) DO NOTHING`,
    [
      "google",
      "Google",
      "oauth-interactive",
      "https://accounts.google.com",
      "https://accounts.google.com/ServiceLogin",
      JSON.stringify({ kind: "google" }),
    ],
  );
}

function mapRow(row) {
  if (!row) return null;
  return {
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    origin: row.origin,
    loginUrl: row.loginUrl,
    probe: row.probe && typeof row.probe === "object" ? row.probe : {},
    signedIn: Boolean(row.signedIn),
    lastAuthAt: row.lastAuthAt || null,
    lastError: row.lastError || null,
    extra: row.extra && typeof row.extra === "object" ? row.extra : {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listSignins() {
  const result = await getPool().query(`SELECT ${SELECT} FROM browser_signins ORDER BY name ASC`);
  return result.rows.map(mapRow);
}

export async function getSignin(slug) {
  const result = await getPool().query(`SELECT ${SELECT} FROM browser_signins WHERE slug = $1`, [slug]);
  return mapRow(result.rows[0]);
}

export async function upsertSignin(input) {
  const slug = String(input.slug || input.name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) throw new Error("Sign-in needs a name.");
  const name = String(input.name || slug).trim();
  const origin = String(input.origin || input.loginUrl || "").trim();
  const loginUrl = String(input.loginUrl || origin).trim();
  if (!origin || !loginUrl) throw new Error("Sign-in needs an origin / login URL.");
  let host = origin;
  try {
    host = new URL(origin).origin;
  } catch {
    throw new Error("Origin must be a full URL, e.g. https://accounts.google.com");
  }
  const kind = String(input.kind || "oauth-interactive").trim() || "oauth-interactive";
  const probe = input.probe && typeof input.probe === "object" ? input.probe : { kind: /google/i.test(host) ? "google" : "cookies" };
  const result = await getPool().query(
    `INSERT INTO browser_signins (slug, name, kind, origin, login_url, probe)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name,
       kind = EXCLUDED.kind,
       origin = EXCLUDED.origin,
       login_url = EXCLUDED.login_url,
       probe = EXCLUDED.probe,
       updated_at = NOW()
     RETURNING ${SELECT}`,
    [slug, name, kind, host, loginUrl, JSON.stringify(probe)],
  );
  return mapRow(result.rows[0]);
}

export async function deleteSignin(slug) {
  if (slug === "google") throw new Error("Google is a built-in sign-in and cannot be removed.");
  const result = await getPool().query(`DELETE FROM browser_signins WHERE slug = $1 RETURNING slug`, [slug]);
  return Boolean(result.rows[0]);
}

export async function markSignin(slug, { signedIn, error = null } = {}) {
  const result = await getPool().query(
    `UPDATE browser_signins SET
       signed_in = $2,
       last_auth_at = CASE WHEN $2 THEN NOW() ELSE last_auth_at END,
       last_error = $3,
       updated_at = NOW()
     WHERE slug = $1
     RETURNING ${SELECT}`,
    [slug, Boolean(signedIn), signedIn ? null : error ? String(error).slice(0, 1000) : null],
  );
  return mapRow(result.rows[0]);
}
