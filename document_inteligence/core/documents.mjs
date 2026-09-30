// Quotation / invoice / credit note lifecycle, and payments.
//   draft (editable, no number) -> issued (numbered, frozen by DB trigger)
//   quotation: issued -> accepted | rejected | expired; issued/accepted -> converted (new invoice draft)
//   invoice:   issued -> partially_paid -> paid; issued (unpaid) -> void
import { addDays, DiError, isoDate, isUuid, nextNumber, requireRow, round2, todayMY, validateCustom } from "./common.mjs";
import { defaultTaxCode, getPackage, resolvePackage, resolveProduct, taxRate, findCatalog } from "./catalog.mjs";
import { matchCustomer, resolveCustomerRef } from "./records.mjs";
import { evaluate, rulesFromFieldDefs } from "./workflows.mjs";
import { buildContext, renderTemplate, snapshotCustomer, snapshotIssuer } from "./templates.mjs";
import { assertSubmissionOpen, markSubmissionProcessed, submissionOrder } from "./forms.mjs";

const DOC_TYPES = ["quotation", "invoice", "credit_note"];
const num = (v) => (v == null ? v : Number(v));

// ---------------------------------------------------------------- lines

async function buildLine(tx, input, sort) {
  const quantity = Number(input.quantity ?? 1);
  if (!(quantity > 0)) throw new DiError("quantity must be above zero");
  let line = { kind: "custom", description: input.description, unit: input.unit || "unit", meta: {} };
  if (input.product) {
    const p = await resolveProduct(tx, input.product);
    line = {
      kind: "product",
      product_id: p.id,
      description: input.description || p.name,
      unit: input.unit || p.unit,
      unit_price: Number(p.unit_price),
      tax_code: p.tax_code,
      meta: { sku: p.sku },
    };
  } else if (input.package) {
    const pkg = await getPackage(tx, { ref: (await resolvePackage(tx, input.package)).id });
    line = {
      kind: "package",
      package_id: pkg.package.id,
      description: input.description || pkg.package.name,
      unit: input.unit || "package",
      unit_price: pkg.effective_price,
      tax_code: pkg.package.tax_code,
      meta: { code: pkg.package.code, components: pkg.items.map((i) => ({ sku: i.sku, name: i.name, quantity: i.quantity })) },
    };
  } else if (!input.description) {
    throw new DiError("A line needs a product, a package, or a description with a unit_price");
  }
  if (input.unit_price !== undefined) line.unit_price = Number(input.unit_price);
  if (line.unit_price === undefined) throw new DiError(`Line "${line.description}" needs a unit_price`);
  const tax = await taxRate(tx, input.tax_code || line.tax_code || (await defaultTaxCode(tx)));
  const discount = round2(input.discount_amount || 0);
  const subtotal = round2(quantity * line.unit_price - discount);
  if (subtotal < 0) throw new DiError(`Discount on "${line.description}" is larger than the line amount`);
  const taxAmount = round2((subtotal * (tax?.rate ?? 0)) / 100);
  return {
    ...line,
    sort,
    quantity,
    unit_price: round2(line.unit_price),
    discount_amount: discount,
    tax_code: tax?.code ?? null,
    tax_rate: tax?.rate ?? 0,
    subtotal,
    tax_amount: taxAmount,
    total: round2(subtotal + taxAmount),
  };
}

async function insertLine(tx, documentId, line) {
  await tx.query(
    `INSERT INTO di.document_line (document_id, sort, kind, product_id, package_id, description, quantity, unit,
       unit_price, discount_amount, tax_code, tax_rate, subtotal, tax_amount, total, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      documentId, line.sort, line.kind, line.product_id ?? null, line.package_id ?? null, line.description,
      line.quantity, line.unit, line.unit_price, line.discount_amount, line.tax_code, line.tax_rate,
      line.subtotal, line.tax_amount, line.total, JSON.stringify(line.meta || {}),
    ],
  );
}

async function recalc(tx, documentId) {
  await tx.query(
    `UPDATE di.document d SET
        subtotal = s.subtotal, discount_total = s.discount, tax_total = s.tax, total = s.subtotal + s.tax
       FROM (SELECT coalesce(sum(subtotal), 0) AS subtotal, coalesce(sum(discount_amount), 0) AS discount,
                    coalesce(sum(tax_amount), 0) AS tax
               FROM di.document_line WHERE document_id = $1 AND deleted_at IS NULL) s
      WHERE d.id = $1`,
    [documentId],
  );
}

// ---------------------------------------------------------------- loading

async function resolveDocument(tx, ref) {
  const { rows } = isUuid(ref)
    ? await tx.query("SELECT * FROM di.document WHERE id = $1 AND deleted_at IS NULL", [ref])
    : await tx.query("SELECT * FROM di.document WHERE upper(number) = upper($1) AND deleted_at IS NULL", [ref]);
  if (!rows[0]) throw new DiError(`Document ${ref} not found`);
  return rows[0];
}

async function pickTemplate(tx, docType, templateId) {
  if (templateId) {
    const { rows } = await tx.query("SELECT * FROM di.template WHERE id = $1 AND deleted_at IS NULL", [templateId]);
    if (rows[0]) return rows[0];
  }
  const { rows } = await tx.query(
    `SELECT * FROM di.template WHERE doc_type = $1 AND deleted_at IS NULL ORDER BY is_default DESC, version DESC, created_at DESC LIMIT 1`,
    [docType],
  );
  return rows[0] ?? null;
}

async function loadContext(tx, doc) {
  const lines = (
    await tx.query("SELECT * FROM di.document_line WHERE document_id = $1 AND deleted_at IS NULL ORDER BY sort, created_at", [doc.id])
  ).rows;
  const customer = doc.customer_id
    ? (await tx.query("SELECT * FROM di.customer WHERE id = $1", [doc.customer_id])).rows[0]
    : null;
  const contact = doc.contact_id ? (await tx.query("SELECT * FROM di.contact WHERE id = $1", [doc.contact_id])).rows[0] : null;
  const tenant = (await tx.query("SELECT * FROM di.company_profile WHERE tenant_id = di.current_tenant()")).rows[0];
  const template = await pickTemplate(tx, doc.doc_type, doc.template_id);
  return { doc, lines, customer, contact, tenant, template };
}

async function rulesFor(tx, docType, transition = "issue") {
  const wf = (
    await tx.query("SELECT rules FROM di.workflow_def WHERE doc_type = $1 AND transition = $2 AND deleted_at IS NULL", [
      docType,
      transition,
    ])
  ).rows[0];
  const fields = (await tx.query("SELECT * FROM di.field_def WHERE deleted_at IS NULL")).rows;
  return [...(wf?.rules ?? []), ...rulesFromFieldDefs(fields, docType, transition)];
}

function summary(ctx, readiness) {
  const { doc, lines, customer, contact, template } = ctx;
  return {
    id: doc.id,
    doc_type: doc.doc_type,
    number: doc.number,
    status: doc.status,
    customer: customer ? { id: customer.id, code: customer.code, name: customer.name } : null,
    contact: contact ? { id: contact.id, name: contact.name } : null,
    issue_date: isoDate(doc.issue_date),
    valid_until: isoDate(doc.valid_until),
    due_date: isoDate(doc.due_date),
    reference: doc.reference,
    lines: lines.map((l) => ({
      id: l.id,
      description: l.description,
      quantity: num(l.quantity),
      unit: l.unit,
      unit_price: num(l.unit_price),
      discount_amount: num(l.discount_amount),
      tax_code: l.tax_code,
      tax_amount: num(l.tax_amount),
      total: num(l.total),
    })),
    subtotal: num(doc.subtotal),
    tax_total: num(doc.tax_total),
    total: num(doc.total),
    amount_paid: num(doc.amount_paid),
    balance: round2(num(doc.total) - num(doc.amount_paid)),
    template: template ? { id: template.id, name: template.name, version: template.version } : null,
    pdf_path: doc.pdf_path,
    source_document_id: doc.source_document_id,
    ...(readiness ? { readiness } : {}),
  };
}

export async function getDocument(tx, { ref }) {
  const doc = await resolveDocument(tx, ref);
  const ctx = await loadContext(tx, doc);
  const readiness = doc.status === "draft" ? evaluate(await rulesFor(tx, doc.doc_type), ctx) : undefined;
  const payments = (
    await tx.query(
      `SELECT p.number, p.received_on, pa.amount, p.method, p.reference
         FROM di.payment_allocation pa JOIN di.payment p ON p.id = pa.payment_id
        WHERE pa.document_id = $1 AND pa.deleted_at IS NULL AND p.status = 'recorded'`,
      [doc.id],
    )
  ).rows.map((p) => ({ ...p, received_on: isoDate(p.received_on), amount: num(p.amount) }));
  return { document: summary(ctx, readiness), payments };
}

export async function listDocuments(tx, { doc_type, status, customer, limit = 20 } = {}) {
  const customerId = customer ? (await resolveCustomerRef(tx, customer)).id : null;
  const { rows } = await tx.query(
    `SELECT d.id, d.doc_type, d.number, d.status, d.issue_date, d.total, d.amount_paid, c.code AS customer_code, c.name AS customer_name
       FROM di.document d LEFT JOIN di.customer c ON c.id = d.customer_id
      WHERE d.deleted_at IS NULL AND ($1::text IS NULL OR d.doc_type = $1) AND ($2::text IS NULL OR d.status = $2)
        AND ($3::uuid IS NULL OR d.customer_id = $3)
      ORDER BY d.created_at DESC LIMIT $4`,
    [doc_type ?? null, status ?? null, customerId, Math.min(Number(limit) || 20, 100)],
  );
  return {
    documents: rows.map((r) => ({ ...r, issue_date: isoDate(r.issue_date), total: num(r.total), amount_paid: num(r.amount_paid) })),
  };
}

// ---------------------------------------------------------------- prepare (the "think before you act" step)

/**
 * Resolves what the user said into records and lists every question that must be
 * answered before the document could be issued. Writes nothing.
 */
export async function prepareDocument(tx, { doc_type, customer, items = [], valid_until, due_date, from_submission } = {}) {
  if (!DOC_TYPES.includes(doc_type)) throw new DiError(`doc_type must be one of ${DOC_TYPES.join(", ")}`);
  const today = todayMY();
  const questions = [];
  const resolved = {};
  if (from_submission) {
    // An order-form answer fills in whatever the user didn't say; the user's words win.
    const order = await submissionOrder(tx, from_submission);
    resolved.from_submission = { id: order.submission.id, form: order.submission.slug, status: order.submission.status, reference: order.reference };
    if (order.submission.status === "processed" || order.submission.status === "spam") {
      questions.push({ about: "from_submission", message: `That submission is already ${order.submission.status}; it should not become a second document.` });
    }
    customer ||= order.customer || undefined;
    if (!items.length) items = order.items;
    if (!items.length) questions.push({ about: "items", message: "The submission orders nothing that maps to catalogue items (no line.<SKU>.quantity answers). What should the document contain?" });
  }
  let customerRow = null;

  if (customer) {
    if (isUuid(customer) || /^C-\d+$/i.test(customer)) {
      customerRow = await resolveCustomerRef(tx, customer);
    } else {
      const match = await matchCustomer(tx, { company_name: customer });
      const top = match.candidates[0];
      const second = match.candidates[1];
      if (top && top.score >= 55 && (!second || top.score - second.score >= 20)) {
        customerRow = await resolveCustomerRef(tx, top.customer_id);
      } else if (match.candidates.length) {
        questions.push({
          about: "customer",
          message: `Which customer is "${customer}"?`,
          options: match.candidates.map((c) => `${c.code} ${c.name}`),
        });
      } else {
        questions.push({
          about: "customer",
          message: `"${customer}" is not a customer yet. Record them first (the Records Clerk agent does this; a name card works).`,
        });
      }
    }
  }
  if (customerRow) {
    resolved.customer = { id: customerRow.id, code: customerRow.code, name: customerRow.name };
    const contacts = (
      await tx.query("SELECT id, name, email FROM di.contact WHERE customer_id = $1 AND deleted_at IS NULL ORDER BY is_primary DESC", [
        customerRow.id,
      ])
    ).rows;
    if (contacts.length > 1) {
      questions.push({ about: "contact", message: "Which contact should this be addressed to?", options: contacts.map((c) => c.name) });
    }
    resolved.contacts = contacts;
  }

  const lines = [];
  resolved.items = [];
  for (const [i, item] of items.entries()) {
    const qty = Number(item.quantity ?? 1);
    if (item.product || item.package) {
      const line = await buildLine(tx, item, i);
      lines.push(line);
      resolved.items.push({ ...pickLine(line), matched: item.product || item.package });
      continue;
    }
    const q = item.query || item.description;
    const found = await findCatalog(tx, { query: q, limit: 5 });
    const hits = [
      ...found.packages.map((p) => ({ ref: { package: p.code }, label: `package ${p.code} ${p.name} @ ${p.price}` })),
      ...found.products.map((p) => ({ ref: { product: p.sku }, label: `product ${p.sku} ${p.name} @ ${p.unit_price}` })),
    ];
    if (hits.length === 1) {
      const line = await buildLine(tx, { ...item, ...hits[0].ref, quantity: qty }, i);
      lines.push(line);
      resolved.items.push({ ...pickLine(line), matched: hits[0].label });
    } else if (hits.length > 1) {
      questions.push({ about: `items[${i}]`, message: `"${q}" matches several catalogue items. Which one?`, options: hits.map((h) => h.label) });
    } else if (item.unit_price !== undefined) {
      const line = await buildLine(tx, { ...item, description: q }, i);
      lines.push(line);
      resolved.items.push({ ...pickLine(line), matched: "custom line (not in catalogue)" });
    } else {
      questions.push({
        about: `items[${i}]`,
        message: `"${q}" is not in the catalogue. Give a price for a one-off line, or add it as a product first.`,
      });
    }
  }

  const suggestions = {
    issue_date: today,
    ...(doc_type === "quotation" ? { valid_until: valid_until || addDays(today, 30) } : {}),
    ...(doc_type === "invoice"
      ? { due_date: due_date || addDays(today, customerRow?.payment_terms_days ?? 30) }
      : {}),
  };
  const tenant = (await tx.query("SELECT * FROM di.company_profile WHERE tenant_id = di.current_tenant()")).rows[0];
  const template = await pickTemplate(tx, doc_type, null);
  const readiness = evaluate(await rulesFor(tx, doc_type), {
    doc: { doc_type, valid_until, due_date, custom: {} },
    lines,
    customer: customerRow,
    contact: null,
    tenant,
    template,
  });
  const alreadyAsked = new Set(questions.map((q) => q.about));
  for (const b of readiness.blockers) {
    if (b.check === "customer_selected" && alreadyAsked.has("customer")) continue;
    if (b.check === "has_lines" && [...alreadyAsked].some((a) => a.startsWith("items"))) continue;
    if (b.check === "date_set") {
      questions.push({ about: b.field, message: b.message, suggested: suggestions[b.field] });
      continue;
    }
    questions.push({ about: b.check, message: b.message });
  }
  const estimate = lines.reduce(
    (acc, l) => ({ subtotal: round2(acc.subtotal + l.subtotal), tax: round2(acc.tax + l.tax_amount) }),
    { subtotal: 0, tax: 0 },
  );
  return {
    doc_type,
    ready_to_create: Boolean(customerRow) && lines.length > 0 && !questions.some((q) => q.options),
    ready_to_issue: questions.length === 0,
    resolved,
    questions,
    warnings: readiness.warnings,
    suggestions,
    estimate: { ...estimate, total: round2(estimate.subtotal + estimate.tax) },
  };
}

const pickLine = (l) => ({
  description: l.description,
  quantity: l.quantity,
  unit_price: l.unit_price,
  tax_code: l.tax_code,
  subtotal: l.subtotal,
});

// ---------------------------------------------------------------- drafts

const HEADER_FIELDS = ["issue_date", "valid_until", "due_date", "reference", "notes", "terms", "template_id", "currency"];

export async function createDraft(tx, args = {}) {
  const { doc_type, customer, contact_id, lines = [], custom, from_submission, ...header } = args;
  if (!DOC_TYPES.includes(doc_type)) throw new DiError(`doc_type must be one of ${DOC_TYPES.join(", ")}`);
  if (from_submission) {
    const order = await submissionOrder(tx, from_submission);
    assertSubmissionOpen(order.submission);
    header.reference ??= order.reference;
    const out = await createDraft(tx, { ...args, from_submission: undefined, reference: header.reference });
    await markSubmissionProcessed(tx, order.submission.id, { customerId: out.document.customer?.id, documentId: out.document.id });
    return { ...out, from_submission: { id: order.submission.id, form: order.submission.slug, status: "processed" } };
  }
  const customerRow = customer ? await resolveCustomerRef(tx, customer) : null;
  let contactId = contact_id ?? null;
  if (contactId) {
    const c = await requireRow(tx, "contact", contactId, "Contact");
    if (c.customer_id !== customerRow?.id) throw new DiError("That contact belongs to a different customer");
  } else if (customerRow) {
    contactId =
      (await tx.query("SELECT id FROM di.contact WHERE customer_id = $1 AND deleted_at IS NULL ORDER BY is_primary DESC LIMIT 1", [
        customerRow.id,
      ])).rows[0]?.id ?? null;
  }
  const issueDate = header.issue_date || todayMY();
  const tenant = (await tx.query("SELECT currency, payment_terms_days, payment_instructions FROM di.company_profile WHERE tenant_id = di.current_tenant()")).rows[0];
  const paymentTerms = customerRow?.payment_terms_days ?? tenant?.payment_terms_days;
  const dueDate = header.due_date || (doc_type === "invoice" && paymentTerms != null ? addDays(issueDate, paymentTerms) : null);
  const { rows } = await tx.query(
    `INSERT INTO di.document (doc_type, customer_id, contact_id, issue_date, valid_until, due_date, currency, reference, notes, terms, template_id, custom)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [
      doc_type, customerRow?.id ?? null, contactId, issueDate, header.valid_until ?? null, dueDate,
      header.currency || tenant?.currency || "MYR", header.reference ?? null, header.notes ?? null, header.terms ?? tenant?.payment_instructions ?? null,
      header.template_id ?? null, JSON.stringify(custom ? await validateCustom(tx, "document", custom) : {}),
    ],
  );
  const doc = rows[0];
  for (const [i, input] of lines.entries()) await insertLine(tx, doc.id, await buildLine(tx, input, i));
  await recalc(tx, doc.id);
  return getDocument(tx, { ref: doc.id });
}

async function requireDraft(tx, ref) {
  const doc = await resolveDocument(tx, ref);
  if (doc.status !== "draft") {
    throw new DiError(
      `${doc.number || doc.id} is ${doc.status}, not a draft. Issued documents are frozen: void it and create a new one${doc.doc_type === "quotation" ? " (or issue a revised quotation)" : ""}.`,
    );
  }
  return doc;
}

export async function updateDraft(tx, { document, set = {}, add_lines = [], update_lines = [], remove_line_ids = [] } = {}) {
  const doc = await requireDraft(tx, document);
  const patch = {};
  if (set.customer !== undefined) {
    const c = set.customer ? await resolveCustomerRef(tx, set.customer) : null;
    patch.customer_id = c?.id ?? null;
    patch.contact_id =
      c &&
      ((await tx.query("SELECT id FROM di.contact WHERE customer_id = $1 AND deleted_at IS NULL ORDER BY is_primary DESC LIMIT 1", [c.id]))
        .rows[0]?.id ?? null);
  }
  if (set.contact_id !== undefined) patch.contact_id = set.contact_id;
  for (const k of HEADER_FIELDS) if (set[k] !== undefined) patch[k] = set[k];
  if (set.custom) patch.custom = JSON.stringify({ ...doc.custom, ...(await validateCustom(tx, "document", set.custom)) });
  const cols = Object.keys(patch);
  if (cols.length) {
    await tx.query(`UPDATE di.document SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")} WHERE id = $${cols.length + 1}`, [
      ...cols.map((c) => patch[c]),
      doc.id,
    ]);
  }
  for (const id of remove_line_ids) {
    await tx.query("UPDATE di.document_line SET deleted_at = now() WHERE id = $1 AND document_id = $2", [id, doc.id]);
  }
  for (const change of update_lines) {
    const old = (await tx.query("SELECT * FROM di.document_line WHERE id = $1 AND document_id = $2 AND deleted_at IS NULL", [change.line_id, doc.id]))
      .rows[0];
    if (!old) throw new DiError(`Line ${change.line_id} is not on this document`);
    const base = old.product_id
      ? { product: old.product_id }
      : old.package_id
        ? { package: old.package_id }
        : { description: old.description, unit_price: Number(old.unit_price) };
    const line = await buildLine(
      tx,
      {
        ...base,
        description: change.description ?? old.description,
        unit: change.unit ?? old.unit,
        quantity: change.quantity ?? Number(old.quantity),
        unit_price: change.unit_price ?? Number(old.unit_price),
        discount_amount: change.discount_amount ?? Number(old.discount_amount),
        tax_code: change.tax_code ?? old.tax_code,
      },
      old.sort,
    );
    await tx.query("UPDATE di.document_line SET deleted_at = now() WHERE id = $1", [old.id]);
    await insertLine(tx, doc.id, line);
  }
  const maxSort = (await tx.query("SELECT coalesce(max(sort), -1) AS s FROM di.document_line WHERE document_id = $1", [doc.id])).rows[0].s;
  for (const [i, input] of add_lines.entries()) await insertLine(tx, doc.id, await buildLine(tx, input, Number(maxSort) + 1 + i));
  await recalc(tx, doc.id);
  return getDocument(tx, { ref: doc.id });
}

export async function cancelDraft(tx, { document }) {
  const doc = await requireDraft(tx, document);
  await tx.query("UPDATE di.document SET status = 'cancelled', deleted_at = now() WHERE id = $1", [doc.id]);
  return { cancelled: doc.id };
}

// ---------------------------------------------------------------- issuing

export async function issueDocument(tx, { document }) {
  const doc = await requireDraft(tx, document);
  const ctx = await loadContext(tx, doc);
  const readiness = evaluate(await rulesFor(tx, doc.doc_type), ctx);
  if (!readiness.ready) {
    throw new DiError(
      `Not ready to issue. Still needed:\n${readiness.blockers.map((b) => `- ${b.message}`).join("\n")}`,
      readiness,
    );
  }
  const issueDate = isoDate(doc.issue_date) || todayMY();
  const number = await nextNumber(tx, doc.doc_type, issueDate);
  await tx.query(
    `UPDATE di.document SET number = $1, status = 'issued', issued_at = now(), issue_date = $2,
        customer_snapshot = $3, issuer_snapshot = $4, template_id = $5 WHERE id = $6`,
    [
      number,
      issueDate,
      JSON.stringify(snapshotCustomer(ctx.customer, ctx.contact)),
      JSON.stringify(snapshotIssuer(ctx.tenant)),
      ctx.template.id,
      doc.id,
    ],
  );
  const out = await getDocument(tx, { ref: doc.id });
  return { ...out, warnings: readiness.warnings };
}

export async function setQuotationStatus(tx, { document, status }) {
  if (!["accepted", "rejected", "expired"].includes(status)) throw new DiError("status must be accepted, rejected or expired");
  const doc = await resolveDocument(tx, document);
  if (doc.doc_type !== "quotation") throw new DiError("Only quotations can be accepted/rejected");
  if (!["issued", "accepted"].includes(doc.status)) throw new DiError(`${doc.number || "This quotation"} is ${doc.status}`);
  await tx.query("UPDATE di.document SET status = $1 WHERE id = $2", [status, doc.id]);
  return getDocument(tx, { ref: doc.id });
}

export async function convertToInvoice(tx, { quotation, due_date }) {
  const quote = await resolveDocument(tx, quotation);
  if (quote.doc_type !== "quotation") throw new DiError("Only a quotation can be converted");
  if (quote.status === "converted") {
    const inv = (await tx.query("SELECT number, id FROM di.document WHERE source_document_id = $1 AND deleted_at IS NULL", [quote.id])).rows[0];
    throw new DiError(`${quote.number} was already converted${inv ? ` into ${inv.number || `draft ${inv.id}`}` : ""}`);
  }
  if (!["issued", "accepted"].includes(quote.status)) {
    throw new DiError(`Issue the quotation first (it is ${quote.status}); only issued or accepted quotations convert`);
  }
  if (quote.valid_until && isoDate(quote.valid_until) < todayMY() && quote.status !== "accepted") {
    throw new DiError(`${quote.number} expired on ${isoDate(quote.valid_until)}. Mark it accepted first if the customer confirmed anyway.`);
  }
  const customer = quote.customer_id ? (await tx.query("SELECT payment_terms_days FROM di.customer WHERE id = $1", [quote.customer_id])).rows[0] : null;
  const company = (await tx.query("SELECT payment_terms_days, payment_instructions FROM di.company_profile WHERE tenant_id=di.current_tenant()")).rows[0];
  const paymentTerms = customer?.payment_terms_days ?? company?.payment_terms_days;
  const today = todayMY();
  const { rows } = await tx.query(
    `INSERT INTO di.document (doc_type, customer_id, contact_id, issue_date, due_date, currency, reference, notes, terms, source_document_id)
     VALUES ('invoice', $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      quote.customer_id, quote.contact_id, today,
      due_date || (paymentTerms != null ? addDays(today, paymentTerms) : null),
      quote.currency, quote.reference || quote.number, quote.notes, company?.payment_instructions ?? null, quote.id,
    ],
  );
  const invoiceId = rows[0].id;
  const lines = (await tx.query("SELECT * FROM di.document_line WHERE document_id = $1 AND deleted_at IS NULL ORDER BY sort", [quote.id])).rows;
  for (const l of lines) {
    await insertLine(tx, invoiceId, {
      ...l,
      quantity: Number(l.quantity),
      unit_price: Number(l.unit_price),
      discount_amount: Number(l.discount_amount),
      tax_rate: Number(l.tax_rate),
      subtotal: Number(l.subtotal),
      tax_amount: Number(l.tax_amount),
      total: Number(l.total),
    });
  }
  await recalc(tx, invoiceId);
  await tx.query("UPDATE di.document SET status = 'converted' WHERE id = $1", [quote.id]);
  const out = await getDocument(tx, { ref: invoiceId });
  // Report the quotation's final status so callers don't repeat the earlier "accepted".
  return { ...out, source_quotation: { id: quote.id, number: quote.number, status: "converted" } };
}

export async function voidDocument(tx, { document, reason }) {
  if (!reason) throw new DiError("A void needs a reason");
  const doc = await resolveDocument(tx, document);
  if (doc.status === "draft") throw new DiError("Drafts are cancelled, not voided (use cancel_draft)");
  if (["void", "cancelled"].includes(doc.status)) throw new DiError(`${doc.number} is already ${doc.status}`);
  if (Number(doc.amount_paid) > 0) {
    throw new DiError(
      `${doc.number} has payments recorded (${round2(doc.amount_paid)} paid) and cannot be voided; it and its payments are unchanged. ` +
        "No tool can reverse, refund or unallocate a recorded payment, or link a credit note to this invoice to offset it.",
    );
  }
  await tx.query("UPDATE di.document SET status = 'void', voided_at = now(), void_reason = $1 WHERE id = $2", [reason, doc.id]);
  return { voided: doc.number, reason };
}

// ---------------------------------------------------------------- payments

export async function recordPayment(tx, { customer, amount, received_on, method = "bank_transfer", reference, notes, allocations = [] } = {}) {
  const total = round2(amount);
  if (!(total > 0)) throw new DiError("amount must be above zero");
  const allocated = round2(allocations.reduce((s, a) => s + Number(a.amount), 0));
  if (allocated > total) throw new DiError(`Allocations (${allocated}) exceed the payment (${total})`);
  const invoices = [];
  for (const a of allocations) {
    const inv = await resolveDocument(tx, a.invoice);
    if (inv.doc_type !== "invoice") throw new DiError(`${inv.number} is not an invoice`);
    if (!["issued", "partially_paid"].includes(inv.status)) throw new DiError(`${inv.number || "That invoice"} is ${inv.status}; it cannot take payments`);
    const balance = round2(Number(inv.total) - Number(inv.amount_paid));
    if (round2(a.amount) > balance) throw new DiError(`${inv.number} only has ${balance} outstanding`);
    invoices.push({ inv, amount: round2(a.amount) });
  }
  let customerId = customer ? (await resolveCustomerRef(tx, customer)).id : invoices[0]?.inv.customer_id;
  if (!customerId) throw new DiError("Say which customer paid, or allocate the payment to an invoice");
  if (invoices.some((i) => i.inv.customer_id !== customerId)) throw new DiError("All allocated invoices must belong to the paying customer");
  const number = await nextNumber(tx, "receipt");
  const pay = (
    await tx.query(
      `INSERT INTO di.payment (number, customer_id, received_on, amount, method, reference, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [number, customerId, received_on || todayMY(), total, method, reference ?? null, notes ?? null],
    )
  ).rows[0];
  const results = [];
  for (const { inv, amount: a } of invoices) {
    await tx.query("INSERT INTO di.payment_allocation (payment_id, document_id, amount) VALUES ($1, $2, $3)", [pay.id, inv.id, a]);
    const paid = round2(Number(inv.amount_paid) + a);
    const status = paid >= Number(inv.total) ? "paid" : "partially_paid";
    await tx.query("UPDATE di.document SET amount_paid = $1, status = $2 WHERE id = $3", [paid, status, inv.id]);
    results.push({ invoice: inv.number, allocated: a, status, balance: round2(Number(inv.total) - paid) });
  }
  return { payment: { number, amount: total, received_on: isoDate(pay.received_on), method }, allocations: results, unallocated: round2(total - allocated) };
}

// ---------------------------------------------------------------- rendering

/** HTML for a document with its template (drafts render with a DRAFT banner). */
export async function renderDocumentHtml(tx, { document, template_id }) {
  const doc = await resolveDocument(tx, document);
  const ctx = await loadContext(tx, doc);
  const template = template_id ? await pickTemplate(tx, doc.doc_type, template_id) : ctx.template;
  if (!template) throw new DiError(`No ${doc.doc_type} template exists; the Template Designer agent creates one`);
  const html = renderTemplate(template.html, buildContext(ctx));
  return { html, doc: { id: doc.id, number: doc.number, status: doc.status, doc_type: doc.doc_type } };
}

export async function setPdfPath(tx, id, pdfPath) {
  await tx.query("UPDATE di.document SET pdf_path = $1 WHERE id = $2", [pdfPath, id]);
}
