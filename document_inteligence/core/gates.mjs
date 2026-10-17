// Gates: a company's yes/no rules about a record and who is asking, kept as an ordered list in di.gate. The FDE
// writes them as a Python-style program (core/gate-program.mjs), which is compiled into the rules stored here. Code
// checks them when a record is saved or issued: the first rule whose condition is true decides (allow or block);
// no match = allow.
import jsonLogic from "json-logic-js";
import { DiError, round2 } from "./common.mjs";
import { compileProgram, renderProgram } from "./gate-program.mjs";

export const RECORD_TYPES = ["document"];
export const OPS = ["and", "or", "!", "==", "!=", "<", "<=", ">", ">=", "in", "var"];

/** The facts a rule may read, per record type. A new fact is one line here and one value in documentFacts. */
export const FACTS = {
  document: {
    action: '"save" (a draft is created or edited, or an invoice is made from a quotation) or "issue". Use it ONLY when the owner names the action: "issue" for issuing, "save" for creating or editing; when they name none, leave it out',
    "document.doc_type": "quotation, invoice or credit_note",
    "document.status": "current status (a draft on save)",
    "document.currency": "e.g. MYR",
    "document.line_count": "number of lines",
    "document.list_total": "sum of quantity x catalogue price, before any discount",
    "document.subtotal": "after line discounts, before tax",
    "document.total": "including tax",
    "document.discount_pct": "the discount on the whole document as a percent of list_total, from line discounts and lowered unit prices (0 when list_total is 0). This is the one for \"at most X% discount\"",
    "document.max_line_discount_pct": "the same percent for the single line with the largest discount; only when the owner limits the discount per line",
    "requester.username": "the signed-in user (requester is null when no user is attached)",
    "requester.access": "superadmin, department_head or user",
    "requester.category": "the user's category name, e.g. Sales",
    "requester.department": "the user's department",
  },
};

const ID = /^[a-z][a-z0-9-]{0,47}$/;
const MAX_RULES = 30;

function walk(node, facts) {
  if (node === null || typeof node !== "object") return;
  const keys = Object.keys(node);
  if (keys.length !== 1) throw new DiError(`A condition holds exactly one operator, got ${keys.length}: ${JSON.stringify(node)}`);
  const [op] = keys;
  if (!OPS.includes(op)) throw new DiError(`Operator "${op}" is not allowed. Use only: ${OPS.join(", ")}`);
  const arg = node[op];
  if (op !== "var") {
    // A list is only ever the values "in" looks through; anywhere else it would read as a condition that is always true.
    return (Array.isArray(arg) ? arg : [arg]).forEach((a) => {
      if (!Array.isArray(a)) return walk(a, facts);
      if (op !== "in" || a.some((x) => x !== null && typeof x === "object")) throw new DiError(`A list is not a condition: ${JSON.stringify(a)}`);
    });
  }
  const path = Array.isArray(arg) ? arg[0] : arg;
  if (typeof path !== "string" || !Object.hasOwn(facts, path)) {
    throw new DiError(`Unknown fact "${path}". Use only: ${Object.keys(facts).join(", ")}`);
  }
}

/** Checks a rule list against the vocabulary and returns it normalized, or throws naming the problem. */
export function validateGates(recordType, rules) {
  if (!RECORD_TYPES.includes(recordType)) throw new DiError(`Unknown record type "${recordType}". Use: ${RECORD_TYPES.join(", ")}`);
  if (!Array.isArray(rules)) throw new DiError("rules must be a list");
  if (rules.length > MAX_RULES) throw new DiError(`A list holds at most ${MAX_RULES} rules, got ${rules.length}`);
  const seen = new Set();
  return rules.map((r) => {
    if (!ID.test(r?.id ?? "")) throw new DiError(`Rule id "${r?.id}" must be lower-case letters, digits and dashes, starting with a letter (max 48)`);
    if (seen.has(r.id)) throw new DiError(`Rule id "${r.id}" appears twice`);
    seen.add(r.id);
    if (r.then !== "allow" && r.then !== "block") throw new DiError(`Rule "${r.id}": then must be allow or block, got "${r.then}"`);
    const message = r.message ?? "";
    if (r.then === "block" && !message.trim()) throw new DiError(`Rule "${r.id}": a block needs a message for the person blocked`);
    if (message.length > 200) throw new DiError(`Rule "${r.id}": message is over 200 characters`);
    if (r.when === null || typeof r.when !== "object" || Array.isArray(r.when)) throw new DiError(`Rule "${r.id}": when must be a condition`);
    try { walk(r.when, FACTS[recordType]); } catch (e) { throw new DiError(`Rule "${r.id}": ${e.message}`); }
    return { id: r.id, when: r.when, then: r.then, message, ...(typeof r.src === "string" ? { src: r.src.slice(0, 300) } : {}) };
  });
}

/** The first rule whose condition is true decides; a missing fact reads as null. */
export function decide(rules, facts) {
  for (const rule of rules ?? []) {
    if (jsonLogic.apply(rule.when, facts)) return { decision: rule.then, rule };
  }
  return { decision: "allow", rule: null };
}

/** Models may copy dotted names from the facts menu. Resolve them to the same shape as documentFacts. */
function exampleFacts(facts) {
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) throw new DiError("facts must be an object");
  const result = {};
  const put = (path, value) => {
    const [root, key] = path.split(".");
    const group = !key && Object.keys(FACTS.document).some((p) => p.startsWith(`${root}.`));
    if (!Object.hasOwn(FACTS.document, path) && !(group && value === null)) {
      throw new DiError(`Unknown example fact "${path}". Use only: ${Object.keys(FACTS.document).join(", ")}`);
    }
    if (value !== null && typeof value === "object") throw new DiError(`Example fact "${path}" must be a scalar or null`);
    if (key && Object.hasOwn(result, root) && (result[root] === null || typeof result[root] !== "object")) {
      throw new DiError(`Conflicting example facts for "${root}" and "${path}"`);
    }
    const target = key ? (result[root] ??= {}) : result;
    const name = key ?? root;
    if (Object.hasOwn(target, name) && !Object.is(target[name], value)) throw new DiError(`Conflicting example facts for "${path}"`);
    target[name] = value;
  };
  for (const [path, value] of Object.entries(facts)) {
    if (!path.includes(".") && value !== null && typeof value === "object" && !Array.isArray(value)) {
      if (!Object.keys(FACTS.document).some((p) => p.startsWith(`${path}.`))) throw new DiError(`Unknown example fact group "${path}"`);
      for (const [key, item] of Object.entries(value)) put(`${path}.${key}`, item);
    } else put(path, value);
  }
  return result;
}

/** Proves a rule list before it is saved: every example must decide as expected, and both outcomes appear. */
export function checkExamples(rules, examples) {
  if (!rules.length) return;
  const list = examples ?? [];
  list.forEach((e, i) => {
    let facts;
    try { facts = exampleFacts(e.facts); } catch (error) { throw new DiError(`Example ${i + 1}: ${error.message}`); }
    const { decision, rule } = decide(rules, facts);
    if (decision !== e.expect) throw new DiError(`Example ${i + 1}: expected ${e.expect}, got ${decision} (rule ${rule?.id ?? "none"})`);
  });
  if (!list.some((e) => e.expect === "allow") || !list.some((e) => e.expect === "block")) {
    throw new DiError("Give at least one example that must be allowed and one that must be blocked");
  }
}

/** The facts of a document as it would be committed, plus who is asking. Run after recalc, in the same transaction. */
export async function documentFacts(tx, documentId, action) {
  const doc = (await tx.query("SELECT doc_type, status, currency, subtotal, total FROM di.document WHERE id = $1", [documentId])).rows[0];
  const lines = (await tx.query(
    `SELECT quantity::float AS qty, subtotal::float AS subtotal,
            coalesce((meta->>'list_price')::float, unit_price::float) AS list_price
       FROM di.document_line WHERE document_id = $1 AND deleted_at IS NULL`, [documentId])).rows;
  const pct = (list, net) => (list > 0 ? round2(((list - net) / list) * 100) : 0);
  const listTotal = lines.reduce((s, l) => s + l.qty * l.list_price, 0);
  const requester = (await tx.query(
    `SELECT u.username, c.access, c.name AS category, u.department FROM users u LEFT JOIN user_category c ON c.id = u.category_id
      WHERE u.id = nullif(current_setting('di.actor_user_id', true), '')`)).rows[0] ?? null;
  return {
    action,
    document: {
      doc_type: doc.doc_type, status: doc.status, currency: doc.currency, line_count: lines.length,
      list_total: round2(listTotal), subtotal: Number(doc.subtotal), total: Number(doc.total),
      discount_pct: pct(listTotal, Number(doc.subtotal)),
      max_line_discount_pct: Math.max(0, ...lines.map((l) => pct(l.qty * l.list_price, l.subtotal))),
    },
    requester,
  };
}

async function readRules(tx, recordType) {
  return (await tx.query("SELECT rules FROM di.gate WHERE record_type = $1 AND deleted_at IS NULL", [recordType])).rows[0]?.rules ?? [];
}

/** Throws a DiError when the company's gates block this save or issue of the document. */
export async function enforceDocumentGates(tx, documentId, action) {
  const rules = await readRules(tx, "document");
  if (!rules.length) return;
  const { decision, rule } = decide(rules, await documentFacts(tx, documentId, action));
  if (decision === "block") throw new DiError(`Blocked by company rule "${rule.id}": ${rule.message}`);
}

export async function getGates(tx, { record_type }) {
  const rules = await readRules(tx, record_type);
  return { record_type, rules, program: renderProgram(rules), facts: FACTS[record_type] };
}

/** Replaces the whole ordered list. Sorting a list means sending it again in the new order. */
export async function setGates(tx, { record_type, program, examples }) {
  if (typeof program !== "string") throw new DiError("Send the whole gate list as program (an empty program clears all gates)");
  const clean = validateGates(record_type, compileProgram(program));
  checkExamples(clean, examples);
  await tx.query(
    `INSERT INTO di.gate (record_type, rules) VALUES ($1, $2)
     ON CONFLICT (tenant_id, record_type) WHERE deleted_at IS NULL DO UPDATE SET rules = EXCLUDED.rules`,
    [record_type, JSON.stringify(clean)],
  );
  return { record_type, rules: clean, program: renderProgram(clean) };
}
