/**
 * Blueprint submissions — the Prototyper's actual deliverable.
 *
 * A blueprint is one department request captured as an approved spec: their
 * original words, the discussion that shaped it, a link to the prototype that
 * communicated it, and the finalized spec as JSON. The System Engineer builds
 * from this; the prototype is only how it was explained.
 *
 * Blueprints are versioned per slug and never edited in place — a revision is
 * a new version, so "that isn't what I signed off on" has an answer.
 */

import { randomUUID } from "node:crypto";
import { getPool } from "./db.mjs";
import { slugify } from "./catalog.mjs";

/** draft → approved, or shelved when it's decided against. */
export const BLUEPRINT_STATUSES = ["draft", "approved", "shelved"];

export function normalizeStatus(value) {
  const text = String(value ?? "").trim();
  return BLUEPRINT_STATUSES.includes(text) ? text : "draft";
}

/**
 * The `spec` JSONB payload. Every section is an array so an empty one is a
 * deliberate "none", not a missing key. Keys the Prototyper doesn't fill are
 * normalized to [] on write rather than rejected — a half-finished draft is
 * still worth storing.
 */
export const SPEC_SECTIONS = [
  // { id, name, purpose, url, states: ["empty","loading","error"] }
  "screens",
  // { entity, source: "prod_main.orders" | "invented", fields: [{ name, type, notes }] }
  "data_model",
  // { id, rule, source: "stated" | "assumed", screen }
  "rules",
  // { role, can_see: [], can_do: [] }
  "roles",
  // { id, assumption, why, confirmed: bool }
  "assumptions",
  // { id, asked_for, why_not_prototyped, prototype_shows, unknowns: [], flags: [], confirmed: bool }
  "gaps",
  // { existing_system, what_duplicates }
  "overlaps",
];

export function normalizeSpec(input) {
  const spec = input && typeof input === "object" ? input : {};
  const out = {};
  for (const section of SPEC_SECTIONS) {
    const value = spec[section];
    out[section] = Array.isArray(value) ? value : [];
  }
  return out;
}

export async function ensureBlueprintSchema() {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blueprints (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      department TEXT,
      requester TEXT,
      original_intent TEXT NOT NULL,
      discussion_summary TEXT NOT NULL DEFAULT '',
      prototype_url TEXT,
      spec JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'draft',
      approved_by TEXT,
      approved_at TIMESTAMPTZ,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (slug, version)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS blueprints_slug_idx ON blueprints (slug, version DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS blueprints_status_idx ON blueprints (status, updated_at DESC)`);
}

const BLUEPRINT_SELECT = `id, slug, version, title, department, requester,
  original_intent AS "originalIntent", discussion_summary AS "discussionSummary",
  prototype_url AS "prototypeUrl", spec, status,
  approved_by AS "approvedBy", approved_at AS "approvedAt",
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`;

/**
 * Submit a blueprint. Always writes a new row: the version is the next one for
 * this slug, so revising an approved blueprint leaves the approved copy intact.
 */
export async function submitBlueprint(input = {}) {
  const title = String(input.title || "").trim();
  if (!title) throw new Error("Blueprint needs a title.");
  const originalIntent = String(input.originalIntent || "").trim();
  if (!originalIntent) throw new Error("Blueprint needs the requester's original intent, in their own words.");

  const slug = slugify(input.slug || title);
  const next = await getPool().query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM blueprints WHERE slug = $1`,
    [slug],
  );
  const version = Number(next.rows[0]?.version ?? 1);

  const result = await getPool().query(
    `INSERT INTO blueprints
       (id, slug, version, title, department, requester, original_intent,
        discussion_summary, prototype_url, spec, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${BLUEPRINT_SELECT}`,
    [
      randomUUID(),
      slug,
      version,
      title,
      input.department ?? null,
      input.requester ?? null,
      originalIntent,
      String(input.discussionSummary || "").trim(),
      input.prototypeUrl ?? null,
      JSON.stringify(normalizeSpec(input.spec)),
      normalizeStatus(input.status),
      input.createdBy ?? "prototyper",
    ],
  );
  return result.rows[0];
}

/** Latest version of one blueprint, or an exact version when given. */
export async function getBlueprint(slugOrId, version = null) {
  const pool = getPool();
  if (version != null) {
    const result = await pool.query(
      `SELECT ${BLUEPRINT_SELECT} FROM blueprints WHERE slug = $1 AND version = $2`,
      [slugOrId, Number(version)],
    );
    return result.rows[0] ?? null;
  }
  const result = await pool.query(
    `SELECT ${BLUEPRINT_SELECT} FROM blueprints
     WHERE id = $1 OR slug = $1
     ORDER BY version DESC LIMIT 1`,
    [slugOrId],
  );
  return result.rows[0] ?? null;
}

/** Every version of one blueprint, newest first — the sign-off trail. */
export async function listBlueprintVersions(slug) {
  const result = await getPool().query(
    `SELECT ${BLUEPRINT_SELECT} FROM blueprints WHERE slug = $1 ORDER BY version DESC`,
    [slug],
  );
  return result.rows;
}

/** Latest version of every blueprint, for the queue view. */
export async function listBlueprints({ status = null } = {}) {
  const params = status ? [normalizeStatus(status)] : [];
  const result = await getPool().query(
    `SELECT ${BLUEPRINT_SELECT} FROM blueprints b
     WHERE b.version = (SELECT MAX(v.version) FROM blueprints v WHERE v.slug = b.slug)
     ${status ? "AND b.status = $1" : ""}
     ORDER BY b.updated_at DESC`,
    params,
  );
  return result.rows;
}

/**
 * Move a blueprint's status. Approval is a human act — the Prototyper records
 * that a department accepted a prototype, the IT Head sets `approved` here.
 */
export async function setBlueprintStatus(slugOrId, status, { approvedBy = null, version = null } = {}) {
  const current = await getBlueprint(slugOrId, version);
  if (!current) throw new Error(`Blueprint not found: ${slugOrId}`);
  const next = normalizeStatus(status);
  const approving = next === "approved";
  const result = await getPool().query(
    `UPDATE blueprints
     SET status = $2,
         approved_by = CASE WHEN $3::text IS NULL THEN approved_by ELSE $3 END,
         approved_at = CASE WHEN $4 THEN NOW() ELSE approved_at END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING ${BLUEPRINT_SELECT}`,
    [current.id, next, approving ? approvedBy : null, approving],
  );
  return result.rows[0];
}
