import { getPool } from "./db.mjs";

const MAX = 80;

/** @type {{ ts: string; level: string; message: string; meta?: unknown }[]} */
const events = [];

function sanitize(value) {
  return String(value ?? "")
    .replace(/x-access-token:[^@\s]+/gi, "x-access-token:***")
    .replace(/ghp_[A-Za-z0-9]+/g, "ghp_***")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_***")
    .replace(/postgres:\/\/[^@\s]+@/gi, "postgres://***@")
    .slice(0, 2000);
}

export function recentEvents() {
  return events.slice(-50);
}

/**
 * @param {"info" | "warn" | "error"} level
 * @param {string} message
 * @param {unknown} [meta]
 */
export function logEvent(level, message, meta) {
  const event = {
    ts: new Date().toISOString(),
    level,
    message: sanitize(message),
    meta: meta ?? null,
  };
  events.push(event);
  if (events.length > MAX) events.shift();

  const line = `[${level}] ${event.message}`;
  if (level === "error") console.error(line, meta ?? "");
  else console.log(line);

  void persist(event);
}

async function persist(event) {
  try {
    await getPool().query(
      `INSERT INTO debug_events (level, message, meta) VALUES ($1, $2, $3)`,
      [event.level, event.message, event.meta ? JSON.stringify(event.meta) : null],
    );
  } catch {
    // Memory ring still holds the event if Postgres is down.
  }
}

export async function loadRecentFromDb() {
  try {
    const result = await getPool().query(
      `SELECT created_at AS ts, level, message, meta
       FROM debug_events
       ORDER BY id DESC
       LIMIT 50`,
    );
    return result.rows.reverse();
  } catch {
    return recentEvents();
  }
}

export function envFlags() {
  const names = [
    "PORT",
    "DATABASE_URL",
    "DATA_DIR",
    "RAILWAY_VOLUME_MOUNT_PATH",
    "RAILWAY_PUBLIC_DOMAIN",
    "RAILWAY_ENVIRONMENT_NAME",
    "EE_HTML_API_KEY",
    "EE_HTML_BASE_URL",
  ];
  /** @type {Record<string, boolean>} */
  const present = {};
  for (const name of names) present[name] = Boolean(process.env[name]?.trim());
  return present;
}

export function railwayMeta() {
  return {
    environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? null,
    service: process.env.RAILWAY_SERVICE_NAME ?? null,
    replica: process.env.RAILWAY_REPLICA_ID ?? null,
    publicDomain: process.env.RAILWAY_PUBLIC_DOMAIN ?? null,
    privateDomain: process.env.RAILWAY_PRIVATE_DOMAIN ?? null,
  };
}
