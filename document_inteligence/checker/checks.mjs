// Code checks: exact, cheap, no model. Each returns a list of problems (strings).
// Only rules that can be decided mechanically live here; judgement goes to the judge.

const REASONING = /<\/?\s*(think|thinking|reasoning|analysis)\b[^>]*>/i;
const DOC_NUMBER = /\b(?:QT|INV|CN|RCP)-\d{4}-\d{3,}\b/g;
const CUSTOMER_CODE = /\bC-\d{4,}\b/g;
const STATUSES = ["partially_paid", "partially paid", "draft", "issued", "accepted", "rejected", "expired", "converted", "void", "voided", "paid", "cancelled"];
const STATUS_WORD = new RegExp(`\\b(${STATUSES.map((s) => s.replace(" ", "[ _]")).join("|")})\\b`, "gi");

const norm = (status) => status.toLowerCase().replace(" ", "_").replace(/^voided$/, "void");

export function reasoningLeak(reply) {
  return REASONING.test(reply) ? ["The reply contains internal reasoning tags (<think> or similar). Remove them and send only the answer."] : [];
}

export function emptyReply(reply) {
  return reply.trim() ? [] : ["The reply is empty. Give the user a final answer."];
}

/** Every text a turn saw: user input plus tool args/results. Numbers found here are grounded. */
function groundText(input, toolCalls) {
  return [input, ...toolCalls.map((c) => JSON.stringify([c.args, c.result ?? c.error ?? null]))].join("\n");
}

/**
 * A document number or customer code in the reply must exist in the database or appear
 * in this turn's input/tool data. Catches predicted numbers ("the next one will be INV-2026-0002").
 */
export async function unknownIdentifiers(reply, { input, toolCalls, lookup }) {
  const ground = groundText(input, toolCalls);
  const ids = [...new Set([...(reply.match(DOC_NUMBER) || []), ...(reply.match(CUSTOMER_CODE) || [])])];
  const problems = [];
  for (const id of ids) {
    if (ground.includes(id)) continue;
    if (lookup && (await lookup(id))) continue;
    problems.push(`The reply mentions ${id}, which does not exist. Do not predict or invent numbers; a number exists only after the tool returns it.`);
  }
  return problems;
}

const cells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

const isStatusLabel = (cell) => /^\W*status\W*$/i.test(cell);
const docIds = (text) => [...new Set(text.match(DOC_NUMBER) || [])].filter((id) => !id.startsWith("RCP-"));

/**
 * Status claims that can be tied to exactly one document:
 *   a prose line containing "status" and one document number;
 *   a table with a Status column, one document number per row;
 *   a table with a Status row, one document number per column.
 */
function statusClaims(reply) {
  const claims = [];
  const lines = reply.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) {
      const ids = docIds(lines[i]);
      if (ids.length === 1 && /\bstatus\b/i.test(lines[i])) claims.push({ id: ids[0], text: lines[i] });
      continue;
    }
    const rows = [];
    for (; i < lines.length && lines[i].trim().startsWith("|"); i++) {
      if (!/^\|?[\s:|-]+\|?$/.test(lines[i].trim())) rows.push(cells(lines[i]));
    }
    i--;
    const [header = [], ...body] = rows;
    const col = docIds(header.join("|")).length ? -1 : header.findIndex(isStatusLabel);
    if (col >= 0) {
      for (const row of body) {
        const ids = docIds(row.join("|"));
        if (ids.length === 1) claims.push({ id: ids[0], text: row[col] ?? "" });
      }
    }
    const statusRow = rows.find((row) => isStatusLabel(row[0] ?? ""));
    if (statusRow) {
      for (let j = 1; j < statusRow.length; j++) {
        const ids = docIds(rows.map((row) => row[j] ?? "").join("|"));
        if (ids.length === 1) claims.push({ id: ids[0], text: statusRow[j] });
      }
    }
  }
  return claims;
}

/** A status claimed for a document must match the stored one ("accepted" after it became "converted"). */
export async function wrongStatus(reply, { lookup }) {
  if (!lookup) return [];
  const problems = [];
  for (const { id, text } of statusClaims(reply)) {
    const said = [...new Set((text.match(STATUS_WORD) || []).map(norm))];
    if (!said.length) continue;
    const stored = await lookup(id);
    if (!stored?.status || said.includes(stored.status)) continue;
    problems.push(`The reply says ${id} is "${said.join("/")}", but its stored status is "${stored.status}". Report the final stored status.`);
  }
  return [...new Set(problems)];
}

export async function runCodeChecks(reply, ctx) {
  return [
    ...emptyReply(reply),
    ...reasoningLeak(reply),
    ...(await unknownIdentifiers(reply, ctx)),
    ...(await wrongStatus(reply, ctx)),
  ];
}
