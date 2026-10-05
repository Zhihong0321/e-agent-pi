// First stress test: 10 prompts along the normal business path, with the checker in the loop.
// Worker model: GRAFT_* from the root .env (DI_EVAL_MODEL overrides the model id).
// Checker judge: MINIMAX_API_KEY (or DI_CHECKER_*), see checker/judge.mjs.
// Run from this folder with: node test/manual-pi-eval.mjs [count] [--no-checker]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { runStressTest } from "./pi-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const scenarios = [
  ["di-db", "Please set up my company profile for a software test. Trading name: Meridian Solar Demo. Legal name: Meridian Solar Demo Sdn Bhd. Synthetic SSM number: 202399999999. Address: No. 12, Jalan Ujian 1, Taman Contoh, 47810 Petaling Jaya, Selangor, Malaysia. Currency: MYR. Read the saved profile back to me."],
  ["di-db", "Add these details to Meridian Solar Demo's profile: phone 03-0000 0100, email accounts@meridiansolar.example, website https://meridiansolar.example, and bank details 'DEMO BANK — TEST ACCOUNT 000000000000 — DO NOT PAY.' Leave TIN, SST number, and MSIC blank; do not invent them. Tell me which fields remain empty."],
  ["di-records", "Record a new company customer. Trading name: Northstar Foods. Legal name: Northstar Foods Demo Sdn Bhd. Synthetic SSM number: 202398888888. Email: accounts@northstar.example. Billing address: 18 Jalan Contoh 2, 40150 Shah Alam, Selangor, Malaysia. Payment terms: 14 days. Primary contact: Aina Lim, Operations Manager, aina@northstar.example, 012-000 0011. Show me the customer code and saved details."],
  ["di-records", "I received another business card: Farid Rahman, Procurement Manager, Northstar Foods Demo Sdn Bhd, SSM 202398888888, farid@northstar.example, 012-000 0022. Record him under the existing customer. Check for duplicates first, and do not replace Aina or create a second Northstar customer."],
  ["di-records", "Add these demo catalogue entries: PNL-550 Solar panel 550W, RM650 per unit, tax code ST10; INV-10K Hybrid inverter 10kW, RM5,200 per unit, ST10; SVC-INSTALL Installation service, RM3,000 per job, SV8. Then create package PKG-10KWP, '10kWp rooftop package,' containing 18 PNL-550 panels and one INV-10K, with a fixed package price of RM22,000 and tax code SV8. Read back the package and items."],
  ["di-documents", "Northstar Foods wants a quotation for one PKG-10KWP package and one SVC-INSTALL job. I have not chosen the recipient or validity period. Do not create a draft yet. Check the customer and catalogue, give me the estimated total, and ask for everything needed before issue."],
  ["di-documents", "Use Aina Lim as the contact. Make the quotation valid for 30 days from today. Use reference TEST-ROOF-001. Create the draft quotation for the items we discussed and render a draft PDF for review. Do not issue it yet."],
  ["di-documents", "I approve that draft quotation. Issue it now. Show me its quotation number, final total, status, and PDF link."],
  ["di-documents", "Northstar Foods accepted the quotation you just issued. Mark it accepted, convert it to an invoice draft, use the customer's 14-day payment terms, check that it is ready, and issue the invoice. Show me the invoice number, due date, total, linked quotation, and PDF link."],
  ["di-documents", "Northstar Foods paid RM10,000 against that invoice by bank transfer, reference DEMO-IBG-001. Record it and tell me the remaining balance. Later, they paid the exact remaining balance by bank transfer, reference DEMO-IBG-002. Record that as a second payment, then show the final invoice status and both allocations."],
];

function readEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(GRAFT_[A-Z_]+)\s*=\s*(.*)$/);
    if (match) values[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const secrets = readEnv(await readFile(path.join(ROOT, ".env"), "utf8"));
  if (!secrets.GRAFT_API_KEY || !secrets.GRAFT_BASE_URL || !secrets.GRAFT_MODEL) {
    throw new Error("Graft model configuration is required for isolated Pi evaluation");
  }
  const modelId = process.env.DI_EVAL_MODEL || secrets.GRAFT_MODEL;
  await runStressTest({
    name: "di-pi-eval",
    scenarios,
    provider: "eval",
    modelId,
    env: { GRAFT_API_KEY: secrets.GRAFT_API_KEY },
    providerConfig: {
      baseUrl: secrets.GRAFT_BASE_URL, api: "openai-completions", authHeader: true, apiKey: "$GRAFT_API_KEY",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: true, requiresReasoningContentOnAssistantMessages: true, maxTokensField: "max_completion_tokens" },
      models: [{ id: modelId, name: "Evaluation model", reasoning: true, input: ["text", "image"], contextWindow: 1000000, maxTokens: 32768, thinkingLevelMap: { minimal: "low", off: "low" } }],
    },
  });
}
