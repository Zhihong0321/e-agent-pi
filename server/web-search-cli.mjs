#!/usr/bin/env node
// Host web-search CLI. Asks the host to run a keyword search (Jina, tokens kept
// on the host) and prints the JSON. Needs $CLOUD_PI_SEARCH_URL and
// $CLOUD_PI_SEARCH_TOKEN, which the host sets once a Jina token is saved.

const USAGE = `Host web search. Prints JSON.

  node $CLOUD_PI_SEARCH "your keywords" [--num 5] [--full]

  --num N   number of results, 1-10 (default 5)
  --full    include page text per result (costs far more search tokens)
`;

function parseArgv(argv) {
  /** @type {{ words: string[]; num?: string; full: boolean; help: boolean }} */
  const out = { words: [], full: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--full") out.full = true;
    else if (token === "--help" || token === "-h") out.help = true;
    else if (token === "--num") out.num = argv[++i];
    else if (token === "--q" || token === "--query") out.words.push(argv[++i] ?? "");
    else out.words.push(token);
  }
  return out;
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }
  const query = opts.words.join(" ").trim();
  if (!query) throw new Error(`Missing search keywords.\n${USAGE}`);
  const base = process.env.CLOUD_PI_SEARCH_URL;
  const token = process.env.CLOUD_PI_SEARCH_TOKEN;
  if (!base || !token) {
    throw new Error("Web search is not configured on this host. Add Jina tokens in Settings -> Keys.");
  }
  const res = await fetch(`${base.replace(/\/+$/, "")}/api/internal/web-search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, num: opts.num, full: opts.full }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Search failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  process.stdout.write(`${JSON.stringify(body)}\n`);
  if (!res.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
