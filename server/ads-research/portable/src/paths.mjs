// Where the code lives vs. where generated state lives.
//
// Locally these are the same place: out/ and data/ sit inside the repo. On a
// host with an ephemeral filesystem (Railway) the checkout is thrown away on
// every deploy, so generated state has to sit on a mounted volume instead —
// point DATA_ROOT at the mount and nothing else in the codebase changes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root — code, config/topics/*.json. Read-only at runtime. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Parent of out/ and data/. Defaults to the repo, overridden by the volume mount. */
export const DATA_ROOT = process.env.DATA_ROOT ? path.resolve(process.env.DATA_ROOT) : ROOT;

/** Rendered reports and their screenshots: out/<topic>/report-<stamp>.html */
export const OUT_DIR = path.join(DATA_ROOT, 'out');

/** SQLite databases and scrape intermediates: data/<topic>.db */
export const DATA_DIR = path.join(DATA_ROOT, 'data');

export const dbFile = topic => path.join(DATA_DIR, `${topic}.db`);

/** Create the volume's directory skeleton. A fresh volume mounts empty. */
export function ensureDataRoot() {
  for (const d of [OUT_DIR, DATA_DIR]) fs.mkdirSync(d, { recursive: true });
}
