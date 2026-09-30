import { DiError, setClause } from './common.mjs';

const present = value => typeof value === 'string' ? Boolean(value.trim()) : value != null;
const hasAddress = value => typeof value === 'string' ? present(value) : Boolean(value?.line1?.trim());

export function profileReadiness(company, fields) {
  const confirmed = key => company.evidence?.[key]?.confirmed !== false;
  const missing = fields.filter(f => f.required_for === 'minimum' && (!present(company[f.key]) || !confirmed(f.key)))
    .map(f => ({ key: f.key, label: f.label, help: f.help }));
  if (!(present(company.email) && confirmed('email')) && !(present(company.phone) && confirmed('phone'))) missing.push({ key: 'contact', label: 'Business email or phone' });
  const invoiceMissing = [...missing];
  if (!hasAddress(company.address) || !confirmed('address')) invoiceMissing.push({ key: 'address', label: 'Billing address' });
  if (!present(company.tax_status) || company.tax_status === 'needs_review' || !confirmed('tax_status')) invoiceMissing.push({ key: 'tax_status', label: 'Confirmed tax status' });
  return {
    minimum_ready: missing.length === 0, missing,
    invoice_profile_ready: invoiceMissing.length === 0, invoice_missing: invoiceMissing,
    note: 'Profile readiness only. Document, tax, numbering and template checks still apply before issuing.',
  };
}

export async function getCompanyProfile(tx) {
  const company = (await tx.query('SELECT * FROM di.company_profile WHERE tenant_id=di.current_tenant()')).rows[0];
  if (!company) throw new DiError('Company profile is unavailable. Finish database migration first.');
  const fields = (await tx.query('SELECT * FROM di.company_profile_field_def ORDER BY sort,key')).rows;
  const progress = (await tx.query('SELECT checks FROM di.onboarding_progress WHERE tenant_id=di.current_tenant()')).rows[0]?.checks || {};
  return { company, fields, readiness: profileReadiness(company, fields), progress, form_url: '/company-profile/', onboarding_agent: 'di-onboarding' };
}

export async function updateCompanyProfile(tx, args = {}) {
  const { expected_revision, source = 'user', source_ref, ...values } = args;
  if (!['user','website','invoice'].includes(source)) throw new DiError('Invalid source');
  // Serialize edits, including AI/manual edits to different fields, to preserve evidence.
  await tx.query('SELECT id FROM di.company_profile WHERE tenant_id=di.current_tenant() FOR UPDATE');
  const current = await getCompanyProfile(tx);
  if (expected_revision != null && expected_revision !== current.company.revision) throw new DiError('Company profile changed. Reload it before saving.', { code: 'conflict' });
  const defs = new Map(current.fields.map(f => [f.key, f]));
  const patch = {};
  const evidence = { ...current.company.evidence };
  for (const [key, raw] of Object.entries(values)) {
    if (raw === undefined) continue;
    const def = defs.get(key);
    if (!def) throw new DiError(`Unknown company profile field: ${key}`);
    let value = raw;
    if (value == null) value = key === 'address' ? {} : '';
    if (def.type === 'number') {
      value = value === '' ? null : value;
      if (value !== null && (!Number.isInteger(value) || value < 0 || value > 3650)) throw new DiError(`${def.label} must be an integer between 0 and 3650`);
    } else if (def.type === 'address') {
      if (typeof value !== 'string' && (!value || typeof value !== 'object' || Array.isArray(value))) throw new DiError('Address must be text or an address object');
      if (typeof value === 'object' && Object.values(value).some(v => typeof v !== 'string')) throw new DiError('Address values must be text');
      if (JSON.stringify(value).length > 10000) throw new DiError('Address is too long');
    } else {
      if (typeof value !== 'string') throw new DiError(`${def.label} must be text`);
      value = value.trim();
      if (value.length > 10000) throw new DiError(`${def.label} is too long`);
      if (def.type === 'country' || def.type === 'currency') value = value.toUpperCase();
      if (value && def.type === 'country' && !/^[A-Z]{2}$/.test(value)) throw new DiError('Country must be a two-letter code');
      if (value && def.type === 'currency' && !/^[A-Z]{3}$/.test(value)) throw new DiError('Currency must be a three-letter code');
      if (value && def.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new DiError('Invalid business email');
      if (value && def.type === 'select' && !def.options.includes(value)) throw new DiError(`${def.label}: choose ${def.options.join(', ')}`);
      if (value && def.type === 'url') {
        try { if (!['https:','http:'].includes(new URL(value).protocol)) throw new Error(); }
        catch { throw new DiError(`${def.label} must be an http(s) URL`); }
      }
      if (value && def.type === 'timezone') {
        try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { throw new DiError('Invalid timezone'); }
      }
    }
    if (source !== 'user' && evidence[key]?.confirmed && JSON.stringify(value) !== JSON.stringify(current.company[key])) {
      throw new DiError(`${def.label} was confirmed by the user. Ask the user before replacing it.`);
    }
    patch[key] = value;
    evidence[key] = { source, source_ref: typeof source_ref === 'string' ? source_ref.slice(0,2000) : null, confirmed: source === 'user', at: new Date().toISOString() };
  }
  if (!Object.keys(patch).length) throw new DiError('No company profile fields supplied');
  patch.evidence = evidence;
  patch.revision = current.company.revision + 1;
  if (typeof patch.address === 'string') patch.address = JSON.stringify(patch.address);
  const { sql, values: params } = setClause(patch, [...defs.keys(),'evidence','revision']);
  await tx.query(`UPDATE di.company_profile SET ${sql} WHERE tenant_id=di.current_tenant()`, params);
  return getCompanyProfile(tx);
}

export async function updateOnboardingProgress(tx, { check, done }) {
  const keys = ['website_reviewed','invoice_reviewed','template_preview_checked','numbering_checked','tax_codes_checked'];
  if (!keys.includes(check) || typeof done !== 'boolean') throw new DiError('Invalid onboarding check');
  await tx.query(`INSERT INTO di.onboarding_progress (checks) VALUES ($1)
    ON CONFLICT (tenant_id) DO UPDATE SET checks=di.onboarding_progress.checks || EXCLUDED.checks`, [JSON.stringify({ [check]: done })]);
  return getCompanyProfile(tx);
}
