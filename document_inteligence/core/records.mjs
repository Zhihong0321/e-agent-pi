// CRM records: customers, contacts, and name-card intake with duplicate matching.
import {
  DiError,
  defined,
  nameSimilarity,
  nameTokens,
  nextNumber,
  normEmail,
  normPhone,
  normRegNo,
  requireRow,
  setClause,
  validateCustom,
  isUuid,
} from "./common.mjs";

const CUSTOMER_FIELDS = [
  "kind", "name", "legal_name", "reg_no", "id_type", "tin", "sst_no", "industry", "email", "phone",
  "website", "billing_address", "shipping_address", "payment_terms_days", "source", "notes", "custom",
];
const CONTACT_FIELDS = ["name", "job_title", "email", "phone", "mobile", "is_primary", "notes", "custom"];

const tail9 = (p) => normPhone(p).slice(-9);

/**
 * Scores existing customers against what we know about a (possibly) new one.
 * Returns verdict: "existing" (>= 90), "possible" (40-89) or "new".
 */
export async function matchCustomer(tx, input = {}) {
  const regNo = normRegNo(input.reg_no) || null;
  const tin = normRegNo(input.tin) || null;
  const emails = [input.email, input.contact_email].map(normEmail).filter(Boolean);
  const phones = [input.phone, input.mobile].map(tail9).filter((p) => p.length === 9);
  const companyName = input.company_name || input.name || "";
  const tokens = nameTokens(companyName).filter((t) => t.length >= 3);
  const personTokens = nameTokens(input.person_name).filter((t) => t.length >= 3);
  const emailDomain = emails[0]?.split("@")[1];
  const freeMail = /^(gmail|yahoo|hotmail|outlook|live|icloud|me|ymail)\./.test(emailDomain || "");

  const { rows } = await tx.query(
    `SELECT DISTINCT c.*
       FROM di.customer c
       LEFT JOIN di.contact ct ON ct.customer_id = c.id AND ct.deleted_at IS NULL
      WHERE c.deleted_at IS NULL AND (
        ($1::text IS NOT NULL AND regexp_replace(upper(coalesce(c.reg_no, '')), '[^0-9A-Z]', '', 'g') LIKE '%' || $1 || '%')
        OR ($2::text IS NOT NULL AND regexp_replace(upper(coalesce(c.tin, '')), '[^0-9A-Z]', '', 'g') = $2)
        OR (lower(c.email) = ANY($3::text[]) OR lower(ct.email) = ANY($3::text[]))
        OR ($6::text IS NOT NULL AND (lower(c.email) LIKE '%@' || $6 OR lower(ct.email) LIKE '%@' || $6))
        OR right(regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g'), 9) = ANY($4::text[])
        OR right(regexp_replace(coalesce(ct.phone, ''), '\\D', '', 'g'), 9) = ANY($4::text[])
        OR right(regexp_replace(coalesce(ct.mobile, ''), '\\D', '', 'g'), 9) = ANY($4::text[])
        OR lower(c.name) LIKE ANY($5::text[])
        OR lower(coalesce(c.legal_name, '')) LIKE ANY($5::text[])
        OR lower(ct.name) LIKE ANY($7::text[])
      )
      LIMIT 40`,
    [
      regNo,
      tin,
      emails,
      phones,
      tokens.map((t) => `%${t}%`),
      emailDomain && !freeMail ? emailDomain : null,
      personTokens.map((t) => `%${t}%`),
    ],
  );

  const candidates = [];
  for (const c of rows) {
    const contacts = (
      await tx.query(
        "SELECT id, name, job_title, email, phone, mobile, is_primary FROM di.contact WHERE customer_id = $1 AND deleted_at IS NULL ORDER BY is_primary DESC, created_at",
        [c.id],
      )
    ).rows;
    let score = 0;
    const reasons = [];
    if (regNo && normRegNo(c.reg_no) === regNo) {
      score = Math.max(score, 100);
      reasons.push("same registration no.");
    }
    if (tin && normRegNo(c.tin) === tin) {
      score = Math.max(score, 100);
      reasons.push("same TIN");
    }
    const allEmails = [c.email, ...contacts.map((x) => x.email)].map(normEmail).filter(Boolean);
    if (emails.some((e) => allEmails.includes(e))) {
      score = Math.max(score, 90);
      reasons.push("same email");
    } else if (emailDomain && !freeMail && allEmails.some((e) => e.endsWith(`@${emailDomain}`))) {
      score = Math.max(score, 60);
      reasons.push(`same email domain @${emailDomain}`);
    }
    const allPhones = [c.phone, ...contacts.flatMap((x) => [x.phone, x.mobile])].map(tail9).filter(Boolean);
    if (phones.some((p) => allPhones.includes(p))) {
      score = Math.max(score, 75);
      reasons.push("same phone number");
    }
    const sim = Math.max(nameSimilarity(companyName, c.name), nameSimilarity(companyName, c.legal_name));
    if (sim >= 0.99) {
      score = Math.max(score, 80);
      reasons.push("same name");
    } else if (sim >= 0.6) {
      score = Math.max(score, 55);
      reasons.push("similar name");
    } else if (sim >= 0.34) {
      score = Math.max(score, 30);
      reasons.push("partly similar name");
    }
    const personHit = input.person_name && contacts.find((x) => nameSimilarity(x.name, input.person_name) >= 0.99);
    if (personHit) {
      score = Math.min(100, score + 15);
      reasons.push(`already has contact ${personHit.name}`);
    }
    if (score > 0) {
      candidates.push({
        customer_id: c.id,
        code: c.code,
        name: c.name,
        reg_no: c.reg_no,
        email: c.email,
        phone: c.phone,
        score,
        reasons,
        contacts,
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0]?.score ?? 0;
  const verdict = top >= 90 ? "existing" : top >= 40 ? "possible" : "new";
  const advice = {
    existing: "Very likely an existing customer. Link to it (fill blanks / add the contact) instead of creating a new one.",
    possible: "Possibly an existing customer. Show the candidates and ask the user before saving.",
    new: "No match. Safe to create a new customer.",
  }[verdict];
  return { verdict, advice, candidates: candidates.slice(0, 5) };
}

async function insertCustomer(tx, fields) {
  const code = await nextNumber(tx, "customer");
  const row = { ...fields, code };
  const cols = Object.keys(row);
  const values = cols.map((k) => (row[k] !== null && typeof row[k] === "object" ? JSON.stringify(row[k]) : row[k]));
  const { rows } = await tx.query(
    `INSERT INTO di.customer (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
    values,
  );
  return rows[0];
}

/** Create or update a customer. Creating runs matchCustomer first and refuses likely duplicates. */
export async function saveCustomer(tx, args = {}) {
  const { id, allow_duplicate, ...rest } = args;
  const patch = defined(rest);
  if (patch.custom) patch.custom = await validateCustom(tx, "customer", patch.custom, { creating: !id });
  else if (!id) await validateCustom(tx, "customer", {}, { creating: true });
  if (patch.email) patch.email = normEmail(patch.email);

  if (id) {
    const existing = await requireRow(tx, "customer", id, "Customer");
    if (patch.custom) patch.custom = { ...existing.custom, ...patch.custom };
    const { sql, values } = setClause(patch, CUSTOMER_FIELDS);
    if (!sql) return { customer: existing, changed: [] };
    const { rows } = await tx.query(`UPDATE di.customer SET ${sql} WHERE id = $${values.length + 1} RETURNING *`, [
      ...values,
      id,
    ]);
    return { customer: rows[0], changed: Object.keys(patch).filter((k) => CUSTOMER_FIELDS.includes(k)) };
  }

  if (!patch.name) throw new DiError("A customer needs a name");
  if (!allow_duplicate) {
    const match = await matchCustomer(tx, { ...patch, company_name: patch.name });
    if (match.verdict === "existing") {
      throw new DiError(
        `Looks like an existing customer: ${match.candidates[0].code} ${match.candidates[0].name} (${match.candidates[0].reasons.join(", ")}). Update it instead, or pass allow_duplicate=true if the user confirmed it is different.`,
        match,
      );
    }
  }
  const fields = Object.fromEntries(Object.entries(patch).filter(([k]) => CUSTOMER_FIELDS.includes(k)));
  return { customer: await insertCustomer(tx, fields), changed: ["created"] };
}

export async function saveContact(tx, args = {}) {
  const { id, customer_id, ...rest } = args;
  const patch = defined(rest);
  if (patch.custom) patch.custom = await validateCustom(tx, "contact", patch.custom, { creating: !id });
  if (patch.email) patch.email = normEmail(patch.email);
  if (id) {
    const existing = await requireRow(tx, "contact", id, "Contact");
    if (patch.custom) patch.custom = { ...existing.custom, ...patch.custom };
    const { sql, values } = setClause(patch, CONTACT_FIELDS);
    if (!sql) return { contact: existing };
    const { rows } = await tx.query(`UPDATE di.contact SET ${sql} WHERE id = $${values.length + 1} RETURNING *`, [
      ...values,
      id,
    ]);
    return { contact: rows[0] };
  }
  await requireRow(tx, "customer", customer_id, "Customer");
  if (!patch.name) throw new DiError("A contact needs a name");
  const others = await tx.query("SELECT count(*)::int AS n FROM di.contact WHERE customer_id = $1 AND deleted_at IS NULL", [
    customer_id,
  ]);
  const row = { customer_id, is_primary: others.rows[0].n === 0, ...patch };
  const cols = Object.keys(row).filter((k) => k === "customer_id" || CONTACT_FIELDS.includes(k));
  const values = cols.map((k) => (row[k] !== null && typeof row[k] === "object" ? JSON.stringify(row[k]) : row[k]));
  const { rows } = await tx.query(
    `INSERT INTO di.contact (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
    values,
  );
  return { contact: rows[0] };
}

const blank = (v) => v === undefined || v === null || String(v).trim() === "" || (typeof v === "object" && !Object.keys(v).length);

/**
 * Records a scanned name card in one transaction: customer (new, or an existing
 * one the user confirmed), the person as a contact, and the card image as evidence.
 * On an existing customer only blank fields are filled; nothing is overwritten.
 */
export async function saveNameCard(tx, args = {}) {
  // source/evidence are internal: a form submission reuses this flow and is its own evidence.
  const { card = {}, customer_id, image_path, allow_duplicate, source = "name_card", evidence } = args;
  const person = card.person_name?.trim();
  const company = card.company_name?.trim();
  if (!person && !company) throw new DiError("The card needs at least a person or a company name");

  let customer;
  let createdCustomer = false;
  const filled = [];
  const companyFields = defined({
    legal_name: card.legal_name,
    reg_no: card.reg_no,
    tin: card.tin,
    sst_no: card.sst_no,
    industry: card.industry,
    email: company ? card.company_email : card.email,
    phone: card.office_phone || (company ? undefined : card.phone),
    website: card.website,
    billing_address: card.address,
  });

  if (customer_id) {
    customer = await requireRow(tx, "customer", customer_id, "Customer");
    const fill = Object.fromEntries(Object.entries(companyFields).filter(([k, v]) => blank(customer[k]) && !blank(v)));
    if (Object.keys(fill).length) {
      customer = (await saveCustomer(tx, { id: customer_id, ...fill })).customer;
      filled.push(...Object.keys(fill));
    }
  } else {
    customer = (
      await saveCustomer(tx, {
        kind: company ? "company" : "individual",
        name: company || person,
        source,
        allow_duplicate,
        ...companyFields,
      })
    ).customer;
    createdCustomer = true;
  }

  let contact = null;
  let createdContact = false;
  if (person) {
    const existing = (
      await tx.query("SELECT * FROM di.contact WHERE customer_id = $1 AND deleted_at IS NULL", [customer.id])
    ).rows.find(
      (c) =>
        (card.email && normEmail(c.email) === normEmail(card.email)) ||
        (card.mobile && normPhone(c.mobile) === normPhone(card.mobile)) ||
        nameSimilarity(c.name, person) >= 0.99,
    );
    const contactFields = defined({
      name: person,
      job_title: card.job_title,
      email: card.email,
      phone: card.phone,
      mobile: card.mobile,
    });
    if (existing) {
      const fill = Object.fromEntries(Object.entries(contactFields).filter(([k, v]) => blank(existing[k]) && !blank(v)));
      contact = Object.keys(fill).length ? (await saveContact(tx, { id: existing.id, ...fill })).contact : existing;
      filled.push(...Object.keys(fill).map((k) => `contact.${k}`));
    } else {
      contact = (await saveContact(tx, { customer_id: customer.id, ...contactFields })).contact;
      createdContact = true;
    }
  }

  if (!evidence && (image_path || Object.keys(card).length)) {
    await tx.query(
      `INSERT INTO di.attachment (entity, entity_id, kind, file_path, mime, extracted) VALUES ('customer', $1, 'name_card', $2, $3, $4)`,
      [customer.id, image_path || null, image_path ? guessMime(image_path) : null, JSON.stringify(card)],
    );
  }

  return {
    customer: pickCustomer(customer),
    contact: contact && { id: contact.id, name: contact.name, job_title: contact.job_title, email: contact.email, mobile: contact.mobile },
    created: { customer: createdCustomer, contact: createdContact },
    filled_blanks: filled,
  };
}

function guessMime(p) {
  const ext = String(p).toLowerCase().split(".").pop();
  return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", pdf: "application/pdf" }[ext] || null;
}

const pickCustomer = (c) =>
  c && {
    id: c.id,
    code: c.code,
    kind: c.kind,
    name: c.name,
    reg_no: c.reg_no,
    tin: c.tin,
    email: c.email,
    phone: c.phone,
    billing_address: c.billing_address,
    payment_terms_days: c.payment_terms_days,
  };

async function resolveCustomerRef(tx, ref) {
  if (isUuid(ref)) return requireRow(tx, "customer", ref, "Customer");
  const { rows } = await tx.query("SELECT * FROM di.customer WHERE upper(code) = upper($1) AND deleted_at IS NULL", [ref]);
  if (!rows[0]) throw new DiError(`Customer ${ref} not found`);
  return rows[0];
}

export async function getCustomer(tx, { ref }) {
  const customer = await resolveCustomerRef(tx, ref);
  const contacts = (
    await tx.query("SELECT * FROM di.contact WHERE customer_id = $1 AND deleted_at IS NULL ORDER BY is_primary DESC, created_at", [
      customer.id,
    ])
  ).rows;
  const documents = (
    await tx.query(
      `SELECT id, doc_type, number, status, issue_date, total, amount_paid
         FROM di.document WHERE customer_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 10`,
      [customer.id],
    )
  ).rows;
  const outstanding = (
    await tx.query(
      `SELECT coalesce(sum(total - amount_paid), 0)::numeric(14,2) AS amount
         FROM di.document WHERE customer_id = $1 AND doc_type = 'invoice' AND status IN ('issued', 'partially_paid') AND deleted_at IS NULL`,
      [customer.id],
    )
  ).rows[0].amount;
  return { customer, contacts, recent_documents: documents, outstanding: Number(outstanding) };
}

export async function findCustomers(tx, { query = "", limit = 10 } = {}) {
  const q = `%${String(query).trim().toLowerCase()}%`;
  const { rows } = await tx.query(
    `SELECT DISTINCT c.id, c.code, c.name, c.reg_no, c.email, c.phone, c.created_at
       FROM di.customer c LEFT JOIN di.contact ct ON ct.customer_id = c.id AND ct.deleted_at IS NULL
      WHERE c.deleted_at IS NULL AND (
        $1 = '%%' OR lower(c.name) LIKE $1 OR lower(c.code) LIKE $1 OR lower(coalesce(c.email, '')) LIKE $1
        OR lower(coalesce(c.reg_no, '')) LIKE $1 OR lower(ct.name) LIKE $1 OR lower(coalesce(ct.email, '')) LIKE $1)
      ORDER BY c.created_at DESC LIMIT $2`,
    [q, Math.min(Number(limit) || 10, 50)],
  );
  return { customers: rows.map(({ created_at, ...r }) => r) };
}

export { resolveCustomerRef };
