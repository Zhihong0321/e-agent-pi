#!/usr/bin/env node
import { closeDb, connectDb } from "./db.mjs";
import { loadSecrets } from "./secrets.mjs";
import { ensureSitesSchema, getSite, listSites, upsertSite } from "./sites.mjs";
import {
  ensureNewpagesLogin,
  newpagesCategories,
  newpagesCreate,
  newpagesDelete,
  newpagesNews,
  newpagesStatus,
} from "./newpages.mjs";

const USAGE = `Host site-browser CLI. Prints JSON.

  node $CLOUD_PI_SITES status
  node $CLOUD_PI_SITES sites
  node $CLOUD_PI_SITES login newpages
  node $CLOUD_PI_SITES np ready
  node $CLOUD_PI_SITES np news
  node $CLOUD_PI_SITES np categories
  node $CLOUD_PI_SITES np create --title "..." --body "..." --image /path/to.jpg [--category Roadshow] [--dry-run]
  node $CLOUD_PI_SITES np delete <newsId>
`;

function parseArgv(argv) {
  /** @type {Record<string, string | boolean> & { _: string[] }} */
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    i += 1;
    out[key] = next;
  }
  return out;
}

function flag(opts, key) {
  const value = opts[key];
  if (value === true || value === false || value === undefined) return "";
  return String(value);
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  const cmd = opts._[0] || "help";
  if (cmd === "help" || opts.help) {
    process.stdout.write(USAGE);
    return;
  }

  await connectDb();
  await loadSecrets();
  await ensureSitesSchema();

  if (cmd === "status" || (cmd === "np" && opts._[1] === "ready")) {
    process.stdout.write(`${JSON.stringify(await newpagesStatus())}\n`);
    return;
  }

  if (cmd === "sites") {
    process.stdout.write(`${JSON.stringify({ sites: await listSites() })}\n`);
    return;
  }

  if (cmd === "login") {
    const slug = opts._[1] || "newpages";
    const site = await getSite(slug);
    if (!site) throw new Error(`Unknown site: ${slug}`);
    if (site.slug !== "newpages") throw new Error(`Login automation for ${site.slug} is not implemented yet.`);
    process.stdout.write(`${JSON.stringify(await ensureNewpagesLogin())}\n`);
    return;
  }

  if (cmd === "np") {
    const action = opts._[1];
    if (action === "news") {
      process.stdout.write(`${JSON.stringify(await newpagesNews())}\n`);
      return;
    }
    if (action === "categories") {
      process.stdout.write(`${JSON.stringify({ categories: await newpagesCategories() })}\n`);
      return;
    }
    if (action === "create") {
      const result = await newpagesCreate({
        title: flag(opts, "title"),
        body: flag(opts, "body") || undefined,
        titleCN: flag(opts, "title-cn") || undefined,
        bodyCN: flag(opts, "body-cn") || undefined,
        titleBM: flag(opts, "title-bm") || undefined,
        bodyBM: flag(opts, "body-bm") || undefined,
        imagePath: flag(opts, "image") || flag(opts, "imagePath"),
        category: flag(opts, "category") || undefined,
        dryRun: Boolean(opts["dry-run"] || opts.dryRun),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (action === "delete") {
      const id = opts._[2];
      if (!id) throw new Error("news id required");
      process.stdout.write(`${JSON.stringify(await newpagesDelete(id))}\n`);
      return;
    }
  }

  if (cmd === "save") {
    const site = await upsertSite({
      slug: flag(opts, "slug") || "newpages",
      name: flag(opts, "name") || undefined,
      origin: flag(opts, "origin") || undefined,
      loginUrl: flag(opts, "login-url") || undefined,
      username: flag(opts, "username") || undefined,
      password: flag(opts, "password") || undefined,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, site })}\n`);
    return;
  }

  throw new Error(`Unknown command. ${USAGE}`);
}

main()
  .catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => closeDb().catch(() => {}));
