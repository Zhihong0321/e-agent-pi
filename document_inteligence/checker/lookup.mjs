// Read-only facts for the code checks: does this number/code exist, and what is its status?

/**
 * @param {(sql: string, params: any[]) => Promise<{rows: any[]}>} query  runs inside the tenant
 * @returns {(id: string) => Promise<{kind: string, status?: string} | null>}
 */
export function dbLookup(query) {
  return async (id) => {
    if (/^RCP-/.test(id)) {
      const { rows } = await query("SELECT status FROM di.payment WHERE number = $1 LIMIT 1", [id]);
      return rows[0] ? { kind: "payment", status: rows[0].status } : null;
    }
    if (/^C-\d/.test(id)) {
      const { rows } = await query("SELECT code FROM di.customer WHERE code = $1 LIMIT 1", [id]);
      return rows[0] ? { kind: "customer" } : null;
    }
    const { rows } = await query("SELECT doc_type, status FROM di.document WHERE number = $1 LIMIT 1", [id]);
    return rows[0] ? { kind: rows[0].doc_type, status: rows[0].status } : null;
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What a gated write would act on, as stored now: a canonical target (so a slug and an id of the
 * same form compare equal) and short trusted facts for the gate. Read-only.
 * @param {(sql: string, params: any[]) => Promise<{rows: any[]}>} query  runs inside the tenant
 * @returns {(tool: string, args: any) => Promise<{target: string | null, facts: string | null}>}
 */
export function dbDescribe(query) {
  return async (_tool, args = {}) => {
    if (args.form != null) {
      const ref = String(args.form).trim();
      const f = (
        await query(UUID.test(ref) ? "SELECT * FROM di.form WHERE id = $1" : "SELECT * FROM di.form WHERE slug = lower($1)", [ref])
      ).rows[0];
      if (!f) return { target: `form:${ref.toLowerCase()}`, facts: `Form "${ref}" does not exist.` };
      const versions = (
        await query("SELECT version, status, schema, settings FROM di.form_version WHERE form_id = $1 AND deleted_at IS NULL ORDER BY version", [f.id])
      ).rows;
      const lines = [`Form ${f.slug} "${f.title}": status ${f.status}, live version ${f.published_version ?? "none"}${f.deleted_at ? ", archived" : ""}.`];
      for (const v of versions) {
        const fields = (v.schema?.fields ?? []).map((x) => `${x.key} [${x.type}] "${x.label}"`).join("; ");
        lines.push(`v${v.version} (${v.status}) fields: ${fields || "none"}. consent_text: ${v.settings?.consent_text ? "set" : "missing"}.`);
      }
      return { target: `form:${f.id}`, facts: lines.join("\n") };
    }
    const ref = args.document ?? args.quotation;
    if (ref != null) {
      const d = (
        await query(UUID.test(String(ref)) ? "SELECT * FROM di.document WHERE id = $1" : "SELECT * FROM di.document WHERE upper(number) = upper($1)", [String(ref)])
      ).rows[0];
      if (!d) return { target: `document:${String(ref).toUpperCase()}`, facts: `Document "${ref}" does not exist.` };
      return {
        target: `document:${d.id}`,
        facts: `${d.doc_type} ${d.number || "draft (no number)"}: status ${d.status}, total ${d.total}, paid ${d.amount_paid}, reference ${d.reference ?? "none"}.`,
      };
    }
    return { target: null, facts: null };
  };
}
