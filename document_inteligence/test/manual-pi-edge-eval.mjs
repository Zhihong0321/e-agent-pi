// Second stress test: 20 edge cases through the real DI MCP server, with the checker in the loop.
// Requires OPENCODE_GO_TOKEN_PLAN and OPENCODE_GO_PLAN_BASE_URL (worker and, by default, checker judge).
// Run from this folder with: node test/manual-pi-edge-eval.mjs [count] [--no-checker]
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStressTest } from "./pi-harness.mjs";

export const scenarios = [
  ["di-records", "A new form says 'Northstar Food Supplies' with SSM 202398888888. Add it as a new customer. Before saving, check whether that registration number is already on file; if it is, explain the match and do not create a duplicate."],
  ["di-records", "Record this business card: Farid Rahman, Procurement Manager, Northstar Foods Demo Sdn Bhd, SSM 202398888888, farid@northstar.example, 012-000 0022. The card also prints a new address, 99 Jalan Palsu, Ipoh. Attach Farid to the existing company, but do not replace its saved billing address or its primary contact Aina."],
  ["di-records", "A lead named Northstar Logistics Demo Sdn Bhd, SSM 202377777777, uses accounts@northstar.example. It might be a separate legal entity. Check for possible matches, but do not save it until I confirm how it relates to Northstar Foods."],
  ["di-records", "I confirm Northstar Logistics Demo Sdn Bhd, SSM 202377777777, really is a separate company despite sharing accounts@northstar.example. Save it as a new customer, keep Northstar Foods intact, and tell me both customer codes."],
  ["di-records", "Someone sent a catalogue import row: SKU PNL-550, 'Budget panel', RM1, tax code ST10. Check the existing SKU. Do not change its RM650 price or create a duplicate; tell me how this conflict should be resolved."],
  ["di-records", "Add a new demo service with SKU SVC-NEW, name 'Site assessment', RM500, tax code SST99. Verify whether SST99 exists first. If it does not, leave the catalogue unchanged and ask for a valid code."],
  ["di-documents", "Prepare a quotation for one PNL-550 panel for customer 'Ghost Factory'. That customer may not exist. Check first, do not guess an existing customer, and do not create a draft until it is resolved."],
  ["di-templates", "I pasted an invoice template snippet: '<html><body>{{#each lines}}<p>{{description}}</p></body></html>'. It is missing a closing loop. Check its syntax and explain the error; do not save it or change the default template."],
  ["di-documents", "Issue the existing Eastbank invoice draft with reference EDGE-NO-ADDR. If required customer billing details are missing, tell me exactly what blocks issue and leave it as an unnumbered draft."],
  ["di-records", "Eastbank Manufacturing has confirmed its billing address: 7 Jalan Kilang, 40400 Shah Alam, Selangor, Malaysia. Update only that customer's billing address, then read the record back."],
  ["di-documents", "Now issue Eastbank's existing EDGE-NO-ADDR invoice draft. Show its invoice number, status, total, and PDF path."],
  ["di-documents", "Change the issued Eastbank invoice's PNL-550 unit price from RM650 to RM1 and keep its invoice number. If issued documents are frozen, refuse the edit and explain the proper correction path."],
  ["di-documents", "Northstar accepted issued quotation QT-2026-0001. Mark it accepted and convert it into an invoice draft. Show the linked source and total; leave the invoice unissued for review."],
  ["di-documents", "Convert quotation QT-2026-0001 into a second invoice draft. Check whether it was already converted and do not create a duplicate invoice."],
  ["di-documents", "I approve the Northstar invoice draft converted from QT-2026-0001. Issue it now and show the number, due date, total, and PDF path."],
  ["di-documents", "Record a RM99,999 bank transfer against Northstar's newly issued invoice, reference EDGE-OVERPAY. If that exceeds the outstanding balance, do not post any payment; show the correct balance."],
  ["di-documents", "Northstar actually paid RM1,000 against that invoice by bank transfer, reference EDGE-PARTIAL-001. Record only that amount and show the remaining balance and invoice status."],
  ["di-documents", "Void Northstar's partially paid invoice because the project was postponed. Check its payment state first; if voiding is blocked, leave the invoice and payment intact and explain the next step."],
  ["di-db", "For future invoices, require a purchase-order number. Define a text custom field on documents named po_number, label 'Purchase order number', required for invoice.issue. Read the schema back and confirm the rule."],
  ["di-documents", "Create and immediately issue a new invoice for Eastbank Manufacturing: one SVC-INSTALL job, reference EDGE-NO-PO. I approve issuance, but I have no purchase-order number yet. Check readiness after creating the draft; if the new PO field blocks issue, leave it unnumbered and ask me for the value."],
];

/** Synthetic starting state: owner, Northstar C-0001 (+Aina), Eastbank C-0002 (no address), 2 products, QT-2026-0001, an unnumbered Eastbank draft. */
export async function fixtures(fixture) {
  await fixture("di-db", "update_company_profile", {
    name: "Meridian Solar Demo", legal_name: "Meridian Solar Demo Sdn Bhd", reg_no: "202399999999",
    address: { line1: "No. 12, Jalan Ujian 1", postcode: "47810", city: "Petaling Jaya", state: "Selangor", country: "Malaysia" }, currency: "MYR",
  });
  const northstar = (await fixture("di-records", "save_customer", {
    name: "Northstar Foods", legal_name: "Northstar Foods Demo Sdn Bhd", reg_no: "202398888888",
    email: "accounts@northstar.example", billing_address: { line1: "18 Jalan Contoh 2", postcode: "40150", city: "Shah Alam", state: "Selangor", country: "Malaysia" },
    payment_terms_days: 14,
  })).customer;
  await fixture("di-records", "save_contact", { customer_id: northstar.id, name: "Aina Lim", email: "aina@northstar.example", is_primary: true });
  await fixture("di-records", "save_customer", {
    name: "Eastbank Manufacturing", legal_name: "Eastbank Manufacturing Demo Sdn Bhd", reg_no: "202366666666",
    email: "billing@eastbank.example", payment_terms_days: 30,
  });
  await fixture("di-records", "save_product", { sku: "PNL-550", name: "Solar panel 550W", unit_price: 650, unit: "unit", tax_code: "ST10" });
  await fixture("di-records", "save_product", { sku: "SVC-INSTALL", name: "Installation service", unit_price: 3000, unit: "job", tax_code: "SV8" });
  const quote = await fixture("di-documents", "create_draft", {
    doc_type: "quotation", customer: northstar.code, lines: [{ product: "PNL-550", quantity: 2 }], valid_until: "2099-12-31", reference: "EDGE-QUOTE",
  });
  await fixture("di-documents", "issue_document", { document: quote.document.id });
  await fixture("di-documents", "create_draft", {
    doc_type: "invoice", customer: "C-0002", lines: [{ product: "PNL-550", quantity: 1 }], reference: "EDGE-NO-ADDR",
  });
}

/** OpenCode Go provider entry for the exact worker model. */
export function opencodeGo(modelId, name) {
  return {
    baseUrl: process.env.OPENCODE_GO_PLAN_BASE_URL, api: "openai-completions", authHeader: true, apiKey: "$OPENCODE_GO_TOKEN_PLAN",
    // Go rejects requests that omit this header. One id per process keeps routing stable across the run.
    headers: { "x-opencode-session": process.env.DI_EVAL_SESSION || randomUUID() },
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
    models: [{ id: modelId, name, input: ["text"], contextWindow: 64000, maxTokens: 8192 }],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.OPENCODE_GO_TOKEN_PLAN || !process.env.OPENCODE_GO_PLAN_BASE_URL) {
    throw new Error("Exact opencode-go/deepseek-v4.1-flash run requires OPENCODE_GO_TOKEN_PLAN and OPENCODE_GO_PLAN_BASE_URL");
  }
  const modelId = "deepseek-v4.1-flash";
  await runStressTest({
    name: "di-pi-edge-eval", scenarios, fixtures, provider: "opencode-go", modelId,
    providerConfig: opencodeGo(modelId, "DeepSeek V4.1 Flash"),
  });
}
