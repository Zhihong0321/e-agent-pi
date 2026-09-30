// DB Manager + Template Designer operations: company profile, schema description,
// custom fields, readiness rules, numbering, tax codes, templates, audit, archiving.
// "Changing the schema" here means data in di.field_def / di.workflow_def: agents
// never run DDL, so a tenant's customisation can't break the tables.
import { DiError, defined, isUuid, requireRow, round2, setClause } from "./common.mjs";
import { CHECKS, validateRules } from "./workflows.mjs";
import { addressLines, checkTemplate, partyView, renderTemplate, sampleContext } from "./templates.mjs";

import { getCompanyProfile } from './company.mjs';
export { getCompanyProfile, updateCompanyProfile } from './company.mjs';

export async function describeSchema(tx, { entity } = {}) {
  const entities = (
    await tx.query(
      "SELECT entity, label, description, match_keys FROM di.entity_def WHERE deleted_at IS NULL AND ($1::text IS NULL OR entity = $1) ORDER BY entity",
      [entity ?? null],
    )
  ).rows;
  const columns = (
    await tx.query(
      `SELECT table_name AS entity, column_name, data_type, is_nullable = 'YES' AS nullable
         FROM information_schema.columns
        WHERE table_schema = 'di' AND ($1::text IS NULL OR table_name = $1)
          AND column_name NOT IN ('tenant_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'deleted_at', 'deleted_by', 'custom')
        ORDER BY table_name, ordinal_position`,
      [entity ?? null],
    )
  ).rows;
  const fields = (
    await tx.query(
      "SELECT entity, key, label, type, options, required_for, help FROM di.field_def WHERE deleted_at IS NULL AND ($1::text IS NULL OR entity = $1) ORDER BY entity, key",
      [entity ?? null],
    )
  ).rows;
  const workflows = (
    await tx.query("SELECT doc_type, transition, rules FROM di.workflow_def WHERE deleted_at IS NULL ORDER BY doc_type")
  ).rows;
  const sequences = (
    await tx.query("SELECT key, prefix, padding, next_number, yearly_reset, current_year FROM di.document_sequence WHERE deleted_at IS NULL ORDER BY key")
  ).rows;
  const byTable = {};
  for (const c of columns) (byTable[c.entity] ??= []).push(`${c.column_name} ${c.data_type}${c.nullable ? "" : " not null"}`);
  return {
    entities,
    standard_columns: byTable,
    custom_fields: fields,
    workflows: entity ? undefined : workflows,
    numbering: entity ? undefined : sequences,
    available_checks: Object.keys(CHECKS),
    rules_note:
      "Every table also has tenant_id, created_*/updated_*/deleted_* audit columns and a custom jsonb. Nothing is ever hard-deleted.",
  };
}

const CUSTOM_ENTITIES = ["customer", "contact", "product", "package", "document", "payment"];

export async function defineCustomField(tx, { entity, key, label, type, options = [], required_for = null, help = null }) {
  if (!CUSTOM_ENTITIES.includes(entity)) throw new DiError(`entity must be one of ${CUSTOM_ENTITIES.join(", ")}`);
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(key || "")) throw new DiError("key must be snake_case, start with a letter, max 48 chars");
  if (type === "select" && !options.length) throw new DiError("a select field needs options");
  if (required_for && !/^(save|(quotation|invoice|credit_note)\.issue)$/.test(required_for)) {
    throw new DiError("required_for must be save, quotation.issue, invoice.issue or credit_note.issue");
  }
  const standard = (
    await tx.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'di' AND table_name = $1 AND column_name = $2", [entity, key])
  ).rows;
  if (standard.length) throw new DiError(`${entity}.${key} is already a standard column; no custom field needed`);
  const existing = (await tx.query("SELECT * FROM di.field_def WHERE entity = $1 AND key = $2", [entity, key])).rows[0];
  if (existing) {
    if (existing.type !== type) throw new DiError(`${entity}.${key} exists as ${existing.type}; changing type would break stored values. Pick a new key.`);
    await tx.query(
      "UPDATE di.field_def SET label = $1, options = $2, required_for = $3, help = $4, deleted_at = NULL, deleted_by = NULL WHERE id = $5",
      [label, JSON.stringify(options), required_for, help, existing.id],
    );
  } else {
    await tx.query(
      "INSERT INTO di.field_def (entity, key, label, type, options, required_for, help) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [entity, key, label, type, JSON.stringify(options), required_for, help],
    );
  }
  return describeSchema(tx, { entity });
}

export async function setWorkflowRules(tx, { doc_type, transition = "issue", rules }) {
  validateRules(rules);
  const blocking = rules.filter((r) => r.severity === "block").map((r) => r.check);
  for (const must of ["customer_selected", "has_lines", "template_available"]) {
    if (!blocking.includes(must)) throw new DiError(`${must} must stay a blocking rule; documents break without it`);
  }
  await tx.query(
    `INSERT INTO di.workflow_def (doc_type, transition, rules) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, doc_type, transition) DO UPDATE SET rules = EXCLUDED.rules, deleted_at = NULL`,
    [doc_type, transition, JSON.stringify(rules)],
  );
  return { doc_type, transition, rules };
}

export async function setNumbering(tx, { key, prefix, padding, next_number, yearly_reset }) {
  const seq = (await tx.query("SELECT * FROM di.document_sequence WHERE key = $1 AND deleted_at IS NULL", [key])).rows[0];
  if (!seq) {
    if (!prefix) throw new DiError(`No sequence ${key}; give a prefix to create it`);
    await tx.query("INSERT INTO di.document_sequence (key, prefix, padding, next_number, yearly_reset) VALUES ($1,$2,$3,$4,$5)", [
      key, prefix, padding ?? 4, next_number ?? 1, yearly_reset ?? true,
    ]);
  } else {
    if (next_number !== undefined && Number(next_number) < Number(seq.next_number)) {
      throw new DiError(`next_number can only move forward (currently ${seq.next_number}); reusing numbers breaks the audit trail`);
    }
    const patch = defined({ prefix, padding, next_number, yearly_reset });
    const { sql, values } = setClause(patch, ["prefix", "padding", "next_number", "yearly_reset"]);
    if (sql) await tx.query(`UPDATE di.document_sequence SET ${sql} WHERE id = $${values.length + 1}`, [...values, seq.id]);
  }
  return (await tx.query("SELECT key, prefix, padding, next_number, yearly_reset FROM di.document_sequence WHERE key = $1", [key])).rows[0];
}

export async function saveTaxCode(tx, { code, name, rate, kind = "none", is_default }) {
  if (!code || !name || rate === undefined) throw new DiError("code, name and rate are required");
  const upper = String(code).toUpperCase();
  if (is_default) await tx.query("UPDATE di.tax_code SET is_default = false WHERE is_default AND upper(code) <> $1", [upper]);
  await tx.query(
    `INSERT INTO di.tax_code (code, name, rate, kind, is_default) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name, rate = EXCLUDED.rate, kind = EXCLUDED.kind,
       is_default = EXCLUDED.is_default, deleted_at = NULL`,
    [upper, name, round2(rate), kind, Boolean(is_default)],
  );
  return { code: upper, name, rate: Number(rate), kind, is_default: Boolean(is_default) };
}

export async function readAuditLog(tx, { entity, entity_id, limit = 30 } = {}) {
  const { rows } = await tx.query(
    `SELECT at, actor, agent, action, entity, entity_id, before, after FROM di.audit_log
      WHERE ($1::text IS NULL OR entity = $1) AND ($2::uuid IS NULL OR entity_id = $2)
      ORDER BY id DESC LIMIT $3`,
    [entity ?? null, entity_id ?? null, Math.min(Number(limit) || 30, 200)],
  );
  const NOISE = new Set(["updated_at", "updated_by", "created_at", "created_by"]);
  return {
    entries: rows.map((r) => {
      const changed =
        r.before && r.after
          ? Object.keys(r.after).filter((k) => !NOISE.has(k) && JSON.stringify(r.before[k]) !== JSON.stringify(r.after[k]))
          : null;
      return {
        at: r.at,
        actor: r.actor,
        agent: r.agent,
        action: r.action,
        entity: r.entity,
        entity_id: r.entity_id,
        ...(changed ? { changed: Object.fromEntries(changed.map((k) => [k, { from: r.before[k], to: r.after[k] }])) } : {}),
      };
    }),
  };
}

// ---------------------------------------------------------------- archiving (soft delete)

const ARCHIVABLE = {
  customer: async (tx, row) => {
    const open = (
      await tx.query(
        "SELECT number FROM di.document WHERE customer_id = $1 AND status IN ('draft', 'issued', 'partially_paid', 'accepted') AND deleted_at IS NULL",
        [row.id],
      )
    ).rows;
    if (open.length) throw new DiError(`Customer has open documents (${open.map((d) => d.number || "draft").join(", ")}); settle or cancel them first`);
  },
  contact: null,
  product: null,
  package: null,
  template: async (tx, row) => {
    const others = (
      await tx.query("SELECT count(*)::int AS n FROM di.template WHERE doc_type = $1 AND id <> $2 AND deleted_at IS NULL", [row.doc_type, row.id])
    ).rows[0].n;
    if (!others) throw new DiError(`That is the last ${row.doc_type} template; create a replacement before archiving it`);
  },
  field_def: null,
};

export function archiver(allowed) {
  return async (tx, { entity, id, reason }) => {
    if (!allowed.includes(entity)) throw new DiError(`This agent can archive: ${allowed.join(", ")}`);
    if (!isUuid(id)) throw new DiError("id must be the record's uuid");
    const row = await requireRow(tx, entity, id, entity);
    await ARCHIVABLE[entity]?.(tx, row);
    await tx.query(`UPDATE di.${entity} SET deleted_at = now() WHERE id = $1`, [id]);
    return { archived: { entity, id, name: row.name || row.label || row.key || row.code }, reason: reason ?? null, restorable: true };
  };
}

export async function restoreRecord(tx, { entity, id }) {
  if (!Object.keys(ARCHIVABLE).includes(entity)) throw new DiError(`entity must be one of ${Object.keys(ARCHIVABLE).join(", ")}`);
  const { rows } = await tx.query(`UPDATE di.${entity} SET deleted_at = NULL, deleted_by = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id`, [id]);
  if (!rows[0]) throw new DiError(`No archived ${entity} ${id}`);
  return { restored: { entity, id } };
}

// ---------------------------------------------------------------- templates

export async function listTemplates(tx, { doc_type } = {}) {
  const { rows } = await tx.query(
    `SELECT id, doc_type, name, version, is_default, notes, updated_at FROM di.template
      WHERE deleted_at IS NULL AND ($1::text IS NULL OR doc_type = $1) ORDER BY doc_type, is_default DESC, version DESC`,
    [doc_type ?? null],
  );
  return { templates: rows };
}

export async function getTemplate(tx, { id }) {
  const row = await requireRow(tx, "template", id, "Template");
  return { template: row };
}

/**
 * Saves a template as a NEW version row (old versions stay, so issued documents
 * keep rendering exactly as they were issued).
 */
export async function saveTemplate(tx, { doc_type, name, html, make_default = true, notes, based_on }) {
  if (!["quotation", "invoice", "credit_note"].includes(doc_type)) throw new DiError("doc_type must be quotation, invoice or credit_note");
  const check = checkTemplate(html);
  if (!check.ok) throw new DiError(`Template does not parse: ${check.error}`);
  const version =
    Number((await tx.query("SELECT coalesce(max(version), 0) AS v FROM di.template WHERE doc_type = $1 AND name = $2", [doc_type, name])).rows[0].v) + 1;
  if (make_default) await tx.query("UPDATE di.template SET is_default = false WHERE doc_type = $1 AND is_default", [doc_type]);
  const { rows } = await tx.query(
    "INSERT INTO di.template (doc_type, name, version, html, is_default, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, doc_type, name, version, is_default",
    [doc_type, name, version, html, Boolean(make_default), notes ?? (based_on ? `Based on ${based_on}` : null)],
  );
  return { template: rows[0], unknown_fields: check.unknownFields };
}

export async function setDefaultTemplate(tx, { id }) {
  const row = await requireRow(tx, "template", id, "Template");
  await tx.query("UPDATE di.template SET is_default = false WHERE doc_type = $1 AND is_default", [row.doc_type]);
  await tx.query("UPDATE di.template SET is_default = true WHERE id = $1", [id]);
  return { default: { id, doc_type: row.doc_type, name: row.name, version: row.version } };
}

/** Renders a template (saved or unsaved) against sample data + the real company profile. */
export async function previewTemplateHtml(tx, { id, html, doc_type = "invoice" }) {
  let src = html;
  let type = doc_type;
  if (id) {
    const row = await requireRow(tx, "template", id, "Template");
    src = row.html;
    type = row.doc_type;
  }
  if (!src) throw new DiError("Give a template id or html");
  const check = checkTemplate(src);
  if (!check.ok) throw new DiError(`Template does not parse: ${check.error}`);
  const ctx = sampleContext(type);
  const company = (await getCompanyProfile(tx)).company;
  if (company?.name) {
    ctx.company = partyView({ ...ctx.company, ...company, legal_name: company.legal_name || company.name });
  }
  return { html: renderTemplate(src, ctx), unknown_fields: check.unknownFields, doc_type: type };
}

/** The variables a template can use, for the Template Designer. */
export function templateVariables() {
  const ctx = sampleContext("invoice");
  return {
    syntax: "{{path}} escaped value · {{#each list}}…{{/each}} (inside: {{field}} or {{this}}) · {{#if path}}…{{else}}…{{/if}}",
    doc: Object.keys(ctx.doc),
    company: [...Object.keys(ctx.company)],
    customer: [...Object.keys(ctx.customer)],
    lines_item: Object.keys(ctx.lines[0]),
    tax_summary_item: ["code", "rate", "taxable", "tax"],
    notes: "address_lines are arrays: {{#each company.address_lines}}{{this}}<br>{{/each}}. doc.is_draft is true until issued. Amounts are pre-formatted strings.",
  };
}
