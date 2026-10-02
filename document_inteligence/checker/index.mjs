// Checker agent: compares input vs result, outside the workers.
//
//   gateWrite   before an irreversible write: does the planned call match what the user asked?
//   checkReply  after the turn: code checks first, then the judge. Fail -> feedback to the worker.
//
// Workers never see this file or its prompts. A failure mode found in testing should become a
// check here, not a new line in a role prompt.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS, TOOLS } from "../core/tools.mjs";
import { runCodeChecks } from "./checks.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPLY_PROMPT = readFileSync(path.join(HERE, "prompts", "reply.md"), "utf8");
const WRITE_PROMPT = readFileSync(path.join(HERE, "prompts", "write.md"), "utf8");

/** Writes that consume a number, move money, or can't be taken back. */
export const GATED = {
  issue_document: () => true,
  record_payment: () => true,
  void_document: () => true,
  convert_to_invoice: () => true,
  set_quotation_status: () => true,
  set_numbering: () => true,
  save_customer: (args) => args?.allow_duplicate === true,
  publish_form: () => true,
  close_form: () => true,
  intake_submission: (args) => args?.allow_duplicate === true,
  review_claim: () => true,
  close_monthly_submission: () => true,
  file_claim: (args) => args?.allow_duplicate === true,
};

export const isGated = (tool, args) => Boolean(GATED[tool]?.(args));

/** Guarantees the server already enforces, so the gate doesn't re-judge them from chat history. */
const GATE_NOTES = {
  publish_form:
    "The server refuses unsafe fields (passwords, PINs, OTPs, card or banking logins) when a form is saved, so a stored form cannot contain them, and it refuses to publish without consent text when personal data is collected. Judge only whether the user asked to publish THIS form now.",
  close_form: "Judge only whether the user asked to close THIS form.",
  review_claim: "The server already limits this to admins. Judge only whether the user asked to approve or reject THIS claim, and, for a rejection, whether a reason was given.",
  close_monthly_submission: "The server refuses while claims are pending unless carry_forward_pending is set. Judge only whether the user asked to close THIS month, and, if carry_forward_pending is true, whether they agreed to move pending claims to the next month.",
  file_claim: "Only reached with allow_duplicate. Judge whether the user confirmed this is a separate expense from the one the earlier refusal named.",
};

/** The record a write acts on, from its arguments, when no database description is available. */
function rawTarget(args = {}) {
  const ref = args.form ?? args.document ?? args.quotation;
  if (ref == null) return null;
  return `${args.form != null ? "form" : "document"}:${String(ref).trim().toLowerCase()}`;
}

const KNOWN_GAPS =
  "No tool exists to edit, reverse, refund or unallocate a recorded payment, edit an issued document, apply a credit note to an invoice, or submit to MyInvois. Email delivery is available only through the separately attached ee-mail MCP after explicit confirmation. " +
  "Forms: no tool can send or share a form link (email, WhatsApp, SMS), edit or delete a submitted answer, edit a published form version in place, add custom HTML/JavaScript to a form, raise upload limits above the host limits, or collect passwords, PINs, OTPs or card details. " +
  "Expenses: no tool can delete or reopen a claim or a closed monthly submission, pay claims out, convert foreign currency, or email the report.";

function toolList() {
  const lines = Object.entries(AGENTS).map(([id, meta]) => {
    const names = Object.entries(TOOLS).filter(([, t]) => t.agents.includes(id)).map(([name]) => name);
    return `${meta.name} (${id}): ${names.join(", ")}`;
  });
  return [...lines, KNOWN_GAPS].join("\n");
}

const clip = (value, max) => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length > max ? `${text.slice(0, max)}…(cut)` : text;
};

function callLines(calls, max = 1500) {
  if (!calls.length) return "(none)";
  return calls.map((c, i) => `${i + 1}. ${c.tool} ${clip(c.args, 400)}\n   -> ${c.ok === false ? `ERROR ${clip(c.error, 300)}` : clip(c.result, max)}`).join("\n");
}

const earlierLines = (earlier = []) => (earlier.length ? earlier.map((m) => `- ${clip(m, 600)}`).join("\n") : "(none)");

/**
 * @param {{
 *   judge?: (system: string, user: string) => Promise<any>,
 *   lookup?: (id: string) => Promise<{kind: string, status?: string} | null>,
 *   describe?: (tool: string, args: any) => Promise<{target: string | null, facts: string | null}>,
 * }} deps
 */
export function createChecker({ judge, lookup, describe } = {}) {
  const tools = toolList();

  async function facts(reply) {
    if (!lookup) return "(none)";
    const ids = [...new Set(reply.match(/\b(?:QT|INV|CN|RCP)-\d{4}-\d{3,}\b|\bC-\d{4,}\b/g) || [])];
    const rows = [];
    for (const id of ids) {
      const row = await lookup(id);
      rows.push(row ? `${id}: ${row.kind}${row.status ? `, status ${row.status}` : ""}` : `${id}: does not exist`);
    }
    return rows.length ? rows.join("\n") : "(none)";
  }

  return {
    /**
     * priorCalls are this turn's calls; a blocked one carries `blocked: true` and the `target` this
     * gate returned for it.
     * @returns {Promise<{ allow: boolean, reason?: string, by?: "code", target?: string, judgeError?: string }>}
     */
    async gateWrite({ agent, input, earlier = [], priorCalls = [], tool, args }) {
      if (!isGated(tool, args)) return { allow: true };
      const current = describe ? await describe(tool, args).catch(() => null) : null;
      const target = current?.target ?? rawTarget(args);
      const withTarget = (verdict) => (target ? { ...verdict, target } : verdict);

      // After a blocked write, trying the same write on other records is probing, not a fix.
      const blockedOther = priorCalls.find((c) => c.blocked && (c.target ?? rawTarget(c.args)) && (c.target ?? rawTarget(c.args)) !== target);
      if (target && blockedOther) {
        return withTarget({
          allow: false,
          by: "code",
          reason: `${blockedOther.tool} on ${String(blockedOther.args?.form ?? blockedOther.args?.document ?? blockedOther.args?.quotation)} was blocked this turn; writing to a different record to get around it is not allowed. Tell the user why the first write was blocked and ask.`,
        });
      }

      if (!judge) return withTarget({ allow: true });
      const user = [
        `AGENT: ${agent}`,
        `EARLIER MESSAGES:\n${earlierLines(earlier)}`,
        `USER REQUEST:\n${input}`,
        `EARLIER TOOL RESULTS (this turn):\n${callLines(priorCalls, 1000)}`,
        `CURRENT STATE (stored now; trusted over EARLIER MESSAGES):\n${current?.facts ?? "(not available)"}`,
        ...(GATE_NOTES[tool] ? [`NOTE:\n${GATE_NOTES[tool]}`] : []),
        `PLANNED WRITE:\n${tool} ${clip(args, 1500)}`,
      ].join("\n\n");
      try {
        const verdict = await judge(WRITE_PROMPT, user);
        return withTarget(verdict?.allow === false ? { allow: false, reason: String(verdict.reason || "The checker blocked this write.") } : { allow: true });
      } catch (error) {
        return withTarget({ allow: true, judgeError: error instanceof Error ? error.message : String(error) });
      }
    },

    /** @returns {Promise<{ pass: boolean, problems: string[], by: "code" | "judge" | "none", judgeError?: string }>} */
    async checkReply({ agent, input, earlier = [], toolCalls = [], reply }) {
      const text = String(reply || "");
      const code = await runCodeChecks(text, { input, toolCalls, lookup });
      if (code.length) return { pass: false, problems: code, by: "code" };
      if (!judge) return { pass: true, problems: [], by: "none" };
      const user = [
        `AGENT: ${agent}`,
        `TOOLS:\n${tools}`,
        `EARLIER MESSAGES:\n${earlierLines(earlier)}`,
        `USER REQUEST:\n${input}`,
        `TOOL CALLS:\n${callLines(toolCalls)}`,
        `FACTS (stored now):\n${await facts(text)}`,
        `REPLY:\n${text}`,
      ].join("\n\n");
      try {
        const verdict = await judge(REPLY_PROMPT, user);
        const problems = Array.isArray(verdict?.problems) ? verdict.problems.map(String).filter(Boolean) : [];
        if (verdict?.pass === false) return { pass: false, problems: problems.length ? problems : ["The checker rejected the reply."], by: "judge" };
        return { pass: true, problems: [], by: "judge" };
      } catch (error) {
        return { pass: true, problems: [], by: "none", judgeError: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/** What the worker is told on a failed check. Short on purpose. */
export function feedbackMessage(problems) {
  return [
    "CHECKER: your last reply did not pass.",
    ...problems.map((p) => `- ${p}`),
    "Writes that already succeeded are done; do not repeat them. Fix only these problems, then give the corrected final reply.",
  ].join("\n");
}

/** Message the worker gets as a tool error when the gate blocks a write. */
export function blockedMessage(tool, reason) {
  return `CHECKER blocked ${tool}: ${reason} Nothing was written. Ask the user, or correct the call.`;
}
