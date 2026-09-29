// Build the human review from the exact prompts and results in a completed edge run.
// Usage: node test/write-edge-report.mjs <absolute-path-to-report.json>
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = process.argv[2];
if (!source) throw new Error("Pass the completed report.json path");
const run = JSON.parse(await readFile(source, "utf8"));
if (run.steps.length !== 20 || run.provider !== "opencode-go" || run.modelId !== "deepseek-v4.1-flash") {
  throw new Error("Expected a complete 20-prompt opencode-go/deepseek-v4.1-flash run");
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "2nd_stress_test_20_prompt.md");
const notes = [
  ["Matched the exact SSM number to C-0001 (score 100); no duplicate was created.", "Pass. It checked the strongest identifier before writing."],
  ["Added Farid as a non-primary contact under C-0001. Aina stayed primary and the saved billing address stayed unchanged.", "Pass. The name-card path filled only blanks on an existing customer."],
  ["Found a possible match from the shared email (score 90), recognized the different SSM number, and stopped without saving.", "Pass. It requested confirmation for an ambiguous relationship."],
  ["Created separate customer C-0003 using `allow_duplicate=true`; C-0001 stayed intact. The new row has the requested SSM and email.", "Pass on duplicate handling; response/data quality issue. It put the full legal-looking name in `name` but left `legal_name` null. It also overstated that missing TIN and payment terms block quotation and invoice issue; the actual rules do not make all of these universal blockers."],
  ["Read PNL-550 at RM650 and left it unchanged; no second PNL-550 row was created.", "Pass. It treated the RM1 import row as a conflict requiring a decision."],
  ["Checked tax codes, found no SST99, and did not create SVC-NEW.", "Pass. It did not silently use a different tax code."],
  ["`prepare_document` found no Ghost Factory customer and returned `ready_to_create=false`. No draft was made; the estimated panel total was RM715 including ST10.", "Pass. It did not guess a customer or write a document."],
  ["`preview_template` rejected the snippet with `Unclosed {{#each lines}}`. No template was saved or made default.", "Pass. The rejected preview call is an expected validation error, not an outage."],
  ["Found the Eastbank draft and its readiness blocker: missing customer billing address. It remained unnumbered at RM715.", "Pass after recovery. Two initial lookups failed because a short customer name and the free-text reference were not accepted as document identifiers; the agent then listed drafts and used the draft ID."],
  ["Updated C-0002's billing address and read it back; other customer fields remained intact.", "Pass. The record change addressed the issue blocker."],
  ["Issued the existing Eastbank draft as INV-2026-0001, total RM715, and rendered its PDF.", "Pass. The document became numbered only after the billing address existed."],
  ["Refused to edit the issued invoice. The stored RM650 line price and RM715 total were unchanged.", "Pass on document integrity; answer was too certain that a replacement would get INV-2026-0002. Another invoice could be issued first, as happened later in this run."],
  ["Marked QT-2026-0001 accepted, then converted it into one unissued RM1,430 invoice draft linked to the quotation.", "Pass on stored workflow; response defect. Conversion changed the quotation's final status to `converted`, but the reply's table still reported `accepted`."],
  ["Read the now-converted quotation and existing linked draft; created no second invoice.", "Pass. The agent prevented duplicate conversion without needing a failing write."],
  ["Issued the converted draft as INV-2026-0002, total RM1,430, due 12 October 2026, with a PDF.", "Pass. Source linkage and prices were preserved."],
  ["Read the RM1,430 outstanding balance and posted no RM99,999 payment.", "Pass. No receipt or allocation with reference EDGE-OVERPAY exists."],
  ["Recorded RCP-2026-0001 for RM1,000, allocated it to INV-2026-0002, and reported RM430 remaining with status `partially_paid`.", "Pass. Payment, allocation, and invoice totals agree."],
  ["Read the partial payment and left the invoice and receipt intact; no void was attempted.", "Pass on state protection; serious response defect. It directed the user to the DB Manager to reverse or unallocate the payment, but that agent has no payment-reversal tool. The suggested credit-note path also needs explicit accounting review before claiming it offsets this invoice."],
  ["Defined document custom field `po_number` as text, required for `invoice.issue`, and added a blocking invoice issue rule while retaining the existing rules.", "Partial. The requirement works, but `required_for` already enforces it. Adding the separate workflow rule caused the same missing PO to appear twice in later readiness questions and blockers."],
  ["Prepared and created a RM3,240 Eastbank invoice draft with reference EDGE-NO-PO. Readiness showed the missing PO as a blocker; it remained unnumbered with no PDF.", "Pass on refusal. The tool returned two PO blockers from the redundant rules, though the agent condensed them in its reply. It avoided an issue call after seeing the blocker; 'issue refused' refers to readiness, not a failed issue attempt."],
];
const lines = [
  "# Second stress test: 20 edge-case prompts",
  "",
  "**Date:** 28 September 2026  ",
  "**Model used:** `opencode-go/deepseek-v4.1-flash` for every prompt, with no fallback  ",
  "**Outcome:** 20/20 intended data and workflow outcomes; 37/40 business-tool calls succeeded, with three handled validation/lookup errors. Response accuracy needs work.",
  "",
  "## Model check and test setup",
  "",
  "Before designing these prompts, I checked the Pi configuration and made a live one-turn Pi request to the exact `opencode-go/deepseek-v4.1-flash` model. It returned the requested sentinel text. The checked-in Pi catalog does **not** list this exact model; the user-level `local/deepseek-v4.1-flash` entry points to an inactive localhost proxy. This runner supplies an isolated Pi model entry for the OpenCode Go endpoint using the existing `OPENCODE_GO_TOKEN_PLAN` environment secret. Every scenario explicitly selects provider `opencode-go` and model `deepseek-v4.1-flash`; the runner has no alternative model path.",
  "",
  "The 20 prompts ran in order through the Pi CLI, actual agent role prompts, Pi MCP adapter, real Document Intelligence MCP server and tools, an isolated PGlite database, and Chromium PDF rendering. Synthetic fixtures were seeded directly before prompt 1: Meridian Solar Demo as owner; Northstar C-0001 with Aina, billing address and 14-day terms; Eastbank C-0002 without a billing address and with 30-day terms; PNL-550 and SVC-INSTALL; issued quotation QT-2026-0001; and an unnumbered Eastbank invoice draft with reference EDGE-NO-ADDR. Fixture writes are recorded separately from the 20 model prompts. No production tenant was changed.",
  "",
];
for (let i = 0; i < run.steps.length; i++) {
  const step = run.steps[i];
  const [result, comment] = notes[i];
  lines.push(`## Prompt ${i + 1} — ${[
    "Duplicate registration number", "Conflicting business card", "Possible company match", "Confirmed separate legal entity",
    "SKU collision", "Unknown tax code", "Unknown quotation customer", "Malformed template",
    "Invoice missing billing address", "Repair customer address", "Issue repaired draft", "Edit frozen invoice",
    "Convert accepted quotation", "Repeat conversion", "Issue converted invoice", "Overpayment",
    "Partial payment", "Void partially paid invoice", "Required PO field", "Invoice missing PO",
  ][i]}`, "", `**Agent:** ${step.agent}`, "", "**Prompt**", "", `> ${step.prompt}`, "", `**Result:** ${result}`, "", `**Comment:** ${comment}`, "");
}
const failures = run.toolCalls.filter((call) => !call.ok);
const thinkLeaks = run.steps.filter((step) => /<\/?think\b/i.test(step.finalText)).length;
lines.push(
  "## Overall assessment", "",
  "| Area | Result |", "|---|---|",
  "| Scenario goals | **20/20 achieved in the isolated run.** Intended writes and refusals match the final database state. |",
  `| Tool calls | **${run.toolCalls.length - failures.length}/${run.toolCalls.length} succeeded.** The three errors were the malformed-template rejection and two recovered Eastbank draft lookups. |`,
  "| Stored state | Three customers, two contacts, two unchanged seeded products, a converted quotation, two issued invoices, one unnumbered PO-blocked draft, one RM1,000 receipt and matching allocation. |",
  "| PDF output | Issued quotation and both issued invoices produced nonempty PDFs. Visual layout was not separately reviewed in this batch. |",
  `| Reasoning text | **${thinkLeaks}** replies exposed literal \`<think>\` tags. |`,
  "| Response and rule quality | Incorrect final quotation status in prompt 13; unsupported DB Manager reversal instruction in prompt 18; incomplete legal-name field and overstated readiness claims in prompt 4; speculative next invoice number in prompt 12; redundant PO rules and duplicate blockers in prompts 19–20. |",
  "",
  "**Overall quality: 7.5/10.** The state transitions and safeguards worked consistently. The answer defects matter because a user could act on an unavailable payment-reversal workflow or misunderstand the current document status. The DB Manager should choose one PO enforcement mechanism to avoid duplicate readiness messages. Prioritize grounding follow-up instructions in the tools actually exposed to each agent and reading final state after multi-step transitions.",
  "",
  "## Scope and evidence", "",
  "This evaluates the Pi agents and MCP workflows with an isolated database. It does not verify the live UIv2 host, production Postgres, authentication, or served PDF links. The generated PDFs were present, but their visual layout was not inspected in this batch.",
  "",
  `- Full machine-readable transcript, tool arguments/results, fixture calls and final database state: \`${source}\``,
  `- Generated PDFs: \`${path.join(path.dirname(source), "workspace", "di-documents", "documents")}\``,
  "- Repeatable runner: `test/manual-pi-edge-eval.mjs`", "",
);
await writeFile(output, lines.join("\n"), "utf8");
console.log(output);
