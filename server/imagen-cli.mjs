#!/usr/bin/env node
import { closeDb, connectDb } from "./db.mjs";
import { generateImage, imagenPublic } from "./imagen.mjs";
import { loadSecrets } from "./secrets.mjs";

const USAGE = `Host Imagen CLI. Prints JSON.

  node $CLOUD_PI_IMAGEN status
  node $CLOUD_PI_IMAGEN generate --prompt "..." [--out assets/hero.png] [--aspect 16:9] [--size 1024x1024]
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

  if (cmd === "status") {
    process.stdout.write(`${JSON.stringify(imagenPublic())}\n`);
    return;
  }

  if (cmd === "generate") {
    const prompt = flag(opts, "prompt") || opts._.slice(1).join(" ");
    const result = await generateImage({
      prompt,
      out: flag(opts, "out") || undefined,
      aspect: flag(opts, "aspect") || undefined,
      size: flag(opts, "size") || undefined,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

main()
  .catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeDb().catch(() => {}));
