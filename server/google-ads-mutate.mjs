// The single choke point for every Google Ads write.
//
// Nothing else in the codebase may call googleAds:mutate. Every operation that
// passes through here is re-validated against server/google-ads-ops.mjs, so
// even an operation list built by hand — or by a future caller that skipped the
// builders — still cannot enable anything.
//
// Two further habits, both cheap:
//   - Every real write is dry-run first with validateOnly, so a malformed batch
//     fails against Google's validator instead of half-applying.
//   - Every attempt is appended to an audit log, refusals included.

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { adsRequest, targetCustomerId } from "./google-ads.mjs";
import { assertNoEnabling, assertOperationCount, AdsSafetyError } from "./google-ads-ops.mjs";
import { DATA_DIR } from "./paths.mjs";

const AUDIT_LOG = path.join(DATA_DIR, "google-ads-writes.jsonl");

async function audit(entry) {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(AUDIT_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
  } catch {
    // An unwritable audit log must not block a refusal or mask a real error.
  }
}

async function mutate(customerId, operations, validateOnly) {
  return adsRequest(`customers/${customerId}/googleAds:mutate`, {
    method: "POST",
    body: { mutateOperations: operations, validateOnly, partialFailure: false },
  });
}

/**
 * Validates operations and, unless dryRun, applies them.
 * @returns {Promise<{applied: boolean, results: object[], operations: number}>}
 */
export async function runMutate(operations, { customerId, dryRun = false, intent = "unknown" } = {}) {
  const cid = targetCustomerId(customerId);
  try {
    assertOperationCount(operations);
    assertNoEnabling(operations);
  } catch (error) {
    await audit({ intent, customerId: cid, outcome: "refused", reason: error.message });
    throw error;
  }

  // Dry run first, always — including as the first half of a real write.
  const check = await mutate(cid, operations, true);
  if (dryRun) {
    await audit({ intent, customerId: cid, outcome: "validated", operations: operations.length });
    return { applied: false, results: check.mutateOperationResponses || [], operations: operations.length };
  }

  const applied = await mutate(cid, operations, false);
  await audit({
    intent,
    customerId: cid,
    outcome: "applied",
    operations: operations.length,
    payload: operations,
    response: applied.mutateOperationResponses || [],
  });
  return { applied: true, results: applied.mutateOperationResponses || [], operations: operations.length };
}

export { AdsSafetyError };
