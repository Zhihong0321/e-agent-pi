#!/usr/bin/env node
// TNB Bill Agent CLI. Prints JSON. Reads TNB_EMAIL/TNB_PASSWORD from the
// environment (injected by server/agent-env.mjs from Settings) — never
// touches the database or the secrets vault directly.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { TNB_WORKSPACE } from "./paths.mjs";
import { TnbClient } from "./tnb-client.mjs";

const USAGE = `TNB Bill Agent CLI. Prints JSON.

  node $CLOUD_PI_TNB status
  node $CLOUD_PI_TNB bills --account <accountNo> [--months 3]
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

// Filenames must stay filesystem-safe; TNB dates are ISO-ish already but
// don't risk it since BillingDateStr is server-supplied text.
function safeDateSlug(billingDate, billingDateStr) {
  const iso = String(billingDate || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  return String(billingDateStr || "bill")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "bill";
}

async function getBills({ account, months }) {
  const email = String(process.env.TNB_EMAIL || "").trim();
  const password = String(process.env.TNB_PASSWORD || "").trim();
  if (!email || !password) {
    throw new Error("TNB_EMAIL/TNB_PASSWORD are not set — save them in Settings first.");
  }
  const accountNo = String(account || "").trim();
  if (!accountNo) throw new Error("--account is required");
  const limit = Number(months) > 0 ? Math.floor(Number(months)) : 3;

  const client = new TnbClient();
  const login = await client.login(email, password);
  if (!login.ok) {
    throw new Error(`TNB login failed (status ${login.status || "?"}). Check the saved email/password.`);
  }

  let owned = await client.getOwnedAccounts();
  let records = Array.isArray(owned?.records) ? owned.records : [];
  let addedAccount = false;
  if (!records.some((r) => String(r.AccountNo) === accountNo)) {
    await client.addAccount({ accountNo, description: accountNo, isOwner: false });
    addedAccount = true;
    owned = await client.getOwnedAccounts();
    records = Array.isArray(owned?.records) ? owned.records : [];
  }

  const dashboardHtml = await client.getDashboardHtml();
  const history = client.parseBillHistory(dashboardHtml);
  const sorted = [...history].sort(
    (a, b) => new Date(b.BillingDate).getTime() - new Date(a.BillingDate).getTime()
  );
  const selected = sorted.slice(0, limit);

  const dir = path.join(TNB_WORKSPACE, "bills", accountNo);
  await mkdir(dir, { recursive: true });

  const bills = [];
  for (const entry of selected) {
    const slug = safeDateSlug(entry.BillingDate, entry.BillingDateStr);
    const relPath = `bills/${accountNo}/${slug}.pdf`;
    const fullPath = path.join(TNB_WORKSPACE, relPath);
    await client.downloadBillPdf(entry.BillingNoEnc, fullPath);
    bills.push({
      date: entry.BillingDateStr || entry.BillingDate,
      kwh: entry.ConsumptionValue,
      amount: entry.BillAmountValue,
      path: relPath,
    });
  }

  const result = { ok: true, accountNo, addedAccount, bills };
  if (records.length > 1) {
    result.warning =
      `${records.length} accounts are linked to this TNB login. myTNB only exposes bill history for ` +
      `whichever account is active in-session — these bills may belong to a different linked account, ` +
      `not necessarily ${accountNo}. Account switching isn't supported yet.`;
  }
  return result;
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  const cmd = opts._[0] || "help";
  if (cmd === "help" || opts.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (cmd === "status") {
    process.stdout.write(
      `${JSON.stringify({
        emailSet: Boolean(String(process.env.TNB_EMAIL || "").trim()),
        passwordSet: Boolean(String(process.env.TNB_PASSWORD || "").trim()),
      })}\n`
    );
    return;
  }

  if (cmd === "bills") {
    const result = await getBills({
      account: flag(opts, "account"),
      months: flag(opts, "months"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
